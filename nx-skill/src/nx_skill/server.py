"""MCP stdio server exposing the skill's tools.

Protocol notes: current MCP uses newline-delimited JSON over stdio while the
original plugin used LSP-style `Content-Length` framing. The reader accepts
both so the server works with either generation of client; the writer emits
newline-delimited JSON, which is what today's clients expect.

Every tool returns the envelope from :mod:`nx_skill.contracts`, and no tool
requires NX to be installed except the ones that genuinely touch NX -- status and
documentation tools work on a bare machine, which is what makes the package
diagnosable.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

from . import __version__
from . import images as image_input
from .config import Settings
from .contracts import (
    InvalidArgument,
    SkillError,
    Workspace,
    dumps,
    fail,
    ok,
)
from .discovery import NxInstall, discover
from .journal import JournalRunner
from .livebridge import LIVE_COMMANDS, LiveBridge
from .localdocs import ApiDocs
from .modeling import plan_template, route_intent, visual_spec
from .review import OPERATIONS as REVIEW_OPERATIONS

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "nx-skill"

WORKFLOW_URI = "nx-skill://guide/workflow"
WORKFLOW_TEXT = (
    "NX/Designcenter workflow: call nx_status first to discover the installed release and bridge. "
    "Use nx_live_status to inspect the open Work Part before changing it. "
    "Use nx_docs_search and nx_docs_member for release-specific NXOpen API names and signatures. "
    "Prepare an ordered plan with named steps. For operations needing human review, submit the plan "
    "through nx_review_submit and wait for the user to execute it in NX. "
    "After execution, call nx_live_verify with explicit expectations, or inspect the review run log. "
    "Do not claim a model change, save, or CAE solve succeeded from plan submission or script generation alone. "
    "If NX or the bridge is unavailable, report that limit and avoid inventing model state."
)


# ---------------------------------------------------------------------------
# Lazy context
# ---------------------------------------------------------------------------


@dataclass
class Context:
    """Holds the resolved environment, creating expensive parts on demand.

    Discovery and the workspace are lazy so that `initialize` and `tools/list`
    never fail on a machine without NX, and a `nx_status` call reports the
    problem instead of dying inside the server.
    """

    settings: Settings

    def __post_init__(self) -> None:
        self._install: NxInstall | None = None
        self._install_error: SkillError | None = None

    @property
    def workspace(self) -> Workspace:
        return Workspace(self.settings.workspace)

    def install(self) -> NxInstall:
        if self._install is None:
            if self._install_error is not None:
                raise self._install_error
            try:
                self._install = discover(settings=self.settings)
            except SkillError as exc:
                self._install_error = exc
                raise
        return self._install

    def docs(self) -> ApiDocs:
        return ApiDocs(self.install())

    def journal(self) -> JournalRunner:
        return JournalRunner(self.install(), self.settings)

    def bridge(self) -> LiveBridge:
        return LiveBridge(self.install(), self.settings)


# ---------------------------------------------------------------------------
# Tool registry
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    schema: dict[str, Any]
    handler: Callable[[Context, dict[str, Any]], dict[str, Any]]


def _object_schema(properties: dict[str, Any], required: Sequence[str] = ()) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(required),
        "additionalProperties": False,
    }


_STR = {"type": "string"}
_NUM = {"type": "number"}
_BOOL = {"type": "boolean"}
_INT = {"type": "integer"}


# -- handlers ---------------------------------------------------------------


def _h_status(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Report the whole environment without requiring anything to be present."""
    from .process import nx_gui_processes, nx_journal_processes

    report: dict[str, Any] = {
        "server": {"name": SERVER_NAME, "version": __version__},
        "settings": {
            "nxRoot": str(ctx.settings.nx_root) if ctx.settings.nx_root else None,
            "workspace": str(ctx.settings.workspace),
            "livePort": ctx.settings.live_port,
            "autoLaunch": ctx.settings.auto_launch,
        },
        "nx": None,
        "nxError": None,
        "processes": {
            "gui": [p.to_dict() for p in nx_gui_processes()],
            "journal": [p.to_dict() for p in nx_journal_processes()],
        },
        "liveBridge": {"clientBuilt": ctx.settings.bridge_client().is_file(), "online": False},
    }

    try:
        install = ctx.install()
    except SkillError as exc:
        report["nxError"] = exc.to_dict()
        return ok(report)

    report["nx"] = install.to_dict()
    report["docs"] = ctx.docs().stats()
    if report["liveBridge"]["clientBuilt"]:
        report["liveBridge"]["online"] = ctx.bridge().ping()
    return ok(report)


