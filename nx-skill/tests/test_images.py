"""Image input: probe, describe (measurements + scale) and prepare.

The picture is generated here rather than committed: a test that depends on a
binary fixture cannot tell you *why* it failed, and these assertions are about
header parsing, thresholds and the workspace boundary anyway.

Pillow is optional in this package by design, so the tests that need real
decoding are skipped when it is missing instead of failing the suite.
"""

from __future__ import annotations

import base64
import binascii

import pytest

from nx_skill import images
from nx_skill.contracts import SkillError

PIL = pytest.importorskip("PIL", reason="Pillow is optional; image decoding tests need it")


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def make_drawing(path, *, size=(1600, 1131)):
    from PIL import Image, ImageDraw

    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle([40, 30, 1560, 1100], outline="black", width=4)
    draw.rectangle([1140, 940, 1560, 1100], outline="black", width=3)
    draw.rectangle([300, 300, 900, 700], outline="black", width=5)
    draw.ellipse([520, 420, 680, 580], outline="black", width=4)
    draw.line([300, 760, 900, 760], fill="black", width=2)
    image.save(path)
    return path


@pytest.fixture()
def drawing(tmp_path):
    return make_drawing(tmp_path / "drawing.png")


@pytest.fixture()
def workspace(tmp_path):
    return images.workspace_for(tmp_path / "ws")


def code_of(exc):
    return getattr(exc, "code", None)


# --------------------------------------------------------------------------
# probe
# --------------------------------------------------------------------------


def test_probe_reports_real_format_and_size(drawing):
    info = images.probe_image(drawing)
    assert info["format"] == "png"
    assert (info["width"], info["height"]) == (1600, 1131)
    assert info["mime"] == "image/png"
    assert info["usable"] is True
    assert info["megapixels"] == pytest.approx(1.81, abs=0.01)


def test_probe_trusts_content_over_extension(tmp_path, drawing):
    """A .png that is really a JPEG must be reported as JPEG, with a warning."""
    from PIL import Image

    wrong = tmp_path / "mislabelled.png"
    Image.open(drawing).convert("RGB").save(wrong, "JPEG")
    info = images.probe_image(wrong)
    assert info["format"] == "jpeg"
    assert any("disagrees" in w for w in info["warnings"])


def test_probe_missing_file(tmp_path):
    with pytest.raises(SkillError) as exc:
        images.probe_image(tmp_path / "nope.png")
    assert code_of(exc.value) == "IMAGE_NOT_FOUND"


def test_probe_unsupported_format(tmp_path):
    target = tmp_path / "notes.txt"
    target.write_text("not an image", encoding="utf-8")
    with pytest.raises(SkillError) as exc:
        images.probe_image(target)
    assert code_of(exc.value) == "IMAGE_UNSUPPORTED_FORMAT"
    assert "png" in (exc.value.suggestion or "").lower()


def test_probe_empty_file(tmp_path):
    target = tmp_path / "empty.png"
    target.write_bytes(b"")
    with pytest.raises(SkillError) as exc:
        images.probe_image(target)
    assert code_of(exc.value) == "IMAGE_DECODE_FAILED"


def test_probe_too_large(tmp_path, drawing):
    with pytest.raises(SkillError) as exc:
        images.probe_image(drawing, max_bytes=512)
    assert code_of(exc.value) == "IMAGE_TOO_LARGE"


def test_probe_low_resolution_is_refused_unless_allowed(tmp_path):
    small = make_drawing(tmp_path / "small.png", size=(120, 85))
    with pytest.raises(SkillError) as exc:
        images.probe_image(small)
    assert code_of(exc.value) == "IMAGE_TOO_SMALL"
    assert "600 dpi" in (exc.value.suggestion or "")

    allowed = images.probe_image(small, allow_small=True)
    assert allowed["usable"] is False
    assert any("unreadable" in w for w in allowed["warnings"])


# --------------------------------------------------------------------------
# workspace boundary
# --------------------------------------------------------------------------


def test_external_read_is_allowed_when_asked(drawing, workspace):
    """A user-picked drawing lives outside the workspace and must still be readable."""
    assert images.probe_image(drawing, allow_external=True, workspace=workspace)["width"] == 1600


def test_external_read_is_refused_when_disallowed(drawing, workspace):
    with pytest.raises(SkillError) as exc:
        images.probe_image(drawing, allow_external=False, workspace=workspace)
    assert code_of(exc.value) == "WORKSPACE_VIOLATION"


def test_prepared_file_lands_inside_the_workspace(drawing, workspace):
    prepared = images.prepare_image(drawing, workspace=workspace, max_side=800)
    target = workspace.root / prepared["path"]
    assert target.is_file()
    assert workspace.root in target.parents
    assert prepared["path"].startswith("images/")


# --------------------------------------------------------------------------
# describe
# --------------------------------------------------------------------------


