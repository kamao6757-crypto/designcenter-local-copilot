"""Image input for the NX skill: probe, prepare and describe a picture.

Why this module is shaped the way it is
---------------------------------------

1. **Standard library only.** This package must import inside NX's own embedded
   interpreter (``NXBIN/python``), where there is no ``pip``, no
   ``site-packages`` and no ``Lib`` — so Pillow cannot be assumed. Everything
   here works with ``bytes`` and header parsing; Pillow and numpy are optional
   *upgrades* that are used when they happen to be importable (they are in the
   host interpreter the agent drives, not inside NX).

2. **Reads are allowed anywhere, writes stay in the workspace.** A user picks a
   drawing from ``D:\\drawings``; refusing to read it because it is outside
   ``NX_SKILL_WORKSPACE`` would be useless. So *input* paths may be absolute
   (``allow_external=True``), while every file this module *writes* goes into
   the workspace, and the returned path is relative to it.

3. **No invented measurements.** Every number in :func:`describe_image` is a
   measurement of pixels. Physical scale is only reported when the caller
   supplies a known dimension, and even then it is labelled an estimate with
   its error bar. A model that "reads" a diameter nobody measured is worse than
   one that asks.

Envelope errors use the package's uniform codes; see :data:`ERROR_CODES`.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import struct
from pathlib import Path
from typing import Any, Mapping, Sequence

from .contracts import InvalidArgument, SkillError, Workspace

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

#: Extensions we accept. The extension is a hint only — the real format is
#: sniffed from the leading bytes, because ".png" files that are really JPEGs
#: are common in exported drawings.
SUPPORTED_SUFFIXES = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp")

MIME_BY_FORMAT = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tiff": "image/tiff",
    "webp": "image/webp",
}

EXTENSIONS_BY_FORMAT = {
    "png": (".png",),
    "jpeg": (".jpg", ".jpeg"),
    "gif": (".gif",),
    "bmp": (".bmp",),
    "tiff": (".tif", ".tiff"),
    "webp": (".webp",),
}

#: Formats Pillow can write. Without Pillow nothing is converted.
WRITABLE_FORMATS = ("jpeg", "png", "webp")

DEFAULT_MAX_BYTES = 40 * 1024 * 1024
DEFAULT_MAX_SIDE = 1600
DEFAULT_MIN_SIDE = 200

ERROR_CODES = (
    "IMAGE_NOT_FOUND",
    "IMAGE_UNSUPPORTED_FORMAT",
    "IMAGE_TOO_LARGE",
    "IMAGE_TOO_SMALL",
    "IMAGE_DECODE_FAILED",
    "IMAGE_DEPENDENCY_MISSING",
    "IMAGE_TIMEOUT",
)


class ImageError(SkillError):
    """A picture could not be read, prepared or described."""

    code = "IMAGE_ERROR"


def _err(code: str, message: str, *, suggestion: str | None = None, **details: Any) -> ImageError:
    return ImageError(message, code=code, suggestion=suggestion, details=details or None)


# --------------------------------------------------------------------------
# Optional dependencies
# --------------------------------------------------------------------------


def _pillow():
    try:  # pragma: no cover - depends on the interpreter
        from PIL import Image, ImageOps  # type: ignore

        return Image, ImageOps
    except Exception:
        return None, None


def _numpy():
    try:  # pragma: no cover - depends on the interpreter
        import numpy  # type: ignore

        return numpy
    except Exception:
        return None


def capabilities() -> dict[str, Any]:
    """Report which optional pieces are available in *this* interpreter.

    The agent calls this before promising preprocessing: "I can resize and
    normalise this" is only true where Pillow is importable.
    """
    Image, _ = _pillow()
    numpy = _numpy()
    return {
        "pillow": getattr(Image, "__version__", None),
        "numpy": getattr(numpy, "__version__", None),
        "pillowAvailable": Image is not None,
        "numpyAvailable": numpy is not None,
        "python": _python_version(),
        "canConvert": Image is not None,
        "canResize": Image is not None,
        "canMeasure": numpy is not None,
    }


def _python_version() -> str:
    import sys

    return "%d.%d.%d" % sys.version_info[:3]


# --------------------------------------------------------------------------
# Header sniffing (no dependencies)
# --------------------------------------------------------------------------


def _sniff_format(head: bytes) -> str | None:
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:2] == b"BM":
        return "bmp"
    if head[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _png_size(data: bytes) -> tuple[int, int, float | None]:
    # IHDR is required to be the first chunk: 8 sig + 4 len + 4 type, then 13 bytes.
    if len(data) < 33 or data[12:16] != b"IHDR":
        raise ValueError("PNG header is truncated or not an IHDR-first file.")
    width, height = struct.unpack(">II", data[16:24])
    dpi = None
    offset = 8
    while offset + 8 <= len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        ctype = data[offset + 4 : offset + 8]
        if ctype == b"pHYs":
            body = data[offset + 8 : offset + 8 + 9]
            if len(body) >= 9:
                xppm, yppm, unit = struct.unpack(">IIB", body)
                if unit == 1 and xppm:
                    dpi = round(xppm * 0.0254, 1)
            break
        if ctype == b"IDAT":
            break
        offset += 12 + length
        if length > len(data):
            break
    return width, height, dpi


def _jpeg_size(data: bytes) -> tuple[int, int, float | None]:
    dpi = None
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        marker = data[offset + 1]
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            offset += 2
            continue
        length = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
        if length < 2:
            raise ValueError("Malformed JPEG segment length.")
        # APP0 JFIF carries the density we want, when the writer bothered.
        if marker == 0xE0 and data[offset + 4 : offset + 9] == b"JFIF\x00" and length >= 14:
            units = data[offset + 11]
            xdensity = struct.unpack(">H", data[offset + 12 : offset + 14])[0]
            if units == 1 and xdensity:
                dpi = float(xdensity)
            elif units == 2 and xdensity:
                dpi = round(xdensity * 2.54, 1)
        # SOFn frames carry the pixel dimensions.
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            body = data[offset + 4 : offset + 4 + 5]
            if len(body) >= 5:
                height, width = struct.unpack(">HH", body[1:5])
                return width, height, dpi
        offset += 2 + length
    raise ValueError("No JPEG frame header found.")


def _gif_size(data: bytes) -> tuple[int, int, float | None]:
    if len(data) < 10:
        raise ValueError("GIF header is truncated.")
    width, height = struct.unpack("<HH", data[6:10])
    return width, height, None


def _bmp_size(data: bytes) -> tuple[int, int, float | None]:
    if len(data) < 30:
        raise ValueError("BMP header is truncated.")
    width, height = struct.unpack("<ii", data[18:26])
    dpi = None
    if len(data) >= 46:
        xppm = struct.unpack("<i", data[38:42])[0]
        if xppm > 0:
            dpi = round(xppm * 0.0254, 1)
    return abs(width), abs(height), dpi


def _webp_size(data: bytes) -> tuple[int, int, float | None]:
    if len(data) < 30:
        raise ValueError("WebP header is truncated.")
    fourcc = data[12:16]
    if fourcc == b"VP8X":
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height, None
    if fourcc == b"VP8 ":
        # lossy: frame header starts at 20, sync code then 14-bit dimensions
        width = struct.unpack("<H", data[26:28])[0] & 0x3FFF
        height = struct.unpack("<H", data[28:30])[0] & 0x3FFF
        return width, height, None
    if fourcc == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1, None
    raise ValueError("Unsupported WebP variant: %r" % (fourcc,))


def _tiff_size(data: bytes) -> tuple[int, int, float | None]:
    endian = "<" if data[:2] == b"II" else ">"
    offset = struct.unpack(endian + "I", data[4:8])[0]
    if offset + 2 > len(data):
        raise ValueError("TIFF IFD offset is out of range.")
    count = struct.unpack(endian + "H", data[offset : offset + 2])[0]
    width = height = None
    dpi = None
    for index in range(count):
        base = offset + 2 + index * 12
        if base + 12 > len(data):
            break
        tag, kind = struct.unpack(endian + "HH", data[base : base + 4])
        value = struct.unpack(endian + "I", data[base + 8 : base + 12])[0]
        if kind == 3 and base + 10 <= len(data):  # SHORT stored inline
            value = struct.unpack(endian + "H", data[base + 8 : base + 10])[0]
        if tag == 256:
            width = value
        elif tag == 257:
            height = value
        elif tag == 282 and value:  # XResolution, rational offset
            dpi = round(_tiff_rational(data, value, endian), 1)
    if not width or not height:
        raise ValueError("TIFF IFD has no ImageWidth/ImageLength.")
    return int(width), int(height), dpi


def _tiff_rational(data: bytes, offset: int, endian: str) -> float:
    if offset + 8 > len(data):
        return 0.0
    numerator, denominator = struct.unpack(endian + "II", data[offset : offset + 8])
    return numerator / denominator if denominator else 0.0


_SIZERS = {
    "png": _png_size,
    "jpeg": _jpeg_size,
    "gif": _gif_size,
    "bmp": _bmp_size,
    "webp": _webp_size,
    "tiff": _tiff_size,
}


# --------------------------------------------------------------------------
# Path handling
# --------------------------------------------------------------------------


def resolve_input(path: str | Path, *, allow_external: bool, workspace: Workspace | None) -> Path:
    """Resolve a *read* path, allowing absolute paths outside the workspace.

    The workspace boundary exists to stop an agent writing into arbitrary
    places. Reading a picture the user just picked is the opposite situation, so
    ``allow_external`` opens exactly that door and nothing else.
    """
    text = str(path or "").strip()
    if not text:
        raise InvalidArgument("An image path is required.")
    candidate = Path(text).expanduser()
    if not candidate.is_absolute():
        if workspace is None:
            candidate = Path.cwd() / candidate
        else:
            base = workspace.root / candidate
            if base.exists():
                candidate = base
            elif allow_external:
                candidate = Path.cwd() / candidate
            else:
                candidate = base
    if not allow_external and workspace is not None:
        workspace.ensure_inside(candidate)
    return candidate


def _read(path: Path, max_bytes: int) -> bytes:
    if not path.exists():
        raise _err(
            "IMAGE_NOT_FOUND",
            "No such image file: %s" % path,
            suggestion="Check the path, or pick the file again from the dialog.",
            path=str(path),
        )
    if not path.is_file():
        raise _err(
            "IMAGE_NOT_FOUND",
            "That path is a directory, not a file: %s" % path,
            path=str(path),
        )
    size = path.stat().st_size
    if size == 0:
        raise _err("IMAGE_DECODE_FAILED", "The image file is empty: %s" % path, path=str(path))
    if size > max_bytes:
        raise _err(
            "IMAGE_TOO_LARGE",
            "Image is %.1f MB, over the %.1f MB limit." % (size / 1048576.0, max_bytes / 1048576.0),
            suggestion="Raise max_bytes, or downscale the picture before feeding it in.",
            path=str(path),
            sizeBytes=size,
            maxBytes=max_bytes,
        )
    with open(path, "rb") as handle:
        return handle.read()


# --------------------------------------------------------------------------
# Probe
# --------------------------------------------------------------------------


def probe_image(
    path: str | Path,
    *,
    allow_external: bool = True,
    workspace: Workspace | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    min_side: int = DEFAULT_MIN_SIDE,
    allow_small: bool = False,
) -> dict[str, Any]:
    """Describe the *file*: real format, pixel size, density, and fitness.

    Only ~200 KB of the file are read — enough for every header this module
    understands — so a 200 MB TIFF is probed without loading it.
    """
    resolved = resolve_input(path, allow_external=allow_external, workspace=workspace)
    if not resolved.exists() or not resolved.is_file():
        raise _err(
            "IMAGE_NOT_FOUND",
            "No such image file: %s" % resolved,
            suggestion="Check the path, or pick the file again from the dialog.",
            path=str(resolved),
        )
    size = resolved.stat().st_size
    if size == 0:
        raise _err("IMAGE_DECODE_FAILED", "The image file is empty: %s" % resolved, path=str(resolved))
    if size > max_bytes:
        raise _err(
            "IMAGE_TOO_LARGE",
            "Image is %.1f MB, over the %.1f MB limit." % (size / 1048576.0, max_bytes / 1048576.0),
            suggestion="Raise max_bytes, or downscale the picture before feeding it in.",
            path=str(resolved),
            sizeBytes=size,
            maxBytes=max_bytes,
        )

    with open(resolved, "rb") as handle:
        head = handle.read(256 * 1024)

    if not head:
        raise _err("IMAGE_DECODE_FAILED", "The image file is empty: %s" % resolved, path=str(resolved))

    fmt = _sniff_format(head)
    suffix = resolved.suffix.lower()
    warnings: list[str] = []

    if fmt is None:
        raise _err(
            "IMAGE_UNSUPPORTED_FORMAT",
            "Not a recognised image format: %s" % resolved,
            suggestion="Supported: " + ", ".join(SUPPORTED_SUFFIXES) + ".",
            detectedSuffix=suffix or None,
            leadingBytes=list(head[:8]),
        )
    if suffix and suffix not in SUPPORTED_SUFFIXES:
        warnings.append("Extension %s is not one of the supported ones, but the content is %s." % (suffix, fmt))
    elif suffix and suffix not in EXTENSIONS_BY_FORMAT.get(fmt, ()):
        warnings.append("Extension %s disagrees with the detected %s content." % (suffix, fmt))

    width = height = None
    dpi = None
    try:
        width, height, dpi = _SIZERS[fmt](head)
    except Exception as exc:  # noqa: BLE001 - any parse failure is "cannot trust the header"
        warnings.append("Could not parse the %s header (%s)." % (fmt, exc))

    shortest = min([v for v in (width, height) if v] or [0])
    usable = True
    if width and height:
        if shortest < min_side:
            usable = False
            if not allow_small:
                raise _err(
                    "IMAGE_TOO_SMALL",
                    "Image is %dx%d px; the short side is below the %d px minimum." % (width, height, min_side),
                    suggestion=(
                        "Re-export at a higher resolution (600 dpi or more for a drawing), "
                        "or pass allow_small=True if you accept reduced legibility."
                    ),
                    width=width,
                    height=height,
                    minSide=min_side,
                )
            warnings.append("Below the %d px guidance: dimension text may be unreadable." % min_side)

    return {
        "path": str(resolved),
        "fileName": resolved.name,
        "extension": suffix or None,
        "format": fmt,
        "mime": MIME_BY_FORMAT.get(fmt, "application/octet-stream"),
        "sizeBytes": size,
        "width": width,
        "height": height,
        "megapixels": round((width * height) / 1e6, 2) if width and height else None,
        "aspect": round(width / height, 4) if width and height else None,
        "dpi": dpi,
        "usable": usable,
        "warnings": warnings,
        "capabilities": capabilities(),
    }


# --------------------------------------------------------------------------
# Describe (measurements a model can actually use)
# --------------------------------------------------------------------------


def _grid(gray: "Any", cells: int = 16) -> list[str]:
    """A tiny ASCII ink map: where the content sits on the sheet.

    Thresholds are set on the *fraction of dark pixels*, not the block mean: a
    4 px border line inside a 100x70 block moves the mean by about 3 %, which is
    invisible, while it is an unmistakable 4 % of dark pixels. For a drawing this
    map is what lets a model say "the title block is bottom-right, the main view
    is centre-left" instead of guessing.
    """
    height, width = gray.shape
    rows: list[str] = []
    for row in range(cells):
        line = []
        for col in range(cells):
            block = gray[
                int(row * height / cells) : max(int(row * height / cells) + 1, int((row + 1) * height / cells)),
                int(col * width / cells) : max(int(col * width / cells) + 1, int((col + 1) * width / cells)),
            ]
            ink = float((block < 128).mean()) if block.size else 0.0
            line.append("." if ink < 0.015 else ("o" if ink < 0.08 else "#"))
        rows.append("".join(line))
    return rows


def _measure(gray: "Any") -> dict[str, Any]:
    numpy = _numpy()
    if numpy is None:
        return {"available": False}
    arr = gray.astype("float32")
    dx = numpy.abs(numpy.diff(arr, axis=1)).mean() if arr.shape[1] > 1 else 0.0
    dy = numpy.abs(numpy.diff(arr, axis=0)).mean() if arr.shape[0] > 1 else 0.0
    dark = float((arr < 128).mean())
    rows = numpy.array([numpy.mean(arr[r]) for r in numpy.array_split(numpy.arange(arr.shape[0]), 24)])
    cols = numpy.array([numpy.mean(arr[:, c]) for c in numpy.array_split(numpy.arange(arr.shape[1]), 24)])
    return {
        "available": True,
        "meanGray": round(float(arr.mean()), 2),
        "stdGray": round(float(arr.std()), 2),
        "inkRatio": round(dark, 4),
        "edgeDensity": round(float((dx + dy) / 2.0), 3),
        "rowInkBand": [round(float((255.0 - v) / 255.0), 3) for v in rows],
        "colInkBand": [round(float((255.0 - v) / 255.0), 3) for v in cols],
        "inkGrid": _grid(gray),
        "note": "All values are pixel measurements of this file, not model dimensions.",
    }


def describe_image(
    path: str | Path,
    *,
    allow_external: bool = True,
    workspace: Workspace | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    min_side: int = DEFAULT_MIN_SIDE,
    allow_small: bool = False,
    known_dimension: Mapping[str, Any] | None = None,
    hints: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Probe + measure, and optionally turn pixels into millimetres.

    ``known_dimension`` is how scale enters the picture honestly. Give it a
    pixel span and its real length (measured on the print, or a stated value in
    the title block) and this returns a scale with its uncertainty; give it
    nothing and no physical size is claimed at all.
    """
    probe = probe_image(
        path,
        allow_external=allow_external,
        workspace=workspace,
        max_bytes=max_bytes,
        min_side=min_side,
        allow_small=allow_small,
    )
    result: dict[str, Any] = {
        "file": probe,
        "measurements": None,
        "scale": None,
        "hints": list(hints or []),
        "next": [
            "Confirm the projection (first vs third angle) before reading any view.",
            "Read dimension text, not line lengths: a drawing is only 1:1 by title-block convention.",
            "Every dimension you cannot read must become an editable NXOpen expression, not a guess.",
        ],
    }

    Image, ImageOps = _pillow()
    if Image is None:
        result["measurements"] = {
            "available": False,
            "reason": "Pillow is not importable in this interpreter; only header data is available.",
            "install": "pip install pillow  (in the interpreter that runs the host; NX's embedded python has no pip)",
        }
    else:
        with Image.open(probe["path"]) as raw:
            image = ImageOps.exif_transpose(raw) or raw
            gray = image.convert("L")
            # Cap the working copy: measurements do not need 8000 px of width.
            if max(gray.size) > 2048:
                ratio = 2048.0 / max(gray.size)
                gray = gray.resize((max(1, int(gray.size[0] * ratio)), max(1, int(gray.size[1] * ratio))))
            numpy = _numpy()
            result["measurements"] = (
                _measure(numpy.asarray(gray)) if numpy is not None
                else {"available": False, "reason": "numpy is not importable; Pillow alone cannot measure."}
            )

    if known_dimension:
        try:
            pixels = float(known_dimension.get("pixels"))
            real = float(known_dimension.get("value"))
            unit = str(known_dimension.get("unit") or "mm")
        except (TypeError, ValueError):
            raise InvalidArgument("known_dimension needs numeric {pixels, value} and an optional unit.")
        if pixels <= 0 or real <= 0:
            raise InvalidArgument("known_dimension pixels and value must both be positive.")
        per_pixel = real / pixels
        result["scale"] = {
            "mmPerPixel": round(per_pixel, 6),
            "unit": unit,
            "basis": known_dimension,
            "uncertainty": "±1 px on the reference span; verify against a second dimension before trusting a derived size.",
            "example": "a 240 px span would be %.2f %s" % (240 * per_pixel, unit),
        }
    else:
        result["scale"] = {
            "mmPerPixel": None,
            "reason": "No known dimension supplied, so no physical size is claimed.",
            "how": "Pass known_dimension={'pixels': <span you measured on the image>, 'value': <its real length>, 'unit': 'mm'}.",
        }
    return result


