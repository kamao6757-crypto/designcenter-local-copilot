# 读图输入 · Image input

把一张图纸截图、实物照片或参考图变成 Copilot 能用的东西。

设计上只有一句话：**NX 只负责选图，Node 只负责搬运，Python 负责读图，模型负责理解。**
分工而不是堆在一个地方，是因为三边的能力边界不一样（见「依赖」一节）。

> 面向维护者的实现细节（各层契约、时序、算法与阈值、错误矩阵、性能实测、安全边界）见
> **[image-input-technical.md](image-input-technical.md)**。

---

## 1 · 三处入口，一条管线

| 入口 | 位置 | 取图方式 | 适合 |
|---|---|---|---|
| **NX 菜单** | `NX Skill → Read Drawing...`（`Ctrl+Alt+Shift+I`） | NX 自带文件选择框，失败退 tkinter | 站在 NX 里，手上正开着一张图 |
| **工作台页面** | 输入框下方 `读图` 按钮 / 拖拽 / 粘贴 | 浏览器文件选择（WebView2 与普通浏览器都支持） | 边聊边丢图，或从别处截图 |
| **命令行 / 无人值守** | `nx-skill image read <path>` | 不弹框，直接给路径 | 脚本、批处理、复现问题 |

三条入口最后都汇到同一个 Python 模块 `nx_skill/images.py`。

---

## 2 · 数据流（从读取到 prompt 构造）

### 2.1 工作台页面（带图提问）

```
<input type="file"> ──FileReader──▶ data:image/png;base64,...
        │
        ▼  POST /api/image/prepare  { image:{dataUrl,name}, options:{maxSide} }
┌────────────────────────── 宿主 Node (plchat-local/server.js) ──────────────────────────┐
│ 1. saveDataUrl()            base64 → <工作区>/images/<名字>.png（40 MB 上限）            │
│ 2. nx-skill image prepare   ← Python，Pillow：EXIF 旋正 → 灰度 → 自动对比 → Lanczos     │
│                             缩到 maxSide → 重新编码 JPEG/PNG/WebP → 写回工作区 → data URL │
│ 3. nx-skill image read      ← 头部解析 + numpy 测量 → 画幅/墨迹占比/边缘密度/16×16 墨迹图 │
│ 4. imageBriefText()         把上面的测量拼成一段给模型读的文本（含比例尺声明）            │
└────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼  POST /api/ask  { question, image:{path}, history }
   buildUserContent(question, provider, image)
        │
        ├── provider.vision === true  ──▶ [{type:"text",text:q+brief},
        │                                   {type:"image_url",image_url:{url:"data:image/...",detail:"high"}}]
        └── 否则（false / null）      ──▶ q + "（当前模型不能读图，以下是本机图像管线读出的结构化简报。）" + brief
```

### 2.2 NX 菜单

```
NX Skill → Read Drawing...  (Ctrl+Alt+Shift+I)
      │
      ├─ 1. 取图：Ui.CreateFilebox → tkinter.filedialog → $NX_SKILL_IMAGE_PATH / 脚本参数
      ├─ 2. 校验：存在？是文件？≤40 MB？扩展名在白名单？头部嗅探格式与像素、短边 ≥200？
      │         （这一步用 nx_skill.images 的纯标准库部分，NX 里不需要 Pillow）
      ├─ 3. POST /api/image/prepare  → 宿主读图（同上 2~4 步），简报回传
      ├─ 4. 简报写进 NX 信息窗口（Listing Window）+ 消息框摘要
      ├─ 5. POST /api/image/handoff  → 宿主记住这张图
      └─ 6. UF_UI_display_url 打开工作台页面；页面加载时 GET /api/image/handoff 把图挂上
```

### 2.3 送进模型的实际文本长这样

```
【图像输入 · 由本机图像管线读出,不是模型看到的像素】
- 文件:法兰盘.png / png / 1600x1131 px / 12 KB / 1.81 MP / 宽高比 1.4147
- 预处理:images/法兰盘.prepared.jpg(已 read png 1600x1131 → converted to grayscale → autocontrast(cutoff=1) → resized to 1600x1131 (Lanczos))
- 墨迹占比 0.0205,边缘密度 1.458,灰度均值 249.77/标准差 36.1
- 版面墨迹图(16x16,`.`几乎空白 / `o`有线条 / `#`密集 —— 用来判断视图与标题栏位置):
    00 oooooooooooooooo
    01 o..............o
    ...
    13 o..........ooooo
- 比例尺:**没有**。呼叫方没给已知尺寸,所以不要推断任何物理尺寸。

