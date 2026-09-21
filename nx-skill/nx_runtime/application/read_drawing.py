"""Pick a drawing or a photo inside NX and hand it to the local Copilot host.

Where this sits in the pipeline
-------------------------------

    NX 菜单 / 工具条
        -> 本脚本:文件对话框选图 -> 只做无依赖的校验(存在/格式/大小/头部尺寸)
        -> POST /api/image/prepare   (宿主 Node)
             -> nx-skill image prepare / read  (宿主 Python, 有 Pillow + numpy)
        -> 简报回显到 NX 信息窗口 + 记给工作台(/api/image/handoff)
        -> 在 NX 内嵌浏览器里打开工作台,图已经挂在输入框上方

为什么不在 NX 里做图像处理:NX 自带解释器只有 NXOpen*.pyd 加一个
Python311.zip,既没有 pip 也没有 site-packages —— Pillow/OpenCV 装不进去。
所以 NX 只负责"选一张图",解码、缩放、增强、测量全部交给宿主解释器。
本脚本仍然复用 nx_skill.images 做头部嗅探(纯标准库,不需要 Pillow),
这样"格式不支持 / 分辨率过低"能在选完的当场就报出来,而不是发出去才发现。

三种取图方式,依次尝试,并且会告诉用户实际用了哪一种:
  1. NX 自带文件选择框 UF_UI_create_filebox(函数原型取自本机
     UGOPEN/uf_ui.h;Python 绑定名经 NXOpen_UF.pyd 核实为 Ui.CreateFilebox)
  2. tkinter.filedialog(NX 2412 的 Python311.zip 里带 tkinter,
     且 NXBIN/python 下有 _tkinter.pyd / tcl86t.dll / tk86t.dll)
  3. 环境变量 NX_SKILL_IMAGE_PATH,或 run_journal 传进来的第一个参数 —— 给
     无人值守/脚本化用,不需要人点。

环境变量:
  NX_SKILL_COPILOT_URL   宿主地址,默认 http://127.0.0.1:8765
  NX_SKILL_IMAGE_PATH    跳过对话框,直接读这个文件
  NX_SKILL_IMAGE_MAXSIDE 送进模型前的最大边长,默认 1600
"""

import json
import os
import sys
import urllib.error
import urllib.request

import NXOpen
import NXOpen.UF

DEFAULT_HOST = "http://127.0.0.1:8765"
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp")
MAX_BYTES = 40 * 1024 * 1024
HTTP_TIMEOUT = 120
FILE_DIALOG_TITLE = "Read image for Copilot"

EXIT_OK = 0
EXIT_CANCELLED = 1
EXIT_BAD_FILE = 2
EXIT_HOST_ERROR = 3


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------


def _host():
    value = os.environ.get("NX_SKILL_COPILOT_URL")
    return (value.strip().rstrip("/") if value and value.strip() else DEFAULT_HOST)


def _image_max_side():
    try:
        return max(320, min(4096, int(os.environ.get("NX_SKILL_IMAGE_MAXSIDE") or 1600)))
    except (TypeError, ValueError):
        return 1600


def _package_src():
    """<package>/src —— 里面有 nx_skill.images(纯标准库,可直接 import)。"""
    application_dir = os.path.dirname(os.path.abspath(__file__))
    runtime_root = os.path.dirname(application_dir)
    package_root = os.path.dirname(runtime_root)
    return os.path.join(package_root, "src")


def _load_images():
    src = _package_src()
    if os.path.isdir(src) and src not in sys.path:
        sys.path.insert(0, src)
    try:
        from nx_skill import images  # noqa: PLC0415 - 故意延迟,缺包时不能拖垮整个脚本

        return images
    except Exception:
        return None


def _sniff_head(path):
    """返回 (格式, 宽, 高);解析不了就给 (None, None, None)。"""
    images = _load_images()
    if images is None:
        return None, None, None
    try:
        with open(path, "rb") as handle:
            head = handle.read(256 * 1024)
        fmt = images._sniff_format(head)
        if fmt is None:
            return None, None, None
        width, height, _dpi = images._SIZERS[fmt](head)
        return fmt, width, height
    except Exception:
        return None, None, None