# --------------------------------------------------------------------------
# Prepare (normalise for the model)
# --------------------------------------------------------------------------


def _to_data_url(data: bytes, mime: str) -> str:
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))


def prepare_image(
    path: str | Path,
    *,
    workspace: Workspace,
    max_side: int = DEFAULT_MAX_SIDE,
    fmt: str = "jpeg",
    quality: int = 88,
    grayscale: bool = False,
    autocontrast: bool = True,
    max_bytes: int = DEFAULT_MAX_BYTES,
    min_side: int = DEFAULT_MIN_SIDE,
    allow_small: bool = True,
    out_name: str | None = None,
    inline: bool = False,
    allow_external: bool = True,
) -> dict[str, Any]:
    """Normalise a picture and write the copy into the workspace.

    With Pillow: EXIF-rotate, optionally grayscale and autocontrast (a scanned
    drawing is usually low-contrast grey-on-grey), fit inside ``max_side`` with
    Lanczos, and re-encode. Without Pillow: copy the bytes unchanged and say so
    in ``steps`` rather than pretending work happened.
    """
    if fmt not in WRITABLE_FORMATS:
        raise InvalidArgument("fmt must be one of %s." % (", ".join(WRITABLE_FORMATS),))
    if not 1 <= int(max_side) <= 8192:
        raise InvalidArgument("max_side must be between 1 and 8192.")
    if not 1 <= int(quality) <= 100:
        raise InvalidArgument("quality must be between 1 and 100.")

    probe = probe_image(
        path,
        allow_external=allow_external,
        workspace=workspace,
        max_bytes=max_bytes,
        min_side=min_side,
        allow_small=allow_small,
    )
    source = Path(probe["path"])
    raw = _read(source, max_bytes)
    steps: list[str] = []
    warnings: list[str] = []

    Image, ImageOps = _pillow()
    out_dir = workspace.root / "images"
    out_dir.mkdir(parents=True, exist_ok=True)

    if Image is None:
        warnings.append("Pillow is unavailable: the file is copied byte-for-byte, no conversion or enhancement was applied.")
        target_name = out_name or ("%s.prepared%s" % (source.stem, source.suffix or ".png"))
        target = out_dir / target_name
        target.write_bytes(raw)
        out_format = probe["format"]
        out_mime = probe["mime"]
        width, height = probe["width"], probe["height"]
    else:
        with Image.open(io.BytesIO(raw)) as opened:
            image = ImageOps.exif_transpose(opened) or opened
            steps.append("read %s %s" % (probe["format"], "%sx%s" % image.size))
            if grayscale:
                image = image.convert("L")
                steps.append("converted to grayscale")
            elif image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
                steps.append("flattened %s to RGB" % opened.mode)
            if autocontrast:
                image = ImageOps.autocontrast(image.convert("L") if image.mode == "L" else image, cutoff=1)
                steps.append("autocontrast(cutoff=1)")
            if max(image.size) > max_side:
                ratio = max_side / float(max(image.size))
                new_size = (max(1, int(image.size[0] * ratio)), max(1, int(image.size[1] * ratio)))
                image = image.resize(new_size, Image.LANCZOS)
                steps.append("resized to %dx%d (Lanczos)" % new_size)
            else:
                steps.append("kept native size (within %d px)" % max_side)
            width, height = image.size
            buffer = io.BytesIO()
            save_args: dict[str, Any] = {}
            if fmt == "jpeg":
                if image.mode != "RGB":
                    image = image.convert("RGB")
                save_args = {"quality": int(quality), "optimize": True}
            elif fmt == "webp":
                save_args = {"quality": int(quality)}
            image.save(buffer, fmt.upper() if fmt != "jpeg" else "JPEG", **save_args)
            data = buffer.getvalue()
        out_format = fmt
        out_mime = MIME_BY_FORMAT[fmt]
        # 名字里刻意**不带像素尺寸**:实测模型会把 "06_1600.jpg" 里的 1600 当成图纸上的
        # 一个尺寸来问(2026-09-21)。派生文件只标 prepared,不承载任何会被误读的数字。
        target_name = out_name or ("%s.prepared.%s" % (source.stem, "jpg" if fmt == "jpeg" else fmt))
        target = out_dir / target_name
        target.write_bytes(data)
        raw = data

    if min(width or 0, height or 0) < min_side:
        warnings.append("Prepared image is still below the %d px guidance." % min_side)

    payload: dict[str, Any] = {
        "source": str(source),
        "path": workspace.relative(target),
        "absolutePath": str(target),
        "format": out_format,
        "mime": out_mime,
        "width": width,
        "height": height,
        "bytes": len(raw),
        "steps": steps,
        "warnings": warnings,
        "probe": probe,
    }
    if inline:
        payload["dataUrl"] = _to_data_url(raw, out_mime)
    return payload


