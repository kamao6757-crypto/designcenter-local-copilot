# 贡献者

## kamao6757-crypto —— 项目作者

需求、方向与全部真机验证。

* 在 `D:\Program Files\Siemens\DC 2606` 里发现内置的 Copilot 页面,定位到宿主桥协议与
  `UG_APP_COPILOT` 的授权门禁 —— 本项目的起点
* 拍板核心路线:不修官方按钮,而是**换掉内置后端、接自己的模型,并集成 nx-skill 让它真能建模**
* 定下产品行为:复核队列的手动/自动门禁划分、"出完计划直接载入"、"载入后在当前 NX 会话执行"、
  "生成时要有思考链"、"关软件后清理临时数据"、以及清理策略必须保守(不能删掉未执行的计划)
* 立项并维护 **nx-skill**(本仓库子项目)与 NXMCP
* 提供并验证全部真机环境:Designcenter 2606、NXOpen、.NET 实时桥

## DeepSeek Harness —— AI 编程代理

以结对方式实现了本仓库绝大部分代码与文档。

**宿主(`plchat-local/`)**

* `host-stub.js` —— 替代 Designcenter 的 WebView2 宿主桥,接管 `InitPLChat` / `GetAnswer`
* `server.js` —— 零依赖宿主后端:多供应商接入、流式回答、工具调用循环
* `settings.js` —— 页面内 ⚙ 面板(模型 / 复核队列 / nx-skill)与进度浮层

**工具调用与提示工程**

* 工具循环加固:限次收敛、文本形式 `tool_calls` 抢救、最终兜底轮、逐工具额度
* 静态门禁:Python 语法检查 + NXOpen 名字存在性校验(15 万条离线索引)
* 把实测的 NXOpen 写法固化进生成样例,使一份计划从 **325 秒 / 3 次尝试**降到 **28 秒 / 1 次**

**前端重建与集成**

* `fetch-frontend.sh` —— 从本机已授权安装 + CDN 重建官方前端,自动打三处必要补丁,
  并做到**字节级可复现**(md5 校验通过)
* `nx-skill` 侧:菜单/工具条、`.tbr` 关键字顺序修复、.NET 实时桥 `127.0.0.1` 补丁
* 本 README、`nx-skill/docs/` 中的排障记录、以及全部踩坑归档

**读图输入(2026-09-21)**

把一张图纸截图、实物照片或参考图变成能建模的输入。设计上的分工是刻意的:
**NX 只负责选图,Node 只负责搬运,Python 负责读图,模型负责理解** —— 因为
`NXBIN/python` 既没有 pip 也没有 site-packages,第三方图像库根本装不进 NX。

* `nx-skill/src/nx_skill/images.py` —— 探测 / 测量 / 预处理,核心是手工解析
  PNG·JPEG·GIF·BMP·WebP·TIFF 头部(**纯标准库**),Pillow 与 numpy 只作为可选升级,
  import 全部包在 `try/except` 里,并有 `test_optional_image_imports_are_guarded` 守着这个形状
* 新增工具:`nx_image_capabilities` / `nx_image_read` / `nx_image_prepare`(MCP),
  `nx-skill image caps|read|prepare`(CLI,信封与 MCP 一致)
* `nx_runtime/application/read_drawing.py` + 菜单/按钮/工具条 —— NX 里
  **`NX Skill → Read Drawing...`(`Ctrl+Alt+Shift+I`)**:NX 自带文件选择框
  (`Ui.CreateFilebox`,原型取自本机 `UGOPEN/uf_ui.h`),失败退 `tkinter.filedialog`
* 宿主侧读图管线:选图 → 预处理(旋正/灰度/自动对比/Lanczos/重编码)→ 结构化简报
  (含 16×16 墨迹图) → **能看图的供应商走 `image_url` 多模态,不能看图的把简报当文本附上,
  并明说「这不是你看到的像素」**。没有已知尺寸就不给任何物理尺寸
* 顺带修掉三处实测缺陷:`spawnSync("python")` 没走配置导致脚本预检永远假报「语法有误」;
  DeepSeek 的 DSML 文本形式工具调用既没被执行、又把几千字裸标记漏给用户;
  工具额度中途用完导致 `tool_calls` 配不上 `tool` 回复而被接口 400 拒绝

> **身份说明**:这是 AI 编程代理,不是 GitHub 账号,因此不会出现在 GitHub 的贡献者头像墙里。
> 若希望它出现在那里,需要用某个真实账号的邮箱在提交里加 `Co-Authored-By:` trailer。

---

## 第三方

* `nx-skill/` 是一个独立的 MIT 项目(见 `nx-skill/LICENSE`,`Copyright (c) 2026 nx-skill
  contributors`),由本项目以子项目形式收录。它由更早的 NX Codex 插件 v0.6.0 重写而来。
* 本仓库**不包含**任何西门子代码或资源。官方 Copilot 前端的版权归 Siemens Industry
  Software,由 `plchat-local/fetch-frontend.sh` 在你自己已授权的机器上重建。