def _post_json(url, payload, timeout=HTTP_TIMEOUT):
    """POST 一段 JSON,返回 (ok, 解析后的 dict 或错误文本)。"""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return True, json.loads(response.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as exc:
        return False, "宿主返回 HTTP %s:%s" % (exc.code, exc.read()[:300])
    except urllib.error.URLError as exc:
        return False, "连不上本地宿主(%s)。先跑 plchat-local\\start.cmd 或 dc\\autostart-on.cmd。" % exc.reason
    except Exception as exc:  # noqa: BLE001 - 超时/解析都归到这里
        return False, "调用宿主失败:%s" % exc


def _say(session, message):
    session.ListingWindow.WriteLine(message)


def _alert(session, title, lines, kind="Information"):
    """信息窗口 + 消息框。消息框失败也不影响主流程(批处理会话没有窗口)。"""
    for line in lines:
        _say(session, line)
    try:
        dialog_type = getattr(NXOpen.NXMessageBox.DialogType, kind)
        NXOpen.UI.GetUI().NXMessageBox.Show(title, dialog_type, "\n".join(lines))
    except Exception as exc:  # noqa: BLE001
        _say(session, "(消息框不可用:%s,以上内容见信息窗口)" % exc)


# --------------------------------------------------------------------------
# 取图
# --------------------------------------------------------------------------


def _pick_with_nx_dialog(session):
    """NX 自带文件选择框。

    C 原型(本机 UGOPEN/uf_ui.h:2392)是
        UF_UI_create_filebox(prompt, title, filter[MAX_FSPEC_BUFSIZE],
                             default_name, filename[MAX_FSPEC_BUFSIZE], &response)
    NXOpen 的 Python 封装替调用方分配输出缓冲,但不同版本返回的形状不同,所以这里
    按类型识别而不是假定:元组 (文件名, response) / 只回文件名 / 只回 response。
    """
    try:
        ui = NXOpen.UF.UFSession.GetUFSession().Ui
    except Exception as exc:  # noqa: BLE001
        return None, "取不到 UF Ui 会话:%s" % exc

    create = getattr(ui, "CreateFilebox", None)
    if create is None:
        create = getattr(ui, "CreateFileboxWithMultipleFilters", None)
        if create is None:
            return None, "这个 NX 版本没有 Ui.CreateFilebox"

    try:
        result = create("Select a drawing, a photo or a reference image",
                        FILE_DIALOG_TITLE, "*.png", "")
    except Exception as exc:  # noqa: BLE001
        return None, "NX 文件对话框调用失败:%s" % exc

    filename = None
    response = None
    if isinstance(result, (tuple, list)):
        for item in result:
            if isinstance(item, str) and not filename:
                filename = item
            elif isinstance(item, int) and response is None:
                response = item
    elif isinstance(result, str):
        filename = result
    elif isinstance(result, int):
        response = result

    if filename and filename.strip():
        return filename.strip(), None
    if response == 0:
        return None, None            # UF_UI_OK 但没拿到文件名 → 当成取消,不再追问
    return None, "NX 文件对话框没有返回文件名(返回类型 %s)" % type(result).__name__


def _pick_with_tkinter(session):
    """tkinter 版文件对话框。NX 2412 的 Python311.zip 里带 tkinter。"""
    try:
        import tkinter
        from tkinter import filedialog
    except Exception as exc:  # noqa: BLE001
        return None, "tkinter 不可用:%s" % exc

    root = None
    try:
        root = tkinter.Tk()
        root.withdraw()
        try:
            root.attributes("-topmost", True)
        except Exception:  # noqa: BLE001
            pass
        chosen = filedialog.askopenfilename(
            title=FILE_DIALOG_TITLE,
            filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp *.gif *.tif *.tiff *.webp"),
                       ("All files", "*.*")],
        )
        return (chosen or None), None
    except Exception as exc:  # noqa: BLE001
        return None, "tkinter 对话框失败:%s" % exc
    finally:
        if root is not None:
            try:
                root.destroy()
            except Exception:  # noqa: BLE001
                pass


