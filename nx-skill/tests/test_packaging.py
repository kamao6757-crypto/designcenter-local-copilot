"""Packaging invariants that are easy to break by accident.

These use the AST rather than raw text so that *documentation examples* are not
mistaken for hardcoded values: a docstring that says "for example
D:\\Program Files\\Siemens\\NX 2512" is helpful, while the same string used as a
default is exactly the bug this package exists to fix.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SRC = PACKAGE_ROOT / "src" / "nx_skill"

#: Names the package is *allowed* to reference for backward compatibility. Any
#: other release-bound identifier is a regression.
ALLOWED_LEGACY_NAMES = {
    "NX2512_ROOT", "NX2512_BIN", "NX2512_LIVE_PORT", "NX2512_AUTO_LAUNCH",
    "NX2512_AUTO_LAUNCH_TIMEOUT", "NX2512_REQUIRE_ONLINE",
    "NX2512_DELETE_GENERATED_SCRIPTS", "NX2512_SKIP_GLOBAL_SEARCH",
    "NX2512_PROJECT_ROOT", "NX2512_PLUGIN_ROOT", "NX2512_GENERATED_SCRIPT_ROOT",
    "DC2512_ROOT", "DC2512_BIN", "DC2512_PROJECT_ROOT",
    "UGII_BASE_DIR", "UGII_ROOT_DIR", "NX_ROOT", "NXBIN", "SIEMENS_NX_ROOT",
    "CODEX_PYTHON",
}

_HARDCODED_PATH = re.compile(r"^[A-Za-z]:[\\/]")
_RELEASE_BOUND = re.compile(r"NX2512_[A-Z_]+|NXCodex|\bNX 2512\b")


def _python_files() -> list[Path]:
    return sorted(SRC.rglob("*.py"))


def _docstring_nodes(tree: ast.AST) -> set[int]:
    """Ids of string constants that are module/class/function docstrings."""
    ids: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                if isinstance(body[0].value.value, str):
                    ids.add(id(body[0].value))
    return ids


def _code_string_literals() -> list[tuple[str, str]]:
    """Yield `(file, literal)` for string constants that are not docstrings."""
    found: list[tuple[str, str]] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docstrings = _docstring_nodes(tree)
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if id(node) in docstrings:
                    continue
                found.append((path.name, node.value))
    return found


def _optional_import_linenos(tree: ast.AST) -> set[int]:
    """Line numbers of imports that sit inside a try/except.

    The invariant is "this package imports on a bare machine", not "Pillow is
    never mentioned". `nx_skill.images` upgrades itself when Pillow/numpy are
    importable and degrades with an explicit message when they are not, and the
    try/except is what makes that difference visible to this test instead of
    hiding it: an unguarded third-party import still fails the suite.
    """
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            for inner in ast.walk(node):
                if isinstance(inner, (ast.Import, ast.ImportFrom)):
                    guarded.add(inner.lineno)
    return guarded


def test_package_imports_without_third_party_dependencies():
    """It must run on a bare machine and inside NX's embedded Python, where pip is unavailable."""
    stdlib_modules = {
        "base64", "csv", "dataclasses", "io", "json", "logging", "os", "re",
        "subprocess", "sys", "time", "typing", "xml", "argparse", "pathlib",
        "shutil", "sysconfig", "textwrap", "collections", "functools", "itertools",
        # platform-specific but always stdlib
        "__future__", "ctypes", "winreg", "posixpath", "ntpath",
        "tempfile", "uuid", "hashlib", "secrets",
        # used by nx_skill.images for header parsing and base64 payloads
        "binascii", "struct",
    }
    offenders: list[str] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        optional = _optional_import_linenos(tree)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)) and node.lineno in optional:
                continue
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.split(".")[0] not in stdlib_modules:
                        offenders.append(f"{path.name}: import {alias.name}")
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                if node.module.split(".")[0] not in stdlib_modules:
                    offenders.append(f"{path.name}: from {node.module}")
    assert offenders == [], f"non-stdlib imports found: {offenders}"


def test_optional_image_imports_are_guarded():
    """The flip side of the exemption above: PIL/numpy may only appear in a try/except."""
    unguarded: list[str] = []
    for path in _python_files():
        tree = ast.parse(path.read_text(encoding="utf-8"))
        optional = _optional_import_linenos(tree)
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)) and node.lineno not in optional:
                names = [a.name.split(".")[0] for a in getattr(node, "names", [])]
                if getattr(node, "module", None):
                    names.append(node.module.split(".")[0])
                for name in names:
                    if name in {"PIL", "numpy", "cv2", "trimesh"}:
                        unguarded.append(f"{path.name}:{node.lineno}: {name}")
    assert unguarded == [], f"third-party image imports must be inside try/except: {unguarded}"