def data_url_for(path: str | Path, *, max_bytes: int = DEFAULT_MAX_BYTES) -> str:
    """Base64 data URL for an already-prepared file (no conversion)."""
    resolved = Path(path).expanduser()
    raw = _read(resolved, max_bytes)
    head = raw[:64]
    fmt = _sniff_format(head) or resolved.suffix.lstrip(".").lower()
    mime = MIME_BY_FORMAT.get(fmt, "image/png")
    return _to_data_url(raw, mime)


def load_payload(data_url: str, *, max_bytes: int = DEFAULT_MAX_BYTES) -> bytes:
    """Decode a ``data:image/...;base64,`` URL, rejecting anything oversized."""
    text = (data_url or "").strip()
    if "," not in text or not text.lower().startswith("data:"):
        raise InvalidArgument("Expected a data:image/...;base64, URL.")
    header, _, blob = text.partition(",")
    if ";base64" not in header.lower():
        raise InvalidArgument("Only base64-encoded data URLs are accepted.")
    try:
        raw = base64.b64decode(blob, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _err("IMAGE_DECODE_FAILED", "The base64 payload is not decodable: %s" % exc) from exc
    if len(raw) > max_bytes:
        raise _err(
            "IMAGE_TOO_LARGE",
            "Decoded image is %.1f MB, over the %.1f MB limit." % (len(raw) / 1048576.0, max_bytes / 1048576.0),
            maxBytes=max_bytes,
        )
    if _sniff_format(raw[:64]) is None:
        raise _err("IMAGE_UNSUPPORTED_FORMAT", "The decoded bytes are not a recognised image.")
    return raw


def save_payload(
    data_url: str,
    *,
    workspace: Workspace,
    name: str = "pasted",
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> dict[str, Any]:
    """Persist a pasted/dropped data URL into the workspace and probe it."""
    raw = load_payload(data_url, max_bytes=max_bytes)
    fmt = _sniff_format(raw[:64]) or "png"
    safe = "".join(ch for ch in os.path.basename(name) if ch.isalnum() or ch in "-_.") or "pasted"
    if "." not in safe:
        safe = "%s.%s" % (safe, "jpg" if fmt == "jpeg" else fmt)
    target_dir = workspace.root / "images"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / safe
    target.write_bytes(raw)
    probe = probe_image(target, allow_external=False, workspace=workspace, allow_small=True, max_bytes=max_bytes)
    return {"path": workspace.relative(target), "absolutePath": str(target), "bytes": len(raw), "probe": probe}


def workspace_for(root: str | Path | None) -> Workspace:
    """Build the workspace this module writes into."""
    if root is None:
        root = Path(os.path.expanduser("~")) / "NXSkillWorkspace"
    return Workspace(root)