def _pick_from_environment(session, argv):
    """无人值守:环境变量或 run_journal 的第一个参数。"""
    for candidate in ([argv[0]] if argv else []) + [os.environ.get("NX_SKILL_IMAGE_PATH")]:
        if candidate and str(candidate).strip():
            return str(candidate).strip()
    return None


def choose_image(session, argv):
    """依次尝试三种取图方式,返回 (路径 或 None, 说明 或 None)。"""
    forced = _pick_from_environment(session, argv)
    if forced:
        _say(session, "使用指定路径(未弹对话框):" + forced)
        return forced, None

    path, note = _pick_with_nx_dialog(session)
    if path:
        _say(session, "用 NX 文件对话框选了:" + path)
        return path, None
    if note:
        _say(session, "NX 文件对话框不可用 —— " + note)
    else:
        _say(session, "NX 文件对话框已取消。")
        return None, None

    path, note = _pick_with_tkinter(session)
    if path:
        _say(session, "改用 tkinter 对话框选了:" + path)
        return path, None
    _say(session, "tkinter 对话框也没能取到文件:%s" % (note or "已取消"))
    return None, note


# --------------------------------------------------------------------------
# 校验
# --------------------------------------------------------------------------


def validate(path):
    """无依赖的开工前检查:返回 (ok, 说明 或 错误文本, 详情 dict)。"""
    details = {"path": path}
    if not path or not str(path).strip():
        return False, "没有选中任何文件。", details
    if not os.path.exists(path):
        return False, "文件不存在:%s" % path, details
    if os.path.isdir(path):
        return False, "选中的是文件夹,不是文件:%s" % path, details

    size = os.path.getsize(path)
    details["sizeBytes"] = size
    if size == 0:
        return False, "这个文件是空的:%s" % path, details
    if size > MAX_BYTES:
        return False, "文件 %.1f MB,超过 %.0f MB 上限。" % (size / 1048576.0, MAX_BYTES / 1048576.0), details

    suffix = os.path.splitext(path)[1].lower()
    details["extension"] = suffix
    if suffix and suffix not in IMAGE_EXTS:
        return False, ("扩展名 %s 不在支持列表里(%s)。PDF/DWG 请先在外部导出成 PNG。"
                       % (suffix, "/".join(IMAGE_EXTS))), details

    fmt, width, height = _sniff_head(path)
    details["format"] = fmt
    details["width"] = width
    details["height"] = height
    if fmt is None:
        # 头部嗅探失败可能只是缺 nx_skill 包,不直接否决 —— 交给宿主判定。
        details["sniff"] = "unavailable"
        return True, "未能在 NX 侧解析图像头(由宿主判定格式)。", details
    if width and height and min(width, height) < 200:
        return False, ("图像只有 %dx%d px,短边低于 200 px —— 图纸上的尺寸字会读不准。"
                       "建议按 600 dpi 以上重新导出。" % (width, height)), details
    return True, "格式 %s,%dx%d px,%.0f KB。" % (fmt, width, height, size / 1024.0), details


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def _open_page(session):
    """把工作台页面在内嵌浏览器里打开。"""
    url = _host() + "/"
    try:
        NXOpen.UF.UFSession.GetUFSession().Ui.DisplayUrlAndActivate(url)
    except Exception:  # noqa: BLE001
        try:
            NXOpen.UF.UFSession.GetUFSession().Ui.DisplayUrl(url)
        except Exception as exc:  # noqa: BLE001
            _say(session, "打不开内嵌浏览器(%s),请手动访问 %s" % (exc, url))