def test_no_code_literal_is_a_hardcoded_machine_path():
    offenders = [
        f"{name}: {literal!r}"
        for name, literal in _code_string_literals()
        if _HARDCODED_PATH.match(literal)
    ]
    assert offenders == [], f"hardcoded absolute paths in code: {offenders}"


def test_no_release_bound_identifier_leaks_into_code():
    """Only the documented legacy names may appear; nothing may bind to one release."""
    offenders: list[str] = []
    for name, literal in _code_string_literals():
        for match in _RELEASE_BOUND.findall(literal):
            if match.startswith("NX2512_") and match in ALLOWED_LEGACY_NAMES:
                continue
            offenders.append(f"{name}: {match!r} in {literal!r}")
    assert offenders == [], f"release-bound identifiers in code: {offenders}"


def test_legacy_names_are_declared_centrally():
    """Backward compatibility must live in one table, not be scattered."""
    from nx_skill.config import LEGACY_ALIASES

    declared = {alias for aliases in LEGACY_ALIASES.values() for alias in aliases}
    assert {"NX2512_ROOT", "DC2512_ROOT", "UGII_BASE_DIR"} <= declared
    assert "UGII_ROOT_DIR" in declared


def test_pyproject_declares_no_runtime_dependencies():
    toml = pytest.importorskip("tomllib", reason="tomllib requires Python 3.11+")
    data = toml.loads((PACKAGE_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["dependencies"] == []
    assert data["project"]["scripts"]["nx-skill"] == "nx_skill.cli:main"
    assert data["project"]["name"] == "nx-skill"


def test_skill_file_is_identical_in_both_locations():
    """Hosts read the skill from different places; drift would be silent."""
    top = (PACKAGE_ROOT / "SKILL.md").read_text(encoding="utf-8")
    nested = (PACKAGE_ROOT / "skills" / "nx" / "SKILL.md").read_text(encoding="utf-8")
    assert top == nested, "SKILL.md and skills/nx/SKILL.md have drifted; re-sync them"


def test_skill_frontmatter_is_present_and_parsable():
    text = (PACKAGE_ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert text.startswith("---")
    frontmatter = text.split("---", 2)[1]
    assert re.search(r"^name:\s*\S+", frontmatter, re.MULTILINE)
    assert re.search(r"^description:\s*\S+", frontmatter, re.MULTILINE)


def test_mcp_manifest_uses_a_relative_launcher():
    manifest = json.loads((PACKAGE_ROOT / ".mcp.json").read_text(encoding="utf-8"))
    server = manifest["mcpServers"]["nx"]
    assert server["command"] == "python"
    joined = " ".join(server["args"])
    assert not _HARDCODED_PATH.search(joined), "the MCP manifest must not hardcode a path"
    assert "nx_skill" in joined


def test_codex_plugin_manifest_is_valid_json():
    manifest = json.loads((PACKAGE_ROOT / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "nx"
    assert manifest["skills"] == "./skills/"
    assert manifest["mcpServers"] == "./.mcp.json"


def test_custom_dirs_template_has_a_placeholder_not_a_path():
    template = (PACKAGE_ROOT / "nx_runtime" / "custom_dirs.dat.template").read_text(encoding="utf-8")
    assert "{{RUNTIME_ROOT}}" in template
    assert not re.search(r"[A-Za-z]:[\\/]", template), "the template must not contain a real path"
    assert not (PACKAGE_ROOT / "nx_runtime" / "custom_dirs.dat").exists(), (
        "custom_dirs.dat is generated per machine and must not be committed"
    )


def test_documentation_linked_from_the_skill_exists():
    text = (PACKAGE_ROOT / "SKILL.md").read_text(encoding="utf-8")
    targets = re.findall(r"\]\((docs/[^)]+)\)", text)
    assert targets, "SKILL.md should link its reference documentation"
    for target in targets:
        assert (PACKAGE_ROOT / target).is_file(), f"SKILL.md links a missing file: {target}"


def test_console_entry_points_are_importable():
    from nx_skill.cli import main as cli_main
    from nx_skill.server import main as server_main, serve

    assert callable(cli_main) and callable(server_main) and callable(serve)
    assert sys.version_info >= (3, 9)