要求:先确认投影角(第一/第三角)再读视图;尺寸以图上的标注文字为准,不要量线长当尺寸;
读不出来或不确定的尺寸,要在 NX 里做成可编辑表达式,而不是猜一个数。
```

比例尺这一栏是刻意的：**没有已知尺寸就不给任何物理尺寸**。要开这个口子，
调用方得显式给 `known_dimension`：

```jsonc
{ "known_dimension": { "pixels": 600, "value": 600.0, "unit": "mm" } }
// → scale: { mmPerPixel: 1.0, unit: "mm", uncertainty: "±1 px ..." }
```

### 2.5 一发即摘（默认）

图**只跟一条消息走**：发出去，待发送区立刻清空。

- 默认开：`config.json` 的 `imageOneShot`（缺省 `true`）；宿主在 `/api/settings` 里把它交给页面，
  页面的 `state.imageOneShot` 以它为准。
- 想连问同一张图就把它设成 `false`，那时图留在待发送区，下一条消息会**再带一次**（也再算一次图像费）。
- **发送失败不会吃掉图**：请求抛错时把附件放回待发送区并记一行日志，主人直接重试即可 ——
  不能让人白选一次。

这条默认来自实测：主人在三轮里每轮都手动点 × 把图摘掉。既然每次都要点，那就别让人点。

### 2.4 派生文件的命名

预处理结果一律叫 `<原名>.prepared.<ext>`，**名字里不带像素数**。原先叫
`06_1600.jpg`（1600 是缩放上限），实测模型会把这个 1600 当成图纸上的一个尺寸来问
（2026-09-21：「文件名 `06_1600` 里的 1600 是不是某处尺寸？」）—— 派生文件不该承载
任何会被误读成数据的数字。同一个源反复预处理会覆盖同名文件，也不会再堆出一串
`06_1600_1600.jpg`。

---

## 3 · 文件选择对话框：两种集成方式

### 3.1 NX 自带文件框（首选）

用的是 `UF_UI_create_filebox`。函数原型取自**本机** `UGOPEN/uf_ui.h:2392`：

```c
int UF_UI_create_filebox(
    char *prompt_string, char *title_string,
    char filter_string[MAX_FSPEC_BUFSIZE] /*I/O*/, char *default_name,
    char filename[MAX_FSPEC_BUFSIZE]      /*<O>*/, int *response /*<O>*/ );
```

Python 绑定名在 `NXBIN/python/NXOpen_UF.pyd` 里核实过是 `Ui.CreateFilebox`
（同文件里还有 `CreateFileboxWithMultipleFilters`；**没有** `CreateFileDialog` 这个名字，
按那个名字写会 AttributeError）。因为不同版本返回的形状不同，`read_drawing.py`
按类型识别而不是假定：元组 `(文件名, response)`、只回文件名、只回 response 三种都接得住。

### 3.2 tkinter（退路，已验证可用）

NX 2412 的嵌入式 CPython 是 3.11，`NXBIN/python/Python311.zip` 里**带 tkinter**，
同目录还有 `_tkinter.pyd` / `tcl86t.dll` / `tk86t.dll`，所以：

```python
import tkinter
from tkinter import filedialog
root = tkinter.Tk(); root.withdraw()
path = filedialog.askopenfilename(title="Read image for Copilot",
                                  filetypes=[("Images", "*.png *.jpg *.jpeg *.bmp *.gif *.tif *.tiff *.webp")])