def main(argv=None):
    argv = list(argv if argv is not None else [])
    session = NXOpen.Session.GetSession()
    session.ListingWindow.Open()
    _say(session, "=" * 68)
    _say(session, "读图建模:选择图纸/照片 -> 本机宿主读图 -> 送进 Copilot")

    path, note = choose_image(session, argv)
    if not path:
        _say(session, "没有选择文件,结束。" + (("说明:" + note) if note else ""))
        return EXIT_CANCELLED

    ok, message, details = validate(path)
    _say(session, "检查:" + message)
    if not ok:
        _alert(session, "读图:文件不可用", [message, "路径:" + path], "Warning")
        return EXIT_BAD_FILE

    max_side = _image_max_side()
    _say(session, "交给宿主读图(最大边长 %d px)……" % max_side)
    ok, payload = _post_json(
        _host() + "/api/image/prepare",
        {"image": {"path": path, "name": os.path.basename(path)}, "options": {"maxSide": max_side}},
    )
    if not ok:
        # 宿主没起来是最常见的一种,单独给一条能照做的建议。
        _alert(session, "读图:宿主未就绪",
               ["连不上本地宿主。", str(payload),
                "先在 plchat-local 目录跑 start.cmd(或 dc\\autostart-on.cmd 装成登录自启),然后重试。"],
               "Error")
        return EXIT_HOST_ERROR

    if not payload.get("ok"):
        hint = payload.get("hint") or "读图失败"
        reason = payload.get("message") or ""
        _alert(session, "读图:" + str(hint), [str(hint), str(reason),
                                             "路径:" + path], "Error")
        return EXIT_BAD_FILE

    prepared = payload.get("prepared") or {}
    brief = payload.get("brief") or {}
    vision = payload.get("vision") or {}
    file_info = brief.get("file") or {}
    measurements = brief.get("measurements") or {}
    scale = brief.get("scale") or {}

    lines = []
    lines.append("图像已读入:%s" % os.path.basename(path))
    lines.append("  像素 %sx%s · %.0f KB · 格式 %s"
                 % (file_info.get("width"), file_info.get("height"),
                    (file_info.get("sizeBytes") or 0) / 1024.0, file_info.get("format")))
    steps = prepared.get("steps") or []
    lines.append("  预处理:%s" % (" → ".join(steps) if steps else "无"))
    if measurements.get("available"):
        lines.append("  墨迹占比 %.4f · 边缘密度 %s" % (measurements.get("inkRatio"), measurements.get("edgeDensity")))
        grid = measurements.get("inkGrid") or []
        if grid:
            lines.append("  版面墨迹图(判断视图与标题栏位置):")
            for index, row in enumerate(grid):
                lines.append("    %02d %s" % (index, row))
    if scale.get("mmPerPixel"):
        lines.append("  比例尺:%s %s/px(来自已知尺寸)" % (scale.get("mmPerPixel"), scale.get("unit")))
    else:
        lines.append("  比例尺:未提供已知尺寸 —— 不要从像素推断物理尺寸。")
    for warning in (payload.get("warnings") or []):
        if warning:
            lines.append("  警告:%s" % warning)
    if vision.get("supported"):
        lines.append("模型能力:可直读图像 —— 工作台会把图按多模态发送。")
    else:
        lines.append("模型能力:%s —— 工作台会把上面的结构化简报当文本发过去。"
                     % ("看图能力未声明" if vision.get("unknown") else "当前模型不能读图"))

    for line in lines:
        _say(session, line)

    # 让工作台在打开时自己把这张图挂上:宿主记住路径,页面读一次就清掉。
    ok_handoff, handoff = _post_json(_host() + "/api/image/handoff",
                                     {"path": prepared.get("absolutePath") or path})
    if ok_handoff and handoff.get("ok"):
        _say(session, "已交接给工作台,正在打开页面……")
    else:
        _say(session, "交接给工作台失败(%s);页面仍会打开,可手动点\"读图\"重选。" % handoff)

    _open_page(session)
    _alert(session, "读图完成", lines[:6] + ["……", "完整简报见信息窗口(Listing Window)。"], "Information")
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
