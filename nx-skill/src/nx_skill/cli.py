"""Command line interface.

The MCP server is the main integration point, but a CLI matters for two
reasons: a human can debug the same operations the agent performs, and an agent
without MCP support can still drive NX through shell calls. Every command prints
the same envelope the MCP tools return, so output is interchangeable.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from . import images as images
from .config import Settings
from .contracts import SkillError, dumps, fail, ok
from .discovery import find_all
from .journal import JournalRunner
from .livebridge import LIVE_COMMANDS, LiveBridge
from .localdocs import ApiDocs
from .modeling import plan_template, route_intent, visual_spec
from .server import serve


def configure_logging(level: str) -> None:
    """Send logs to stderr so stdout stays a clean JSON channel."""
    logging.basicConfig(
        level=getattr(logging, str(level).upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _emit(payload: dict[str, Any], *, as_json: bool = True, exit_code: int | None = None) -> int:
    """Print one envelope and choose an exit code.

    `exit_code` is separate from `payload["ok"]` because they answer different
    questions: "did the tool run" versus "is the environment healthy". `doctor`
    is a diagnostic -- it produced a report, so it exits 0 even when it is
    reporting problems.
    """
    if as_json:
        print(dumps(payload))
    else:
        result = payload.get("result", payload)
        print(result if isinstance(result, str) else dumps(result))
    if exit_code is not None:
        return exit_code
    return 0 if payload.get("ok") else 1


def _settings(args: argparse.Namespace) -> Settings:
    settings = Settings.from_env()
    overrides: dict[str, Any] = {}
    if getattr(args, "nx_root", None):
        overrides["nx_root"] = args.nx_root
    if getattr(args, "workspace", None):
        overrides["workspace"] = args.workspace
    if getattr(args, "port", None):
        overrides["live_port"] = args.port
    return settings.with_overrides(**overrides) if overrides else settings


# -- commands ---------------------------------------------------------------


def cmd_doctor(args: argparse.Namespace) -> int:
    """Full environment report; never raises, so it works on a bare machine."""
    from .process import nx_gui_processes, list_processes

    settings = _settings(args)
    report: dict[str, Any] = {
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "settings": {
            "nxRoot": str(settings.nx_root) if settings.nx_root else None,
            "workspace": str(settings.workspace),
            "livePort": settings.live_port,
            "autoLaunch": settings.auto_launch,
            "requireOnline": settings.require_online,
            "skipGlobalSearch": settings.skip_global_search,
        },
        "processCount": len(list_processes()),
        "nxGuiProcesses": [p.to_dict() for p in nx_gui_processes()],
        "installations": [],
        "problems": [],
    }

    try:
        for install in find_all(settings):
            entry = install.to_dict()
            try:
                entry["docs"] = ApiDocs(install).stats()
            except SkillError as exc:
                entry["docs"] = {"error": exc.message}
            report["installations"].append(entry)
    except Exception as exc:  # noqa: BLE001 - doctor must always report
        report["problems"].append(f"Discovery failed: {exc}")

    if not report["installations"]:
        report["problems"].append(
            "No NX installation was found. Set NX_SKILL_NX_ROOT to the directory containing NXBIN."
        )

    client = settings.bridge_client()
    report["liveBridge"] = {
        "clientPath": str(client),
        "clientBuilt": client.is_file(),
        "serverDllPath": str(settings.bridge_server_dll()),
        "serverDllBuilt": settings.bridge_server_dll().is_file(),
    }
    if not client.is_file():
        report["problems"].append(
            "The live bridge client is not built; only batch journal commands are available. "
            "Run scripts/build_dotnet_bridge.ps1 to build it."
        )

    payload = ok(report)
    # The envelope reports health; the exit code reports that the diagnosis ran.
    payload["ok"] = not report["problems"]
    return _emit(payload, as_json=not args.text, exit_code=0)


def cmd_discover(args: argparse.Namespace) -> int:
    settings = _settings(args)
    # With an explicit root the caller is asking about one installation; without
    # it they are asking what this machine has.
    installs = [_require_install(settings, args)] if getattr(args, "nx_root", None) else find_all(settings)
    if not installs:
        raise SkillError(
            "No NX installation found.",
            code="NX_NOT_FOUND",
            suggestion="Set NX_SKILL_NX_ROOT to the directory containing NXBIN.",
        )
    return _emit(ok({"count": len(installs), "installations": [i.to_dict() for i in installs]}))


def cmd_docs(args: argparse.Namespace) -> int:
    settings = _settings(args)
    docs = ApiDocs(_require_install(settings, args))
    if args.docs_command == "search":
        members = docs.search(
            args.query,
            limit=args.limit,
            kinds=args.kinds,
            search_summary=args.summary,
        )
        payload: dict[str, Any] = {"query": args.query, "members": [m.to_dict(full=True) for m in members]}
        if args.stubs:
            payload["pythonStubs"] = docs.search_stubs(args.query, limit=args.limit)
        return _emit(ok(payload))
    if args.docs_command == "member":
        member = docs.member(args.name)
        if member is None:
            raise SkillError(f"No such member: {args.name}", code="NX_DOCS_NOT_FOUND")
        return _emit(ok(member.to_dict(full=True)))
    if args.docs_command == "type":
        members = docs.type_members(args.name, limit=args.limit)
        return _emit(ok({"type": args.name, "memberCount": len(members), "members": [m.to_dict() for m in members]}))
    if args.docs_command == "samples":
        return _emit(ok({"samples": docs.sample_applications(args.query or "", limit=args.limit)}))
    if args.docs_command == "stats":
        return _emit(ok(docs.stats()))
    raise SkillError(f"Unknown docs subcommand: {args.docs_command}", code="INVALID_ARGUMENT")


def cmd_route(args: argparse.Namespace) -> int:
    return _emit(ok(route_intent(args.prompt).to_dict()))


def cmd_plan(args: argparse.Namespace) -> int:
    return _emit(ok(plan_template(args.prompt, part_name=args.part_name)))


def cmd_visual(args: argparse.Namespace) -> int:
    return _emit(ok(visual_spec(args.prompt, projection_system=args.projection)))


def cmd_image(args: argparse.Namespace) -> int:
    """Image input from the shell — the same work the nx_image_* MCP tools do.

    Kept here so a human (or a host without MCP) can reproduce exactly what the
    agent did: `nx-skill image read drawing.png` prints the same envelope the
    tool returns.
    """
    workspace = images.workspace_for(_settings(args).workspace)
    command = args.image_command

    if command == "caps":
        return _emit(ok({**images.capabilities(), "workspace": str(workspace.root)}))

    if command == "read":
        known = None
        if args.known_value is not None:
            if args.known_pixels is None:
                raise SkillError(
                    "--known-value needs --known-pixels (the pixel span you measured).",
                    code="INVALID_ARGUMENT",
                )
            known = {"pixels": args.known_pixels, "value": args.known_value, "unit": args.known_unit}
        payload = images.describe_image(
            args.path,
            workspace=workspace,
            allow_external=True,
            allow_small=args.allow_small,
            min_side=args.min_side,
            known_dimension=known,
            hints=args.hint or (),
        )
        if args.inline:
            payload["dataUrl"] = images.data_url_for(payload["file"]["path"])
        return _emit(ok(payload))

    if command == "prepare":
        return _emit(
            ok(
                images.prepare_image(
                    args.path,
                    workspace=workspace,
                    max_side=args.max_side,
                    fmt=args.fmt,
                    quality=args.quality,
                    grayscale=args.grayscale,
                    autocontrast=not args.no_autocontrast,
                    allow_small=True,
                    inline=args.inline,
                )
            )
        )

    raise SkillError(f"Unknown image subcommand: {command}", code="INVALID_ARGUMENT")


def _require_install(settings: Settings, args: argparse.Namespace):
    from .discovery import discover

    return discover(requested=getattr(args, "nx_root", None), settings=settings)


def cmd_journal(args: argparse.Namespace) -> int:
    settings = _settings(args)
    runner = JournalRunner(_require_install(settings, args), settings)
    if args.journal_command == "run":
        result = runner.run(args.path, args.arg or [], timeout=args.timeout)
        return _emit(ok(result.to_dict()))
    if args.journal_command == "create-part":
        result = runner.create_part(args.path, timeout=args.timeout)
        return _emit(ok(result.to_dict()))
    if args.journal_command == "open-part":
        result = runner.open_part(args.path, timeout=args.timeout)
        return _emit(ok(result.to_dict()))
    raise SkillError(f"Unknown journal subcommand: {args.journal_command}", code="INVALID_ARGUMENT")


def cmd_live(args: argparse.Namespace) -> int:
    settings = _settings(args)
    bridge = LiveBridge(_require_install(settings, args), settings)

    if args.live_command == "ping":
        return _emit(ok({"online": bridge.ping(), "port": settings.live_port}))
    if args.live_command == "status":
        return _emit(ok(bridge.status()))
    if args.live_command == "modules":
        return _emit(ok(bridge.module_list()))
    if args.live_command == "block":
        response = bridge.create_block(args.length, args.width, args.height, feature_name=args.name)
        return _emit(ok(response.to_dict()))
    if args.live_command == "python":
        code = args.code if args.code is not None else sys.stdin.read()
        response = bridge.run_python_inline(code, stage_name=args.stage)
        return _emit(ok(response.to_dict()))
    if args.live_command == "call":
        if args.command not in LIVE_COMMANDS:
            raise SkillError(
                f"Unknown live command {args.command!r}.",
                code="INVALID_ARGUMENT",
                suggestion=f"Expected one of: {', '.join(sorted(LIVE_COMMANDS))}",
            )
        params = json.loads(args.params) if args.params else {}
        return _emit(ok(bridge.call(args.command, params).to_dict()))
    raise SkillError(f"Unknown live subcommand: {args.live_command}", code="INVALID_ARGUMENT")


def cmd_review(args: argparse.Namespace) -> int:
    """Human-paced review: hand a plan to the dialog inside NX.

    Deliberately does not require an NX installation: submitting and inspecting a
    plan is file work, and it should be possible to prepare a review on a machine
    where NX is not running.
    """
    from .review import ReviewStore

    store = ReviewStore(_settings(args))
    if args.review_command == "submit":
        raw = Path(args.plan).read_text(encoding="utf-8") if args.plan else sys.stdin.read()
        try:
            plan = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise SkillError(
                f"The plan is not valid JSON: {exc}",
                code="REVIEW_PLAN_INVALID",
                suggestion="Pass a JSON file, or pipe one on stdin.",
            ) from exc
        scripts: dict[str, str] = {}
        for item in args.script or []:
            source = Path(item)
            scripts[source.name] = source.read_text(encoding="utf-8")
        return _emit(ok(store.submit(plan, scripts=scripts)))
    if args.review_command == "status":
        return _emit(ok(store.status()))
    if args.review_command == "clear":
        return _emit(ok(store.reset()))
    raise SkillError(f"Unknown review subcommand: {args.review_command}", code="INVALID_ARGUMENT")


def cmd_loader(args: argparse.Namespace) -> int:
    """Install or inspect the NX custom-directory registration.

    Without this, an NX started from the Start Menu has no \"NX Skill\" menu and no
    review dialog: NX only looks at this package's runtime when
    \"UGII_CUSTOM_DIRECTORY_FILE\" points at the generated file.
    """
    from . import loader

    settings = _settings(args)
    if args.loader_command == "install":
        return _emit(ok(loader.install(settings)))
    if args.loader_command == "uninstall":
        return _emit(ok(loader.uninstall(settings)))
    return _emit(ok(loader.status(settings)))


def cmd_mcp(args: argparse.Namespace) -> int:
    settings = _settings(args)
    configure_logging(settings.log_level)
    from .server import Context

    return serve(Context(settings=settings))


# -- parser -----------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="nx-skill",
        description="Portable skill for driving Siemens NX through NXOpen.",
    )
    parser.add_argument("--version", action="version", version=f"nx-skill {__version__}")
    parser.add_argument("--nx-root", help="NX installation root (overrides NX_SKILL_NX_ROOT)")
    parser.add_argument("--workspace", help="workspace directory for parts and journals")
    parser.add_argument("--port", type=int, help="live bridge TCP port")
    sub = parser.add_subparsers(dest="command", required=True)

    doctor = sub.add_parser("doctor", help="report the environment and any problems")
    doctor.add_argument("--text", action="store_true", help="print plain text instead of JSON")
    doctor.set_defaults(func=cmd_doctor)

    sub.add_parser("discover", help="list every NX installation found").set_defaults(func=cmd_discover)

    docs = sub.add_parser("docs", help="search the API reference shipped with the installation")
    docs_sub = docs.add_subparsers(dest="docs_command", required=True)
    d_search = docs_sub.add_parser("search", help="search documented members")
    d_search.add_argument("query")
    d_search.add_argument("--limit", type=int, default=20)
    d_search.add_argument("--kinds", nargs="*", help="namespace type method property field event")
    d_search.add_argument("--summary", action="store_true", help="also match summary text")
    d_search.add_argument("--stubs", action="store_true", help="also search the Python stubs")
    d_search.set_defaults(func=cmd_docs)
    d_member = docs_sub.add_parser("member", help="fetch one qualified member")
    d_member.add_argument("name")
    d_member.add_argument("--limit", type=int, default=20)
    d_member.set_defaults(func=cmd_docs)
    d_type = docs_sub.add_parser("type", help="list the members of one type")
    d_type.add_argument("name")
    d_type.add_argument("--limit", type=int, default=200)
    d_type.set_defaults(func=cmd_docs)
    d_samples = docs_sub.add_parser("samples", help="list vendor sample applications")
    d_samples.add_argument("query", nargs="?", default="")
    d_samples.add_argument("--limit", type=int, default=40)
    d_samples.set_defaults(func=cmd_docs)
    d_stats = docs_sub.add_parser("stats", help="describe the bundled documentation")
    d_stats.add_argument("--limit", type=int, default=20)
    d_stats.set_defaults(func=cmd_docs)

    route = sub.add_parser("route", help="route a request to modelling or CAE")
    route.add_argument("prompt")
    route.set_defaults(func=cmd_route)

    plan = sub.add_parser("plan", help="print the modelling plan schema")
    plan.add_argument("prompt", nargs="?", default="")
    plan.add_argument("--part-name", default="NX_Model")
    plan.set_defaults(func=cmd_plan)

    visual = sub.add_parser("visual-spec", help="rules for three-view / image modelling")
    visual.add_argument("prompt", nargs="?", default="")
    visual.add_argument("--projection", default="infer")
    visual.set_defaults(func=cmd_visual)

    image = sub.add_parser("image", help="read, measure and normalise an image (drawing, photo, reference)")
    image_sub = image.add_subparsers(dest="image_command", required=True)
    image_sub.add_parser("caps", help="does this interpreter have Pillow/numpy?").set_defaults(func=cmd_image)
    i_read = image_sub.add_parser("read", help="file facts, measurements and an ASCII ink map")
    i_read.add_argument("path")
    i_read.add_argument("--min-side", type=int, default=images.DEFAULT_MIN_SIDE)
    i_read.add_argument("--allow-small", action="store_true")
    i_read.add_argument("--known-pixels", type=float, help="pixel span you measured on the image")
    i_read.add_argument("--known-value", type=float, help="its real length, in --known-unit")
    i_read.add_argument("--known-unit", default="mm")
    i_read.add_argument("--hint", action="append")
    i_read.add_argument("--inline", action="store_true", help="also emit a base64 data URL")
    i_read.set_defaults(func=cmd_image)
    i_prep = image_sub.add_parser("prepare", help="normalise a copy into the workspace")
    i_prep.add_argument("path")
    i_prep.add_argument("--max-side", type=int, default=images.DEFAULT_MAX_SIDE)
    i_prep.add_argument("--fmt", default="jpeg", choices=list(images.WRITABLE_FORMATS))
    i_prep.add_argument("--quality", type=int, default=88)
    i_prep.add_argument("--grayscale", action="store_true")
    i_prep.add_argument("--no-autocontrast", action="store_true")
    i_prep.add_argument("--inline", action="store_true", help="also emit a base64 data URL")
    i_prep.set_defaults(func=cmd_image)

    journal = sub.add_parser("journal", help="run NXOpen journals in a batch NX process")
    journal_sub = journal.add_subparsers(dest="journal_command", required=True)
    j_run = journal_sub.add_parser("run")
    j_run.add_argument("path")
    j_run.add_argument("--arg", action="append")
    j_run.add_argument("--timeout", type=int, default=3600)
    j_run.set_defaults(func=cmd_journal)
    j_create = journal_sub.add_parser("create-part")
    j_create.add_argument("path")
    j_create.add_argument("--timeout", type=int, default=3600)
    j_create.set_defaults(func=cmd_journal)
    j_open = journal_sub.add_parser("open-part")
    j_open.add_argument("path")
    j_open.add_argument("--timeout", type=int, default=3600)
    j_open.set_defaults(func=cmd_journal)

    live = sub.add_parser("live", help="drive the open NX session through the live bridge")
    live_sub = live.add_subparsers(dest="live_command", required=True)
    live_sub.add_parser("ping").set_defaults(func=cmd_live)
    live_sub.add_parser("status").set_defaults(func=cmd_live)
    live_sub.add_parser("modules").set_defaults(func=cmd_live)
    l_block = live_sub.add_parser("block")
    l_block.add_argument("--length", type=float, required=True)
    l_block.add_argument("--width", type=float, required=True)
    l_block.add_argument("--height", type=float, required=True)
    l_block.add_argument("--name")
    l_block.set_defaults(func=cmd_live)
    l_py = live_sub.add_parser("python")
    l_py.add_argument("--code", help="inline NXOpen code; reads stdin when omitted")
    l_py.add_argument("--stage")
    l_py.set_defaults(func=cmd_live)
    l_call = live_sub.add_parser("call")
    l_call.add_argument("command")
    l_call.add_argument("--params", help="JSON object of parameters")
    l_call.set_defaults(func=cmd_live)

    review = sub.add_parser(
        "review",
        help="human-paced review: the user runs each step inside NX",
    )
    review_sub = review.add_subparsers(dest="review_command", required=True)
    r_submit = review_sub.add_parser("submit", help="submit a plan for review in NX")
    r_submit.add_argument("plan", nargs="?", help="plan JSON file (stdin when omitted)")
    r_submit.add_argument(
        "--script",
        action="append",
        help="a journal step script to copy into review/scripts/ (repeatable)",
    )
    r_submit.set_defaults(func=cmd_review)
    review_sub.add_parser("status", help="show review progress").set_defaults(func=cmd_review)
    review_sub.add_parser("clear", help="remove the plan and run log").set_defaults(func=cmd_review)

    loader = sub.add_parser(
        "loader",
        help="register this package as an NX custom directory (enables the NX menu)",
    )
    loader_sub = loader.add_subparsers(dest="loader_command", required=True)
    loader_sub.add_parser("install", help="write the config and set the user environment").set_defaults(func=cmd_loader)
    loader_sub.add_parser("status", help="report whether NX will see the menu").set_defaults(func=cmd_loader)
    loader_sub.add_parser("uninstall", help="remove the user environment variable").set_defaults(func=cmd_loader)

    sub.add_parser("mcp", help="run the MCP stdio server").set_defaults(func=cmd_mcp)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except SkillError as exc:
        return _emit(fail(exc))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - one clean envelope for any failure
        return _emit(fail(exc))


if __name__ == "__main__":
    raise SystemExit(main())