```

不需要装任何东西，也不需要 NXOpen。

### 3.3 WinForms：**这条路在本机行不通**

NX 自带解释器里**没有 pythonnet/clr**（`NXBIN/python` 下只有 `NXOpen*.pyd` 与标准库 zip，
没有 `clr`、没有 `site-packages`、没有 `pip`），所以 `import clr` 用不了，WinForms
文件对话框无从谈起。要在 NX 里做真正的自定义对话框，正确做法是 **Block UI Styler**：

- 本仓库已有先例：`nx_runtime/application/nx_review_executor.dlx` 就是 Block UI 对话框，
  由 `scripts/generate_review_dialog.py` 生成；
- 加一个「读图」对话框的话，按同一模式加一个 `.dlx`（块类型用 File Selection / 或
  String 块 + 浏览按钮），`ACTIONS` 指向本脚本即可；
- 本轮**没有**做这个对话框：项目里已经有现成的 `nx_review_executor.dlx` 生成流程，
  多一个 `.dlx` 属于 UI 工程量，收益不如先把管线打通；`read_drawing.py` 的取图部分
  已经抽成 `choose_image()`，将来换成 Block UI 只改那一个函数。

> NX 里的 `.dlx` 是**生成物**不是手写文件，改 UI 请改生成脚本。

### 3.4 无人值守

```bash
# 环境变量
set NX_SKILL_IMAGE_PATH=D:\drawings\法兰盘.png
# 或 run_journal 传参
nx-skill journal run <journal> --arg D:\drawings\法兰盘.png
```

给了路径就不弹任何对话框。

---

## 4 · 错误处理

所有失败都走包内统一的信封，`error.code` 是稳定的，宿主再翻成人话。
完整码表见 `nx_skill.images.ERROR_CODES`。

| 场景 | code | 判定处 | 用户看到 | 建议动作 |
|---|---|---|---|---|
| 文件不存在 / 是目录 | `IMAGE_NOT_FOUND` | `images.probe_image` | 「找不到这个图像文件」 | 检查路径或重选 |
| 扩展名不在白名单 | `IMAGE_UNSUPPORTED_FORMAT` | `read_drawing.validate`（NX 侧先拦） | 列出支持的扩展名 | PDF/DWG 先导出 PNG |
| 内容不是图像（改了后缀的文本） | `IMAGE_UNSUPPORTED_FORMAT` | `_sniff_format`（按魔数，不认后缀） | 同上 + 前 8 字节 | — |
| 文件为空 | `IMAGE_DECODE_FAILED` | `probe_image` | 「文件是空的」 | — |
| 超过 40 MB | `IMAGE_TOO_LARGE` | `probe_image` / `load_payload` | 实际大小与上限 | 提高 `max_bytes` 或先降采样 |
| 短边 < 200 px | `IMAGE_TOO_SMALL` | `probe_image` | 「分辨率过低，尺寸字会读不准」 | 按 600 dpi 重出图；确实要过就 `allowSmall: true`（会带警告继续） |
| 头部解析不出尺寸 | 不报错，进 `warnings` | `probe_image` | 警告一行 | 交给宿主判定 |
| 宿主没起来 | 不是图片错误，是连接错误 | `_post_json` 的 `URLError` | 「连不上本地宿主」+ 怎么起 | 跑 `plchat-local\start.cmd` |
| **AI 调用超时** | `meta.error = "LLM_TIMEOUT"` | `AbortSignal.timeout(cfg.llmTimeoutMs)` | 「模型调用超时（超过 N 秒未返回）」 | 调大 `llmTimeoutMs`，或换更小/更快的模型 |
| 模型把工具调用写成正文（DSML） | — | `parseTextToolCalls` 兜底解析 | 无感（工具真的执行了） | — |
| 工具额度中途用完 | — | `repairToolPairing` | 无感 | — |

两个**实测踩到的**坑，都已经写进代码注释与自测：

1. **`python` 不在 PATH 时脚本预检假报错**：`server.js` 里两处 `spawnSync("python", …)`
   没走配置。本机 `python` 是 WindowsApps 的执行别名（退出码 9009、stderr 为空），
   于是每个脚本都被判「语法有误」而且**错误信息是空的**。已改成读 `cfg.python`。
2. **DSML 文本形式工具调用**：带图提问时 `deepseek-chat` 会把整段工具调用写进
   `content`（全角竖线包起来的 DSML 标记），不是 `tool_calls` 字段。不认它的后果是双重的
   —— 工具没执行，而且几千字裸标记原样漏给用户。现在既解析也清理，
   自测在 `plchat-local/tools/test-tool-markup.js`（17 项）。

---

## 5 · 依赖与安装

### 5.1 谁需要什么

| 解释器 | Pillow | numpy | 说明 |
|---|---|---|---|
| **宿主**（`config.json` 的 `python`，本机 `D:\ai\nx\venv\Scripts\python.exe`） | ✅ 12.3.0 | ✅ 2.5.3 | 全部读图能力在这里 |
| **NX 内嵌**（`NXBIN/python`） | ❌ | ❌ | 只有标准库 + NXOpen，**故意不依赖第三方** |

所以 `nx_skill.images` 的写法是：核心用 `struct`/`binascii` 手工解析头部（PNG IHDR/pHYs、
JPEG SOFn/JFIF、GIF、BMP、WebP、TIFF），Pillow/numpy 只在**能 import 到的时候**升级能力，
import 全部包在 `try/except` 里 —— 包内有一条测试专门守这个形状
（`tests/test_packaging.py::test_optional_image_imports_are_guarded`）。

### 5.2 装法

```bash
# 宿主解释器（读图的实际执行者）—— 必需
D:\ai\nx\venv\Scripts\python.exe -m pip install pillow numpy