def _h_docs_search(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query") or "").strip()
    if not query:
        raise InvalidArgument("A non-empty query is required.", suggestion='Try query="ExtrudeBuilder".')
    docs = ctx.docs()
    members = docs.search(
        query,
        limit=int(args.get("limit") or 20),
        kinds=args.get("kinds"),
        assemblies=args.get("assemblies"),
        search_summary=bool(args.get("search_summary")),
    )
    results: dict[str, Any] = {
        "query": query,
        "release": ctx.install().release,
        "members": [m.to_dict(full=True) for m in members],
    }
    if args.get("include_stubs", True):
        results["pythonStubs"] = docs.search_stubs(query, limit=int(args.get("stub_limit") or 10))
    return ok(results)


def _h_docs_member(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        raise InvalidArgument("A qualified member name is required, e.g. NXOpen.Session.GetSession.")
    docs = ctx.docs()
    member = docs.member(name, assembly=args.get("assembly"))
    if member is None:
        raise SkillError(
            f"No documented member named {name!r} in this installation.",
            code="NX_DOCS_NOT_FOUND",
            suggestion="Use nx_docs_search to find the exact qualified name; NXOpen names are case-sensitive.",
            details={"release": ctx.install().release},
        )
    return ok(member.to_dict(full=True))


def _h_docs_type(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    name = str(args.get("type_name") or "").strip()
    if not name:
        raise InvalidArgument("A type name is required, e.g. NXOpen.Features.ExtrudeBuilder.")
    members = ctx.docs().type_members(name, limit=int(args.get("limit") or 200))
    if not members:
        raise SkillError(
            f"No documented type named {name!r} in this installation.",
            code="NX_DOCS_NOT_FOUND",
            suggestion="Use nx_docs_search with a shorter fragment, e.g. 'Extrude'.",
        )
    return ok({"type": name, "memberCount": len(members), "members": [m.to_dict() for m in members]})


def _h_docs_samples(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    return ok({"samples": ctx.docs().sample_applications(str(args.get("query") or ""), limit=int(args.get("limit") or 40))})


def _h_route_intent(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    return ok(route_intent(args.get("prompt")).to_dict())


def _h_modeling_plan(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    return ok(
        plan_template(
            args.get("prompt") or "",
            part_name=str(args.get("part_name") or "NX_Model"),
            units=str(args.get("units") or "Millimeters"),
        )
    )


def _h_visual_spec(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    return ok(
        visual_spec(
            args.get("prompt") or "",
            projection_system=str(args.get("projection_system") or "infer"),
            view_layout=str(args.get("view_layout") or ""),
            units=str(args.get("units") or "mm"),
        )
    )


# -- image input -------------------------------------------------------------
# A drawing is an *input*, not a model. These handlers read it, measure it and
# normalise a copy into the workspace; they never claim a physical size the
# picture does not carry, and they never write outside the workspace.


def _h_image_capabilities(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Answer "can you even process an image here?" before promising anything."""
    caps = image_input.capabilities()
    return ok(
        {
            "interpreter": caps,
            "workspace": str(ctx.workspace.root),
            "limits": {
                "maxBytes": image_input.DEFAULT_MAX_BYTES,
                "maxSide": image_input.DEFAULT_MAX_SIDE,
                "minSide": image_input.DEFAULT_MIN_SIDE,
                "formats": list(image_input.SUPPORTED_SUFFIXES),
                "writableFormats": list(image_input.WRITABLE_FORMATS),
            },
            "degrades": None
            if caps["pillowAvailable"]
            else "Pillow is missing in this interpreter: files can be read and copied but not converted, "
            "enhanced or resized.",
            "install": (
                "Host interpreter: pip install pillow numpy. "
                "OpenCV: pip install opencv-python-headless (only needed for deskew/line detection). "
                "NX's embedded python has no pip and no site-packages — do the image work in the host "
                "interpreter, not inside NX."
            ),
        }
    )


def _h_image_read(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Read a picture the user picked and describe what is actually in it."""
    path = str(args.get("path") or "").strip()
    if not path:
        raise InvalidArgument(
            "An image path is required.",
            suggestion="The NX dialog or the workbench sends one; a path relative to the workspace also works.",
        )
    data = image_input.describe_image(
        path,
        allow_external=bool(args.get("allow_external", True)),
        workspace=ctx.workspace,
        max_bytes=int(args.get("max_bytes") or image_input.DEFAULT_MAX_BYTES),
        min_side=int(args.get("min_side") or image_input.DEFAULT_MIN_SIDE),
        allow_small=bool(args.get("allow_small", False)),
        known_dimension=args.get("known_dimension"),
        hints=args.get("hints") or (),
    )
    if args.get("inline"):
        data["dataUrl"] = image_input.data_url_for(
            data["file"]["path"], max_bytes=int(args.get("max_bytes") or image_input.DEFAULT_MAX_BYTES)
        )
    return ok(data)


def _h_image_prepare(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Normalise a copy into the workspace so a model request can carry it."""
    path = str(args.get("path") or "").strip()
    payload = str(args.get("data_url") or "").strip()
    if not path and not payload:
        raise InvalidArgument("Pass either path or data_url.", suggestion="One image, one source.")

    if payload and not path:
        saved = image_input.save_payload(
            payload,
            workspace=ctx.workspace,
            name=str(args.get("name") or "pasted"),
            max_bytes=int(args.get("max_bytes") or image_input.DEFAULT_MAX_BYTES),
        )
        path = saved["path"]
        prepared = image_input.prepare_image(
            path,
            workspace=ctx.workspace,
            max_side=int(args.get("max_side") or image_input.DEFAULT_MAX_SIDE),
            fmt=str(args.get("fmt") or "jpeg"),
            quality=int(args.get("quality") or 88),
            grayscale=bool(args.get("grayscale")),
            autocontrast=bool(args.get("autocontrast", True)),
            allow_external=False,
            allow_small=True,
            inline=bool(args.get("inline")),
        )
        prepared["pastedFrom"] = {k: v for k, v in saved.items() if k != "probe"}
        return ok(prepared)

    return ok(
        image_input.prepare_image(
            path,
            workspace=ctx.workspace,
            max_side=int(args.get("max_side") or image_input.DEFAULT_MAX_SIDE),
            fmt=str(args.get("fmt") or "jpeg"),
            quality=int(args.get("quality") or 88),
            grayscale=bool(args.get("grayscale")),
            autocontrast=bool(args.get("autocontrast", True)),
            allow_external=bool(args.get("allow_external", True)),
            allow_small=bool(args.get("allow_small", True)),
            inline=bool(args.get("inline")),
        )
    )


def _h_prepare_session(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """One call that answers: where do I work, how do I route this, what are the rules."""
    prompt = args.get("prompt") or ""
    workspace = ctx.workspace
    intent = route_intent(prompt)
    plan = plan_template(prompt, part_name=str(args.get("part_name") or "NX_Model"))

    payload: dict[str, Any] = {
        "workspace": str(workspace.root),
        "intent": intent.to_dict(),
        "plan": plan,
        "liveBridge": {
            "available": ctx.settings.bridge_client().is_file(),
            "port": ctx.settings.live_port,
        },
    }
    try:
        install = ctx.install()
        payload["nx"] = install.to_dict()
        payload["liveBridge"]["online"] = ctx.bridge().ping() if payload["liveBridge"]["available"] else False
    except SkillError as exc:
        payload["nxError"] = exc.to_dict()
        payload["advice"] = "No NX installation was found, so only planning and documentation tools are available."
    return ok(payload)


def _h_run_journal(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("journal_path") or "").strip()
    if not raw:
        raise InvalidArgument("journal_path is required (relative to the workspace).")
    path = ctx.workspace.resolve(raw, must_exist=True)
    result = ctx.journal().run(path, args=args.get("args") or [], timeout=int(args.get("timeout") or 3600))
    return ok(result.to_dict())


def _h_create_part(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("part_path") or "").strip()
    if not raw:
        raise InvalidArgument("part_path is required (relative to the workspace).")
    target = ctx.workspace.resolve(raw)
    result = ctx.journal().create_part(target, timeout=int(args.get("timeout") or 3600))
    return ok({"partPath": str(target), **result.to_dict()})


def _h_open_part(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("part_path") or "").strip()
    if not raw:
        raise InvalidArgument("part_path is required (relative to the workspace).")
    target = ctx.workspace.resolve(raw, must_exist=True)
    result = ctx.journal().open_part(target, timeout=int(args.get("timeout") or 3600))
    return ok({"partPath": str(target), **result.to_dict()})


def _h_live_ping(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    return ok({"online": ctx.bridge().ping(), "port": ctx.settings.live_port})


def _h_live_status(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    bridge = ctx.bridge()
    if not bridge.ping():
        bridge.ensure_online()
    return ok(bridge.status())


def verify_model_status(status: Mapping[str, Any], args: Mapping[str, Any]) -> dict[str, Any]:
    """Compare explicit expectations with observed state; never infer success from a journal exit."""
    checks: list[dict[str, Any]] = []
    work_part = status.get("workPart") or {}
    model = status.get("model") or {}
    expected_path = args.get("part_path")
    if expected_path:
        actual = str(work_part.get("fullPath") or "")
        checks.append({"field": "partPath", "expected": expected_path, "actual": actual,
                       "passed": actual.casefold() == str(expected_path).casefold()})
    minimum = args.get("min_features")
    if minimum is not None:
        features = model.get("features") or {}
        actual = features.get("count") if features.get("available") else None
        checks.append({"field": "featureCount", "expectedMinimum": minimum, "actual": actual,
                       "passed": actual is not None and actual >= minimum})
    required = args.get("feature_names") or []
    if required:
        features = model.get("features") or {}
        names = features.get("names") or []
        for name in required:
            checks.append({"field": "featureName", "expected": name, "observed": names,
                           "passed": bool(features.get("available")) and name in names})
    return {"verified": bool(checks) and all(c["passed"] for c in checks), "checks": checks,
            "inspectionAvailable": bool(model.get("available")), "workPart": work_part}


def _h_live_verify(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    if not any(args.get(key) is not None for key in ("part_path", "min_features", "feature_names")):
        raise InvalidArgument("Provide at least one expected part path, minimum feature count or feature name.")
    minimum = args.get("min_features")
    if minimum is not None and (not isinstance(minimum, int) or minimum < 0):
        raise InvalidArgument("min_features must be a non-negative integer.")
    status = _h_live_status(ctx, {})["result"]
    return ok({**verify_model_status(status, args), "observed": status})


def _h_live_module_list(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Answered from the installation on disk, so it works with NX closed."""
    return ok(ctx.bridge().module_list())


def _h_live_create_modeling_part(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    raw = str(args.get("part_path") or "").strip()
    path = str(ctx.workspace.resolve(raw)) if raw else str(ctx.workspace.root / "model.prt")
    response = ctx.bridge().create_modeling_part(path, save=bool(args.get("save", True)))
    return ok(response.to_dict())


def _h_live_create_block(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    for key in ("length", "width", "height"):
        if args.get(key) is None:
            raise InvalidArgument(f"{key} is required for a block.")
    response = ctx.bridge().create_block(
        float(args["length"]),
        float(args["width"]),
        float(args["height"]),
        feature_name=args.get("feature_name"),
        save=bool(args.get("save", True)),
    )
    return ok(response.to_dict())


def _h_live_run_python_inline(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    code = str(args.get("code") or "")
    if not code.strip():
        raise InvalidArgument("code is required.")
    response = ctx.bridge().run_python_inline(code, stage_name=args.get("stage_name"))
    return ok(response.to_dict())


def _h_review_submit(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Hand a plan to the human-paced review dialog inside NX."""
    from .review import ReviewStore

    plan = args.get("plan")
    if not isinstance(plan, Mapping):
        raise InvalidArgument("plan must be an object with a 'steps' array.")
    scripts = args.get("scripts")
    if scripts is not None and not isinstance(scripts, Mapping):
        raise InvalidArgument("scripts must be an object mapping file names to source text.")
    return ok(ReviewStore(ctx.settings).submit(plan, scripts=scripts))


def _h_review_status(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Report how far the reviewer has got through the plan."""
    from .review import ReviewStore

    return ok(ReviewStore(ctx.settings).status())


def _h_review_clear(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    from .review import ReviewStore

    return ok(ReviewStore(ctx.settings).reset())


def _h_live_call(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Escape hatch for the remaining bridge verbs, still whitelisted.

    The verb is checked *here*, before the bridge is touched, so an unknown verb
    is reported as INVALID_ARGUMENT whether or not the .NET client happens to be
    built on this machine. Validating late (in :meth:`LiveBridge._invoke`, behind
    ``require_client()``) made a fresh clone fail
    ``test_live_call_rejects_an_unknown_verb`` with NX_BRIDGE_OFFLINE instead --
    a bad argument must not be reported as an environment problem.
    """
    command = str(args.get("command") or "").strip()
    if not command:
        raise InvalidArgument(f"command is required; one of {sorted(LIVE_COMMANDS)}")
    if command not in LIVE_COMMANDS:
        raise InvalidArgument(
            f"Unknown live command {command!r}.",
            suggestion=f"Expected one of: {', '.join(sorted(LIVE_COMMANDS))}",
        )
    params = args.get("params") or {}
    if not isinstance(params, Mapping):
        raise InvalidArgument("params must be an object.")
    response = ctx.bridge().call(command, params, timeout=int(args.get("timeout") or 3600))
    return ok(response.to_dict())


#: Keywords that must never be smuggled through an explicit operation step: the
#: whole point of the step runner is that each step is a reviewable verb.
_FORBIDDEN_STEP_KEYS = ("code", "python", "source", "script", "script_path")

#: Step operations mapped to real bridge verbs. Only verbs the compiled client
#: implements appear here.
_OPERATION_COMMANDS: dict[str, str] = {
    "create_modeling_part": "create-modeling-part",
    "create_block": "create-block",
    "status": "status",
    "prepare_session": "prepare-session",
    "ping": "ping",
    "run_python": "run-python",
}

#: Step operations handled locally rather than over the bridge.
_LOCAL_OPERATIONS: tuple[str, ...] = ("module_list", "run_python_inline")


def _h_live_run_steps(ctx: Context, args: dict[str, Any]) -> dict[str, Any]:
    """Run ordered, named steps, reporting per-step outcomes.

    Every step is validated up front. Starting an NX session is expensive and
    visible -- it opens a window on the user's desktop -- so a malformed request
    must be rejected *before* any side effect, not after NX has been launched.
    """
    steps = args.get("steps")
    if not isinstance(steps, list) or not steps:
        raise InvalidArgument("steps must be a non-empty array.")

    plan: list[dict[str, Any]] = []
    for index, raw in enumerate(steps, start=1):
        if not isinstance(raw, Mapping):
            raise InvalidArgument(f"Step {index} must be an object.")

        operation = str(raw.get("operation") or "").strip()
        command = _OPERATION_COMMANDS.get(operation)
        stage = str(raw.get("name") or f"{index:02d}").strip()
        if command is None and operation not in _LOCAL_OPERATIONS:
            raise InvalidArgument(
                f"Step {index} uses unknown operation {operation!r}.",
                suggestion=f"Known operations: {sorted(set(_OPERATION_COMMANDS) | set(_LOCAL_OPERATIONS))}",
            )

        params = dict(raw.get("params") or {})
        if operation != "run_python_inline":
            smuggled = [k for k in _FORBIDDEN_STEP_KEYS if k in params]
            if smuggled:
                raise InvalidArgument(
                    f"Step {index} passes {smuggled}, which explicit operations reject by design.",
                    suggestion="Use operation='run_python_inline' when you genuinely intend to run code.",
                )
        if operation == "run_python_inline" and not str(params.get("code") or "").strip():
            raise InvalidArgument(f"Step {index} uses run_python_inline without any code.")
        if operation == "create_modeling_part" and params.get("part_path"):
            params["part_path"] = str(ctx.workspace.resolve(str(params["part_path"])))

        plan.append({"index": index, "name": stage, "operation": operation, "command": command, "params": params})

    bridge = ctx.bridge()
    bridge.ensure_online()

    results: list[dict[str, Any]] = []
    for step in plan:
        index, stage = step["index"], step["name"]
        operation, command, params = step["operation"], step["command"], step["params"]
        try:
            if operation == "module_list":
                results.append({"step": index, "name": stage, "ok": True, "result": bridge.module_list()})
                continue
            if operation == "run_python_inline":
                response = bridge.run_python_inline(
                    str(params.get("code") or ""),
                    stage_name=params.get("stage_name") or stage,
                )
            else:
                response = bridge.call(str(command), params)
            results.append({"step": index, "name": stage, "ok": True, **response.to_dict()})
        except SkillError as exc:
            results.append({"step": index, "name": stage, "ok": False, "error": exc.to_dict()})
            if not args.get("continue_on_error"):
                return ok({"steps": results, "abortedAt": index}, execution_state=exc.execution_state)
    return ok({"steps": results})


TOOLS: tuple[Tool, ...] = (
    Tool(
        "nx_status",
        "Report the NX installation, workspace, running NX processes and live-bridge state. "
        "Works on a machine with no NX installed and explains what is missing.",
        _object_schema({}),
        _h_status,
    ),
    Tool(
        "nx_docs_search",
        "Search the NXOpen API reference that ships inside the installed NX release "
        "(NXBIN/managed/*.xml and the Python stubs). Works offline and is exact for this release.",
        _object_schema(
            {
                "query": _STR,
                "limit": _INT,
                "kinds": {"type": "array", "items": _STR},
                "assemblies": {"type": "array", "items": _STR},
                "search_summary": _BOOL,
                "include_stubs": _BOOL,
                "stub_limit": _INT,
            },
            ["query"],
        ),
        _h_docs_search,
    ),
    Tool(
        "nx_docs_member",
        "Fetch the full documentation for one qualified NXOpen member, "
        "including the release that introduced it (e.g. 'Created in NX2206.0.0').",
        _object_schema({"name": _STR, "assembly": _STR}, ["name"]),
        _h_docs_member,
    ),
    Tool(
        "nx_docs_type",
        "List every documented member of one NXOpen type.",
        _object_schema({"type_name": _STR, "limit": _INT}, ["type_name"]),
        _h_docs_type,
    ),
    Tool(
        "nx_docs_samples",
        "List the vendor NXOpen sample applications shipped with the installation.",
        _object_schema({"query": _STR, "limit": _INT}),
        _h_docs_samples,
    ),
    Tool(
        "nx_route_intent",
        "Route a request to the right NX sub-system (modelling vs CAE) and return the NXOpen "
        "modules, application and history mode to use, with the matched keywords.",
        _object_schema({"prompt": _STR}, ["prompt"]),
        _h_route_intent,
    ),
    Tool(
        "nx_modeling_plan",
        "Return the required schema for an ordered, editable, history-preserving modelling plan, "
        "including the Part Navigator naming convention.",
        _object_schema({"prompt": _STR, "part_name": _STR, "units": _STR}),
        _h_modeling_plan,
    ),
    Tool(
        "nx_visual_spec",
        "Return the rules for building a model from a picture, blueprint or three-view drawing.",
        _object_schema({"prompt": _STR, "projection_system": _STR, "view_layout": _STR, "units": _STR}),
        _h_visual_spec,
    ),
    Tool(
        "nx_image_capabilities",
        "Report whether this interpreter can actually process images (Pillow/numpy), the workspace it would "
        "write into, and the size/format limits. Call it before promising preprocessing.",
        _object_schema({}),
        _h_image_capabilities,
    ),
    Tool(
        "nx_image_read",
        "Read a picture the user picked (drawing scan, photo, reference image) and describe what is in it: "
        "real format and pixel size, an ASCII ink map showing where the views and the title block sit, and "
        "edge/ink measurements. Supply known_dimension={pixels,value,unit} to get a mm/px scale; without it no "
        "physical size is claimed. Set inline=true to also receive a data URL for a vision model.",
        _object_schema(
            {
                "path": _STR,
                "allow_external": _BOOL,
                "max_bytes": _INT,
                "min_side": _INT,
                "allow_small": _BOOL,
                "known_dimension": {
                    "type": "object",
                    "properties": {"pixels": _NUM, "value": _NUM, "unit": _STR},
                    "required": ["pixels", "value"],
                    "additionalProperties": False,
                },
                "hints": {"type": "array", "items": _STR},
                "inline": _BOOL,
            },
            ["path"],
        ),
        _h_image_read,
    ),
    Tool(
        "nx_image_prepare",
        "Normalise an image into the workspace for a model request: EXIF-rotate, optional grayscale and "
        "autocontrast, fit inside max_side with Lanczos, re-encode as jpeg/png/webp. Accepts a path or a "
        "data: URL. Returns the workspace-relative path (and a data URL when inline=true). Without Pillow the "
        "file is copied unchanged and the returned steps say so.",
        _object_schema(
            {
                "path": _STR,
                "data_url": _STR,
                "name": _STR,
                "max_side": _INT,
                "fmt": {"type": "string", "enum": list(image_input.WRITABLE_FORMATS)},
                "quality": _INT,
                "grayscale": _BOOL,
                "autocontrast": _BOOL,
                "allow_external": _BOOL,
                "allow_small": _BOOL,
                "inline": _BOOL,
                "max_bytes": _INT,
            }
        ),
        _h_image_prepare,
    ),
    Tool(
        "nx_prepare_session",
        "Call this once before modelling: resolves the workspace, routes the intent, attaches the "
        "plan schema, and reports whether the live bridge is available.",
        _object_schema({"prompt": _STR, "part_name": _STR}),
        _h_prepare_session,
    ),
    Tool(
        "nx_create_part",
        "Create a new part in a private batch NX process (does not touch an open NX window).",
        _object_schema({"part_path": _STR, "timeout": _INT}, ["part_path"]),
        _h_create_part,
    ),
    Tool(
        "nx_open_part",
        "Open an existing part in a private batch NX process.",
        _object_schema({"part_path": _STR, "timeout": _INT}, ["part_path"]),
        _h_open_part,
    ),
    Tool(
        "nx_run_journal",
        "Run a reviewed NXOpen journal file from the workspace in a private batch NX process.",
        _object_schema({"journal_path": _STR, "args": {"type": "array", "items": _STR}, "timeout": _INT}, ["journal_path"]),
        _h_run_journal,
    ),
    Tool(
        "nx_live_ping",
        "Check whether the live bridge inside the open NX session is answering.",
        _object_schema({}),
        _h_live_ping,
    ),
    Tool(
        "nx_live_status",
        "Read the open NX session, work part and bounded model summary when available.",
        _object_schema({}),
        _h_live_status,
    ),
    Tool(
        "nx_live_verify",
        "Read the open NX model and verify explicit expectations against observed part path and features. "
        "A failed or unavailable observation is never reported as verified.",
        _object_schema({"part_path": _STR, "min_features": _INT,
                        "feature_names": {"type": "array", "items": _STR}}),
        _h_live_verify,
    ),
    Tool(
        "nx_live_module_list",
        "List the NXOpen modules the running NX session can actually import.",
        _object_schema({}),
        _h_live_module_list,
    ),
    Tool(
        "nx_live_create_modeling_part",
        "Create and display a modelling part in the open NX session.",
        _object_schema({"part_path": _STR, "save": _BOOL}),
        _h_live_create_modeling_part,
    ),
    Tool(
        "nx_live_create_block",
        "Create a named block feature in the current Work Part of the open NX session.",
        _object_schema({"length": _NUM, "width": _NUM, "height": _NUM, "feature_name": _STR, "save": _BOOL}, ["length", "width", "height"]),
        _h_live_create_block,
    ),
    Tool(
        "nx_live_run_python_inline",
        "Run a short NXOpen snippet inside the open NX session. Use for a single quick step.",
        _object_schema({"code": _STR, "stage_name": _STR}, ["code"]),
        _h_live_run_python_inline,
    ),
    Tool(
        "nx_live_run_steps",
        "Run an ordered list of named, explicit operations in the open NX session and report each "
        "step's outcome. Preferred for multi-step modelling: no free-form code is accepted here.",
        _object_schema(
            {
                "steps": {"type": "array", "items": {"type": "object"}},
                "continue_on_error": _BOOL,
            },
            ["steps"],
        ),
        _h_live_run_steps,
    ),
    Tool(
        "nx_live_call",
        "Call any remaining live bridge verb directly (whitelisted commands only).",
        _object_schema({"command": _STR, "params": {"type": "object"}, "timeout": _INT}, ["command"]),
        _h_live_call,
    ),
    Tool(
        "nx_review_submit",
        "Submit an ordered plan for HUMAN-PACED execution in the visible NX session. Use this "
        "instead of the live tools when the user must watch, approve or undo each step -- "
        "especially for CAE solves. The user runs the steps from the NX menu (NX Skill > Review "
        "Plan); no bridge or listener is involved. Mark irreversible steps gate='manual'.",
        _object_schema(
            {
                "plan": {
                    "type": "object",
                    "properties": {
                        "prompt": _STR,
                        "partPath": _STR,
                        "steps": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": _STR,
                                    "name": _STR,
                                    "operation": {"type": "string", "enum": list(REVIEW_OPERATIONS)},
                                    "gate": {"type": "string", "enum": ["auto", "manual"]},
                                    "note": _STR,
                                    "params": {"type": "object"},
                                },
                                "required": ["name", "operation"],
                            },
                        },
                    },
                    "required": ["steps"],
                },
                "scripts": {"type": "object"},
            },
            ["plan"],
        ),
        _h_review_submit,
    ),
    Tool(
        "nx_review_status",
        "Report which review steps are done, which step is waiting, and whether it is waiting on "
        "a human gate. Check this before assuming the user has finished.",
        _object_schema({}),
        _h_review_status,
    ),
    Tool(
        "nx_review_clear",
        "Remove the current review plan and run log.",
        _object_schema({}),
        _h_review_clear,
    ),
)


def list_tools() -> list[dict[str, Any]]:
    return [
        {"name": tool.name, "description": tool.description, "inputSchema": tool.schema}
        for tool in TOOLS
    ]


def call_tool(ctx: Context, name: str, arguments: Mapping[str, Any] | None) -> dict[str, Any]:
    for tool in TOOLS:
        if tool.name == name:
            try:
                return tool.handler(ctx, dict(arguments or {}))
            except SkillError as exc:
                return fail(exc)
            except Exception as exc:  # noqa: BLE001 - reported, never crashes the server
                return fail(exc)
    return fail(
        SkillError(
            f"Unknown tool {name!r}.",
            code="UNKNOWN_TOOL",
            suggestion=f"Call tools/list; available tools: {', '.join(t.name for t in TOOLS)}",
        )
    )

# ---------------------------------------------------------------------------
# Protocol layer
# ---------------------------------------------------------------------------

#: Set to True once a Content-Length framed message has been seen, so replies use
#: the same framing the client used.
_LSP_FRAMING = False


def read_message(stream: Any = None) -> dict[str, Any] | None:
    """Read one JSON-RPC message, accepting both stdio framings.

    Returns `None` at end of input. A malformed line is skipped rather than
    killing the server, because a single bad byte should not end a session.
    """
    global _LSP_FRAMING
    source = sys.stdin.buffer if stream is None else stream

    while True:
        line = source.readline()
        if line == b"" or line is None:
            return None
        stripped = line.strip()
        if not stripped:
            continue

        if stripped.lower().startswith(b"content-length:"):
            _LSP_FRAMING = True
            headers: dict[str, str] = {}
            key, _, value = stripped.decode("ascii", "replace").partition(":")
            headers[key.strip().lower()] = value.strip()
            # Consume the remaining headers up to the blank separator line.
            while True:
                header_line = source.readline()
                if header_line in (b"", b"\r\n", b"\n"):
                    break
                key, _, value = header_line.decode("ascii", "replace").partition(":")
                headers[key.strip().lower()] = value.strip()
            try:
                length = int(headers.get("content-length", "0"))
            except ValueError:
                continue
            if length <= 0:
                continue
            body = source.read(length)
            try:
                return json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue

        try:
            return json.loads(stripped.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue


def write_message(payload: Mapping[str, Any], stream: Any = None) -> None:
    """Write one JSON-RPC message using the framing the client established."""
    target = sys.stdout.buffer if stream is None else stream
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if _LSP_FRAMING:
        target.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
        target.write(body)
    else:
        target.write(body + b"\n")
    target.flush()


def _result(request_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def handle(request: Mapping[str, Any], ctx: Context) -> dict[str, Any] | None:
    """Dispatch one JSON-RPC request. Returns `None` for notifications."""
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    if not isinstance(method, str):
        return _error(request_id, -32600, "Invalid request: 'method' must be a string.")

    is_notification = "id" not in request
    if is_notification and method.startswith("notifications/"):
        return None

    if method == "initialize":
        return _result(
            request_id,
            {
                "protocolVersion": params.get("protocolVersion") or PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}, "resources": {}, "prompts": {}},
                "serverInfo": {"name": SERVER_NAME, "version": __version__},
                "instructions": (
                    "Drives Siemens NX. Start with nx_status to see what is installed. "
                    "Use nx_docs_search for release-exact API answers instead of guessing NXOpen names. "
                    "Call nx_prepare_session once before modelling. "
                    "Live tools act on the open NX window; batch tools do not."
                ),
            },
        )
    if method == "ping":
        return _result(request_id, {})
    if method == "tools/list":
        return _result(request_id, {"tools": list_tools()})
    if method == "resources/list":
        return _result(request_id, {"resources": [{"uri": WORKFLOW_URI, "name": "NX workflow guide",
                                                  "mimeType": "text/plain", "description": "Generic NX workflow and evidence rules"}]})
    if method == "resources/read":
        if params.get("uri") != WORKFLOW_URI:
            return _error(request_id, -32602, "Unknown resource URI")
        return _result(request_id, {"contents": [{"uri": WORKFLOW_URI, "mimeType": "text/plain", "text": WORKFLOW_TEXT}]})
    if method == "prompts/list":
        return _result(request_id, {"prompts": [{"name": "nx_model_task", "description": "Inspect, plan, execute and verify an NX task",
                                              "arguments": [{"name": "request", "description": "The user's task", "required": True}]}]})
    if method == "prompts/get":
        if params.get("name") != "nx_model_task":
            return _error(request_id, -32602, "Unknown prompt name")
        request = str((params.get("arguments") or {}).get("request") or "").strip()
        if not request:
            return _error(request_id, -32602, "request is required")
        return _result(request_id, {"description": "Grounded NX task workflow", "messages": [{
            "role": "user", "content": {"type": "text", "text": WORKFLOW_TEXT + "\n\nUser task: " + request}}]})
    if method == "tools/call":
        name = params.get("name")
        if not isinstance(name, str):
            return _error(request_id, -32602, "params.name must be a string.")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, Mapping):
            return _error(request_id, -32602, "params.arguments must be an object.")
        envelope = call_tool(ctx, name, arguments)
        return _result(
            request_id,
            {
                "content": [{"type": "text", "text": dumps(envelope)}],
                "isError": not envelope.get("ok", False),
                "structuredContent": envelope,
            },
        )

    return _error(request_id, -32601, f"Method not found: {method}")


def serve(ctx: Context | None = None) -> int:
    """Run the stdio loop until the client closes the stream."""
    context = ctx or Context(settings=Settings.from_env())
    while True:
        try:
            request = read_message()
        except KeyboardInterrupt:
            return 0
        if request is None:
            return 0
        if not isinstance(request, Mapping):
            write_message(_error(None, -32700, "Parse error: expected a JSON object."))
            continue
        try:
            response = handle(request, context)
        except Exception as exc:  # noqa: BLE001 - the loop must survive anything
            response = _error(request.get("id"), -32603, f"Internal error: {exc}")
        if response is not None:
            write_message(response)


def main() -> int:
    """Entry point for `python -m nx_skill.server` and the console script."""
    from .cli import configure_logging

    settings = Settings.from_env()
    configure_logging(settings.log_level)
    return serve(Context(settings=settings))


if __name__ == "__main__":
    raise SystemExit(main())