def test_describe_measures_without_claiming_physical_size(drawing, workspace):
    brief = images.describe_image(drawing, workspace=workspace)
    assert brief["scale"]["mmPerPixel"] is None
    assert "No known dimension" in brief["scale"]["reason"]
    measurements = brief["measurements"]
    assert measurements["available"] is True
    assert 0 < measurements["inkRatio"] < 0.5
    assert len(measurements["inkGrid"]) == 16
    # 边框所在的行列应该被判成"有线条",而不是一片空白
    joined = "".join(measurements["inkGrid"])
    assert joined.count("o") + joined.count("#") > 10


def test_describe_turns_a_known_dimension_into_a_scale(drawing, workspace):
    brief = images.describe_image(
        drawing, workspace=workspace, known_dimension={"pixels": 600, "value": 600.0, "unit": "mm"}
    )
    assert brief["scale"]["mmPerPixel"] == pytest.approx(1.0)
    assert brief["scale"]["unit"] == "mm"
    assert "240.00 mm" in brief["scale"]["example"]


def test_describe_rejects_a_bad_known_dimension(drawing, workspace):
    with pytest.raises(SkillError) as exc:
        images.describe_image(drawing, workspace=workspace, known_dimension={"pixels": 0, "value": 10})
    assert code_of(exc.value) == "INVALID_ARGUMENT"


def test_describe_survives_a_tiny_working_copy(tmp_path, workspace):
    """Measurement resizes internally; a small sheet must not crash it."""
    small = make_drawing(tmp_path / "mid.png", size=(240, 170))
    brief = images.describe_image(small, workspace=workspace, allow_small=True)
    assert brief["measurements"]["available"] is True


# --------------------------------------------------------------------------
# prepare
# --------------------------------------------------------------------------


def test_prepare_converts_grayscale_and_fits_the_long_side(drawing, workspace):
    prepared = images.prepare_image(drawing, workspace=workspace, max_side=900, fmt="jpeg", grayscale=True)
    assert prepared["format"] == "jpeg"
    assert max(prepared["width"], prepared["height"]) == 900
    assert any("grayscale" in step for step in prepared["steps"])
    assert any("Lanczos" in step for step in prepared["steps"])
    assert prepared["bytes"] > 0


def test_prepare_keeps_native_size_when_already_small(drawing, workspace):
    prepared = images.prepare_image(drawing, workspace=workspace, max_side=4000)
    assert (prepared["width"], prepared["height"]) == (1600, 1131)
    assert any("kept native size" in step for step in prepared["steps"])


def test_prepare_inline_produces_a_decodable_data_url(drawing, workspace):
    prepared = images.prepare_image(drawing, workspace=workspace, max_side=600, inline=True)
    assert prepared["dataUrl"].startswith("data:image/jpeg;base64,")
    payload = base64.b64decode(prepared["dataUrl"].split(",", 1)[1], validate=True)
    assert payload[:3] == b"\xff\xd8\xff"          # JPEG magic, not "whatever we wrote"


def test_prepare_rejects_bad_arguments(drawing, workspace):
    for kwargs, field in (({"fmt": "tiff"}, "fmt"), ({"max_side": 0}, "max_side"), ({"quality": 0}, "quality")):
        with pytest.raises(SkillError) as exc:
            images.prepare_image(drawing, workspace=workspace, **kwargs)
        assert code_of(exc.value) == "INVALID_ARGUMENT", field


# --------------------------------------------------------------------------
# data URLs
# --------------------------------------------------------------------------


def test_save_payload_round_trip(drawing, workspace):
    url = images.data_url_for(drawing)
    assert url.startswith("data:image/png;base64,")
    saved = images.save_payload(url, workspace=workspace, name="pasted shot")
    assert saved["probe"]["format"] == "png"
    assert (workspace.root / saved["path"]).is_file()
    # 文件名被清洗过,不会带空格把路径搞坏
    assert " " not in saved["path"]


def test_load_payload_rejects_junk(workspace):
    with pytest.raises(SkillError) as exc:
        images.load_payload("data:image/png;base64,!!!not base64!!!")
    assert code_of(exc.value) in ("IMAGE_DECODE_FAILED",)
    with pytest.raises(SkillError) as exc2:
        images.load_payload("http://example.com/a.png")
    assert code_of(exc2.value) == "INVALID_ARGUMENT"
    with pytest.raises(SkillError) as exc3:
        images.save_payload("data:image/png;base64," + base64.b64encode(b"hello world").decode(), workspace=workspace)
    assert code_of(exc3.value) == "IMAGE_UNSUPPORTED_FORMAT"


def test_capabilities_reports_pillow_and_numpy():
    caps = images.capabilities()
    assert caps["pillowAvailable"] is True
    assert caps["numpyAvailable"] is True
    assert caps["canConvert"] and caps["canResize"] and caps["canMeasure"]