# 可选：OpenCV，只有在你要做「去倾斜 / 直线检测 / 自动找图框」时才需要
D:\ai\nx\venv\Scripts\python.exe -m pip install opencv-python-headless
#   opencv-python-headless 不带 GUI 依赖，比 opencv-python 小一半，本用途不需要 imshow

# 可选：trimesh —— 与本模块无关，只有当你还要读 3D 网格（STL/OBJ）时
D:\ai\nx\venv\Scripts\python.exe -m pip install trimesh numpy
```

**千万不要往 NX 装**：`NXBIN/python` 下没有 `pip`、没有 `site-packages`、也没有 `Lib`，
`ensurepip` 装了也缺 `Lib` 目录；往那儿塞库会连带影响 NX 自己的解释器。
NX 侧永远只做「选文件 + 无依赖校验」，重活交给宿主。

自检：

```bash
nx-skill image caps
# {"pillow":"12.3.0","numpy":"2.5.3","pillowAvailable":true,"numpyAvailable":true,
#  "canConvert":true,"canResize":true,"canMeasure":true,...}
```

Pillow 缺席时不会崩：`prepare` 会把文件原样拷进工作区，并在返回的 `steps` 里写明
「no conversion or enhancement was applied」——**不会假装处理过**。

---

## 6 · 接口一览

### MCP 工具（`mcp__nxskill__*`）

| 工具 | 作用 |
|---|---|
| `nx_image_capabilities` | 这个解释器能不能读图、工作区在哪、尺寸格式上限。承诺之前先问它 |
| `nx_image_read` | 读一张图：文件事实 + 像素测量 + 16×16 墨迹图 + （给已知尺寸时的）比例尺；`inline=true` 还会给 data URL |
| `nx_image_prepare` | 规范化一张图并写进工作区；接受 `path` 或 `data_url` |

### HTTP（宿主）

| 端点 | 说明 |
|---|---|
| `POST /api/image/prepare` | `{image:{path}\|{dataUrl,name}, options:{maxSide,grayscale,fmt}}` → 预处理结果 + 简报 + 预览 data URL + vision 判定 |
| `POST /api/ask` | 新增可选字段 `image:{path}\|{dataUrl,name}`；响应 `meta.image.route ∈ {vision, brief}` |
| `POST /api/image/handoff` | NX 菜单把选好的图交给工作台（内存里存一张，10 分钟过期） |
| `GET  /api/image/handoff` | 工作台取走（**取一次就清空**，免得刷新反复挂同一张） |

### CLI

```bash
nx-skill image caps
nx-skill image read  <path> [--known-pixels 600 --known-value 600 --known-unit mm] [--inline] [--allow-small]
nx-skill image prepare <path> [--max-side 1600] [--fmt jpeg] [--grayscale] [--inline]
```

三条命令打印的信封与 MCP 工具完全一致 —— 人手复现 agent 做过的事，不用猜。

---

## 7 · 已验证 / 未验证

**已验证（2026-09-21，本机）**

- `tests/test_images.py` 21 项全过（头部解析、后缀与实际格式不符、四种错误码、
  工作区边界、比例尺换算、Lanczos 缩放、base64 往返、非法参数）；
- `nx-skill` 全仓 229 项测试全过（含新增的 `test_optional_image_imports_are_guarded`）；
- `plchat-local/tools/test-tool-markup.js` 20 项全过；
- 端到端一次真跑（`deepseek-flash`，route=`brief`）：模型正确读出了
  `1600×1131 px`、墨迹占比、墨迹图里图框/标题栏的位置，并且**明确拒绝在缺少标注与比例尺时
  编造尺寸**；
- **多模态路径已实测**：把 `vision` 打开、模型换成 `deepseek-flash`
  （DeepSeek V4.1 Flash，2026-09-10 起原生多模态，见
  [官方发布说明](https://api-docs.deepseek.com/zh-cn/news/news260910)），拿一张真实三视图
  （643×960，图上标注 9/6/4/1 与 8/4/2）提问，`meta.image.route` 变成 `vision`，
  模型**逐条念对了全部标注数字**，还自己判定了第一角投影、算出棱台拔锥角 33.69°。

**未验证**

- NX 里的 `NX Skill → Read Drawing...` 菜单项与文件对话框：脚本语法与所用 API 都已核对
  （`uf_ui.h` 原型 + `NXOpen_UF.pyd` 成员名 + 嵌 python 的 tkinter 存在性），
  **但没有在活的 NX 会话里点过一次** —— 这一条要你点一次才能算数；
- Block UI 版对话框没做（见 3.3）。
