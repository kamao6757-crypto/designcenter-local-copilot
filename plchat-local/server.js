/* server.js — Designcenter Copilot 本地宿主
 *
 *  角色:
 *   1) 静态托管官方内置 Copilot 页面(plchat_v2 本地镜像)
 *   2) /api/ask              聊天页后端:多供应商大模型 + nx-skill function calling
 *   3) /api/settings[...]    页面内设置面板的后端(多供应商切换/测试)
 *   4) /api/tools, /api/tool 工具直调(调试)
 *   5) /mock/v1/chat/...     伪 OpenAI 接口,无模型时自测工具闭环
 *
 * 零依赖(Node 内置模块)。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const { spawn } = require("child_process");
const { checkBuilderBooleanMembers } = require("./tools/nxopen-builder-check");
const nxdetect = require("./nxdetect");

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const CFG_PATH = path.join(ROOT, "config.json");

/* ------------------------------------------------------------------ *
 * 配置:多供应商
 * ------------------------------------------------------------------ */
const PRESETS = {
  "mimo-tokenplan": { label: "小米 MiMo(Token Plan)", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", model: "mimo-v2.5", models: ["mimo-v2.5", "mimo-v2.5-pro"], vision: true },
  "mimo":           { label: "小米 MiMo(标准 sk-)",  baseUrl: "https://api.xiaomimimo.com/v1",        model: "mimo-v2.5", models: ["mimo-v2.5", "mimo-v2.5-pro"], vision: true },
  // DeepSeek：V4.1-Flash(模型名 deepseek-flash，2026-09-10 起)是原生多模态，
  // 图直接进 user 消息的 content 数组；旧的 deepseek-chat / deepseek-reasoner
  // 名字仍能调，但不吃图。老名字 deepseek-v4-flash / -vision-exp 一律路由到 V4.1 Flash。
  "deepseek":       { label: "DeepSeek",              baseUrl: "https://api.deepseek.com/v1",          model: "deepseek-flash", models: ["deepseek-flash", "deepseek-v4-pro"], vision: true },
  "openai":         { label: "OpenAI",                baseUrl: "https://api.openai.com/v1",            model: "gpt-4o-mini", models: ["gpt-4o-mini", "gpt-4o"], vision: true },
  "ollama":         { label: "Ollama(本地)",          baseUrl: "http://127.0.0.1:11434/v1",            model: "qwen2.5:7b", models: ["qwen2.5:7b", "qwen2.5:14b"], vision: false },
  "lmstudio":       { label: "LM Studio(本地)",       baseUrl: "http://127.0.0.1:1234/v1",             model: "local-model", models: [], vision: null },
  "mock":           { label: "内置自测(mock)",        baseUrl: "http://127.0.0.1:8765/mock/v1",        model: "mock-model", models: ["mock-model"], vision: false },
  "custom":         { label: "自定义(OpenAI 兼容)",   baseUrl: "",                                     model: "", models: [], vision: null }
};

const DEFAULT_SYS = "你是 Siemens Designcenter / NX 的 CAD 助手,用简体中文回答,给可直接照做的步骤。" +
  "涉及本机 NX 环境或 NXOpen API 时,先用工具查证再回答,不要凭记忆猜 API 名。" +
  "涉及当前打开的零件、已有特征或执行后的结果时,先用 nx_live_status 读取;桥离线或字段不可用时明确说无法核实,不要编造模型状态。" +
  "当用户要一份建模计划时,用 nx_route_intent + nx_modeling_plan 产出分阶段计划,不要只有一步。" +
  "当用户明确表示要把它拿到 NX 里执行时,调用 nx_review_submit 提交计划:步骤名用 NN_Short_Action_Object 编号;" +
  "CAE 求解、保存、导出、布尔、删除、批量改特征这类破坏性步骤一律 gate=manual,参考几何/草图/基本体可用 gate=auto。" +
  "当计划需要 journal 步骤时,你必须自己写出完整的 NXOpen Python 脚本放进 script 字段:脚本必须包含 def main(): ... 以及 if __name__ == '__main__': main() 的入口(执行器用 runpy 以 __main__ 运行它);不要用 f-string(内嵌解释器可能是 Python 2.7),不要依赖第三方库,导入要写全:import NXOpen 不会带出子模块,用到 NXOpen.Features.X / NXOpen.GeometricUtilities.X 就必须显式 import NXOpen.Features / import NXOpen.GeometricUtilities(漏了它,NX 只会说'无法执行 python 脚本');操作当前工作零件(session.Parts.Work),不要调用 Save/Export(那是单独的 manual 步骤);不要自己调用 SetUndoMark / UndoToMark(执行器已为每步建撤销标记);每个提交的对象按 NN_Short_Action_Object 命名,让部件导航器读起来是有序历史;写之前先用 nx_docs_search / nx_docs_member 核对 API 名称与签名,不要凭记忆写;params.path 用形如 02_FLANGE_Bolt_Holes.py 的文件名并与步骤名对应;脚本要短小、单步可诊断。" +
  "提交后告诉用户去 Designcenter 里点 NX Skill → Review Plan 逐步执行。绝对不要声称你已经执行或已经改动模型。执行后再次读取状态,仅在实际证据支持时报告结果。";

function loadRaw() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, "utf8")); } catch (e) { return {}; }
}

/** 兼容旧版扁平配置 -> 新版多供应商结构 */
function loadConfig() {
  const raw = loadRaw();
  const cfg = {
    activeProvider: raw.activeProvider || "mock",
    providers: Object.assign({}, raw.providers),
    systemPrompt: raw.systemPrompt || DEFAULT_SYS,
    nxSkillRoot: raw.nxSkillRoot || "",
    nxRoot: raw.nxRoot || "",
    nxWorkspace: raw.nxWorkspace || "",
    python: raw.python || "python",
    toolTimeoutMs: raw.toolTimeoutMs || 60000,
    maxToolRounds: raw.maxToolRounds || 8,
    maxToolCalls: Number(raw.maxToolCalls) || 14,
    cleanupOnNxExit: ["all", "scratch", "smart", "off"].includes(raw.cleanupOnNxExit) ? raw.cleanupOnNxExit : "all",
    // 「一发即摘」:图只跟一条消息走,发出去就把待发送区腾空。默认开 —— 实测里主人
    // 每轮都手动点 × 摘掉,那就别让人点。想连问同一张图,把它设成 false 即可。
    imageOneShot: raw.imageOneShot !== false,
    imageMaxSide: Number(raw.imageMaxSide) || 1600,
    colorTheme: raw.colorTheme || "light",
    locale: raw.locale || "en_US",
    version: raw.version || ""            // 空 = 用检测到的 release(不再写死 2606.1700)
  };
  // 旧版:顶层 provider/baseUrl/apiKey/model
  if (!Object.keys(cfg.providers).length && (raw.baseUrl || raw.provider)) {
    cfg.providers[raw.provider || "custom"] = {
      baseUrl: raw.baseUrl || "", apiKey: raw.apiKey || "", model: raw.model || ""
    };
    cfg.activeProvider = raw.provider || "custom";
  }
  // 保证每个 preset 都存在(便于面板里切换)
  for (const [id, p] of Object.entries(PRESETS)) {
    if (!cfg.providers[id]) cfg.providers[id] = { baseUrl: p.baseUrl, apiKey: "", model: p.model };
  }
  return cfg;
}

function saveConfig(cfg) {
  // 保留 loadConfig 未映射的配置项,例如退出 NX 时的清理策略。
  fs.writeFileSync(CFG_PATH, JSON.stringify(Object.assign({}, loadRaw(), cfg), null, 2));
}

/** 取当前生效的供应商参数 */
function active(cfg) {
  const id = cfg.activeProvider;
  const p = cfg.providers[id] || {};
  const preset = PRESETS[id] || {};
  return {
    id,
    label: preset.label || id,
    baseUrl: (p.baseUrl || preset.baseUrl || "").replace(/\/+$/, ""),
    apiKey: p.apiKey || "",
    model: p.model || preset.model || "",
    // 三态:true 确定能看图,false 确定不能,null 不确定。
    // 配置里显式写 providers.<id>.vision 就覆盖预设 —— 换了个多模态模型时不必改代码。
    vision: typeof p.vision === "boolean" ? p.vision : (preset.vision === undefined ? null : preset.vision)
  };
}

/* ------------------------------------------------------------------ *
 * 本机安装识别 —— 不写死版本号
 * 内置 Copilot 不由版本号决定,而由"这个安装里有没有那套页面和 AI 库"决定,
 * 所以这里按结构特征找安装、判断能力:2606 / 2506 / 2406 / 2306 一视同仁。
 * 实现见 nxdetect.js(零依赖);结果缓存 60s,避免每个请求都扫盘。
 * ------------------------------------------------------------------ */
let NX_INFO = { at: 0, want: null, versions: false, data: null };
function nxInstall(cfg, force, withVersions) {
  const want = (cfg && cfg.nxRoot) || "";
  const versions = !!withVersions;
  const fresh = NX_INFO.data && (Date.now() - NX_INFO.at) < 60000 &&
    NX_INFO.want === want && NX_INFO.versions === versions;
  if (fresh && !force) return NX_INFO.data;
  const opts = { versions };
  const all = nxdetect.detectAll(opts);
  const active = nxdetect.pick(want, opts);
  NX_INFO = { at: Date.now(), want, versions, data: { active, all } };
  return NX_INFO.data;
}
/** 给界面/页面用的精简结构 */
function nxInfo(cfg, force, withVersions) {
  const { active, all } = nxInstall(cfg, force, withVersions);
  return {
    active: active ? {
      root: active.root, release: active.release, version: active.version || "",
      product: active.product || "", source: active.source,
      hasCopilot: active.hasCopilot, ugraf: active.ugraf,
      copilot: {
        page: active.copilot.page, scriptsDir: active.copilot.scriptsDir,
        libs: active.copilot.libs, markers: active.copilot.markers
      }
    } : null,
    installations: all.map(p => ({
      root: p.root, release: p.release, product: p.product || "", source: p.source,
      hasCopilot: p.hasCopilot, page: p.copilot.page, libCount: p.copilot.libs.length
    }))
  };
}
/** plservice-version:配置优先,其次检测到的精确版本(2606.1700),再其次 release,都没有就 unknown */
function pageVersion(cfg) {
  if (cfg && cfg.version) return cfg.version;
  const info = nxInfo(cfg, false, true);      // 只有这条路需要翻卸载登记表拿精确版本
  const a = info.active;
  return (a && (a.version || a.release)) || "unknown";
}

/* ------------------------------------------------------------------ *
 * 自动执行:把整份计划交给一次 headless NX 跑完(不需要人一步步点)
 * 说明:这走的是 run_journal 批处理,不是 Review 对话框 —— 因为"无人点击"
 * 就意味着不能依赖 NX 主线程 + 人工节拍。代价是看不到过程。
 * ------------------------------------------------------------------ */
function buildDriver(plan, cfg) {
  const ws = cfg.nxWorkspace || "";
  const scripts = path.join(ws, "review", "scripts");
  const parts = path.join(ws, "parts");
  const report = path.join(ws, "review", "run_report.json");
  const part = path.join(parts, "plan_" + (plan.planId || "run") + ".prt");
  const steps = (plan.steps || [])
    .filter(s => s.operation === "journal")
    .map(s => ({ id: s.id, name: s.name, file: path.basename(String((s.params || {}).path || "")) }));
  const src = [
    "# -*- coding: utf-8 -*-",
    "# 由本地宿主自动生成:按顺序执行复核计划里的 journal 步骤",
    "import json",
    "import os",
    "import runpy",
    "import traceback",
    "",
    "import NXOpen",
    "",
    "PART = r" + JSON.stringify(part),
    "SCRIPTS = r" + JSON.stringify(scripts),
    "REPORT = r" + JSON.stringify(report),
    "STEPS = " + JSON.stringify(steps, null, 1),
    "",
    "",
    "def main():",
    "    session = NXOpen.Session.GetSession()",
    "    d = os.path.dirname(PART)",
    "    if d and not os.path.isdir(d):",
    "        os.makedirs(d)",
    "    part = session.Parts.NewDisplay(PART, NXOpen.Part.Units.Millimeters)",
    "    session.Parts.SetWork(part)",
    "    session.Parts.SetDisplay(part, False, False)",
    "    out = []",
    "    for st in STEPS:",
    '        rec = {"id": st["id"], "name": st["name"], "script": st["file"], "status": "pending"}',
    "        try:",
    '            session.SetUndoMark(NXOpen.Session.MarkVisibility.Visible, st["name"])',
    '            runpy.run_path(os.path.join(SCRIPTS, st["file"]), run_name="__main__")',
    '            rec["status"] = "done"',
    "        except Exception as exc:",
    '            rec["status"] = "failed"',
    '            rec["message"] = str(exc)',
    '            rec["traceback"] = traceback.format_exc()[-1200:]',
    "        out.append(rec)",
    "    saved = False",
    "    try:",
    "        part.Save(NXOpen.BasePart.SaveComponents.TrueValue, NXOpen.BasePart.CloseAfterSave.FalseValue)",
    "        saved = True",
    "    except Exception as exc:",
    '        out.append({"id": "save", "name": "save", "status": "failed", "message": str(exc)})',
    '    with open(REPORT, "w") as fh:',
    '        json.dump({"part": PART, "saved": saved, "steps": out}, fh, ensure_ascii=False, indent=1)',
    "",
    "",
    'if __name__ == "__main__":',
    "    main()",
    ""
  ].join("\n");
  return { src, part, report, scriptCount: steps.length };
}

/** live 桥失败时,NX 只说"无法执行 python 脚本,请参见系统日志",信息量为零。
 *  nx-skill 的 payload 会把真正的 traceback 写到 <workspace>/generated/<脚本>.error.txt
 *  (见 nx_runtime/application/nx_run_python_payload.py),这里把它捞出来:
 *  返回最后一行异常 + 出错位置,完整内容仍在那个文件里。 */
function liveErrorDetail(cfg, sinceMs) {
  const dir = path.join(cfg.nxWorkspace || "", "generated");
  try {
    const newest = fs.readdirSync(dir)
      .filter(f => /\.error\.txt$/i.test(f))
      .map(f => ({ p: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter(x => !sinceMs || x.t >= sinceMs - 2000)
      .sort((a, b) => b.t - a.t)[0];
    if (!newest) return "";
    const text = fs.readFileSync(newest.p, "utf8");
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    const where = (text.match(/File "[^"]+", line \d+/g) || []).pop() || "";
    const short = where.replace(/^File "([^"]+)", line (\d+)$/, "$1:$2").replace(/^.*[\\/]/, "");
    return short ? (last + "  (" + short + ")") : last;
  } catch (e) { return ""; }
}

/** 在当前打开的 NX 会话里执行计划(走 live 桥,作用于当前工作零件) */
async function runPlanLive(cfg) {
  const ws = cfg.nxWorkspace || "";
  const planPath = path.join(ws, "review", "plan.json");
  if (!fs.existsSync(planPath)) return { ok: false, error: "队列里没有计划" };
  let plan; try { plan = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch (e) { return { ok: false, error: "plan.json 解析失败" }; }

  const steps = (plan.steps || []).filter(s => s.operation === "journal");
  if (!steps.length) return { ok: false, error: "这份计划没有可执行的 journal 步骤" };
  const runStarted = Date.now();

  progressStart("run", "在当前 NX 会话执行 " + (plan.planId || ""));
  progressStage("ping", "检查 live 桥…");
  const ping = await runNxSkill(cfg, ["live", "ping"], 30000);
  if (!(ping.envelope && ping.envelope.ok)) {
    progressEnd("failed");
    return { ok: false, error: "live 桥没在运行。请在 Designcenter 里点:菜单 NX Skill → Start NX Skill Live Bridge,然后重试。" };
  }

  const out = [];
  for (const s of steps) {
    const base = path.basename(String((s.params || {}).path || ""));
    const f = path.join(ws, "review", "scripts", base);
    if (!base || !fs.existsSync(f)) { out.push({ id: s.id, name: s.name, status: "failed", message: "脚本缺失:" + base }); continue; }
    const src = fs.readFileSync(f, "utf8");
    progressStage("running", "在当前会话执行 " + s.name + " …");
    const r = await runNxSkill(cfg, ["live", "python", "--stage", s.name], cfg.toolTimeoutMs, src);
    const ok = !!(r.envelope && r.envelope.ok);
    let message = ok ? "" : ((r.envelope && r.envelope.error && (r.envelope.error.message || r.envelope.error.error)) || r.stderr || "");
    if (!ok) {
      // NX 对脚本报错只会说"无法执行 python 脚本,请参见系统日志"——把 nx-skill payload
      // 落下的真实 traceback 捞出来,否则用户拿到一句没法用的提示。
      const detail = liveErrorDetail(cfg, runStarted);
      if (detail) message = message.replace(/\s*$/, "") + "  真实原因: " + detail;
    }
    out.push({ id: s.id, name: s.name, script: base, status: ok ? "done" : "failed", ms: r.ms, message });
    console.log("[run-live] " + s.name + " -> " + (ok ? "done" : "failed") + " (" + r.ms + "ms)");
    if (!ok) break;
  }
  progressEnd(out.some(x => x.status === "failed") ? "failed" : "done");
  return { ok: out.every(x => x.status === "done"), mode: "live", steps: out,
           failed: out.filter(x => x.status === "failed").length,
           note: "改动作用在你当前打开并设为工作零件的文件上;脚本不会自动保存,需要保存请手动 Ctrl+S。" };
}

async function runPlanBatch(cfg) {
  const ws = cfg.nxWorkspace || "";
  const planPath = path.join(ws, "review", "plan.json");
  if (!fs.existsSync(planPath)) return { ok: false, error: "队列里没有计划" };
  let plan; try { plan = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch (e) { return { ok: false, error: "plan.json 解析失败" }; }

  const d = buildDriver(plan, cfg);
  if (!d.scriptCount) return { ok: false, error: "这份计划没有可自动执行的 journal 步骤" };

  const missing = [];
  for (const st of plan.steps.filter(x => x.operation === "journal")) {
    const base = path.basename(String((st.params || {}).path || ""));
    if (!base || !fs.existsSync(path.join(ws, "review", "scripts", base))) missing.push(base || st.name);
  }
  if (missing.length) return { ok: false, error: "脚本缺失(可能被清理策略删掉了):" + missing.join(", ") };

  fs.writeFileSync(path.join(ws, "review", "batch_driver.py"), d.src, "utf8");
  try { fs.unlinkSync(d.report); } catch (e) { }

  progressStart("run", "自动执行计划 " + (plan.planId || ""));
  progressStage("running", "headless NX 正在执行 " + d.scriptCount + " 个步骤…");
  const r = await runNxSkill(cfg, ["journal", "run", "review/batch_driver.py", "--timeout", "600"], 660000);
  progressEnd("done");

  let rep = null;
  try { rep = JSON.parse(fs.readFileSync(d.report, "utf8")); } catch (e) { }
  const env = r.envelope || {};
  if (!rep) {
    return { ok: false, error: "NX 没有产出执行报告(run_report.json)。" + (r.stderr || env.error || "").slice(0, 400), raw: env };
  }
  const failed = (rep.steps || []).filter(s => s.status === "failed");
  return {
    ok: failed.length === 0, part: rep.part, saved: rep.saved,
    steps: rep.steps, failed: failed.length, ms: r.ms,
    nxSeconds: (env.result || {}).durationSeconds
  };
}

/* ------------------------------------------------------------------ *
 * 清理:Copilot 集成产生的临时数据
 * 1) scratch —— %TEMP%\nxreview-* 等运行残留(纯垃圾,任何时候都该清)
 * 2) queue   —— 复核队列(plan.json / run.json / scripts / screenshots)
 * 策略由 config.cleanupOnNxExit 决定: "all"(默认) | "scratch" | "off"
 * ------------------------------------------------------------------ */
let LAST_CLEANUP = null;
let JOB_SEQ = 0;
const JOBS = new Map();   // 生成计划的后台任务:POST 起任务,GET 轮询,避免长请求被掐断

function dirSize(p) {
  let total = 0;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    for (const n of fs.readdirSync(p)) total += dirSize(path.join(p, n));
  } catch (e) { }
  return total;
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { return false; } }

function cleanScratch() {
  const rep = { tempDirs: 0, bytes: 0 };
  const tmpRoot = require("os").tmpdir();
  try {
    for (const n of fs.readdirSync(tmpRoot)) {
      if (n.indexOf("nxreview-") !== 0) continue;
      const p = path.join(tmpRoot, n);
      rep.bytes += dirSize(p);
      if (rmrf(p)) rep.tempDirs++;
    }
  } catch (e) { }
  return rep;
}

function cleanQueue(cfg) {
  const ws = cfg.nxWorkspace || "";
  const dir = ws ? path.join(ws, "review") : "";
  const rep = { dir, files: 0, bytes: 0 };
  if (!dir || !fs.existsSync(dir)) return rep;
  for (const sub of ["scripts", "screenshots"]) {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      rep.bytes += dirSize(p);
      if (rmrf(p)) rep.files++;
    }
  }
  for (const f of ["plan.json", "run.json"]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    rep.bytes += dirSize(p);
    if (rmrf(p)) rep.files++;
  }
  return rep;
}

/** smart 策略:队列里还有没跑的步骤就留着,跑完了才清 */
function queueLooksFinished(cfg) {
  const ws = cfg.nxWorkspace || "";
  const planPath = ws ? path.join(ws, "review", "plan.json") : "";
  if (!planPath || !fs.existsSync(planPath)) return true;      // 本来就没计划
  let plan; try { plan = JSON.parse(fs.readFileSync(planPath, "utf8")); } catch (e) { return true; }
  const ids = (plan.steps || []).map(s => s.id);
  const logPath = path.join(path.dirname(planPath), "run.json");
  let log = null; try { log = JSON.parse(fs.readFileSync(logPath, "utf8")); } catch (e) { }
  const done = {};
  const records = log && (Array.isArray(log.steps) ? log.steps : log.records);
  (Array.isArray(records) ? records : []).forEach(r => { done[r.id] = r.status; });
  const pending = ids.filter(id => !done[id] || done[id] === "pending" || done[id] === "running");
  return pending.length === 0;
}

function runCleanup(scope, reason) {
  const cfg = loadConfig();
  if (scope === "smart") {
    const finished = queueLooksFinished(cfg);
    const eff = finished ? "all" : "scratch";
    console.log("[cleanup] smart 策略:队列" + (finished ? "已跑完" : "还有未执行步骤,保留计划与脚本") + " → 实际执行 " + eff);
    scope = eff;
  }
  const out = { at: new Date().toLocaleString("zh-CN"), scope, reason, scratch: null, queue: null };
  if (scope === "scratch" || scope === "all") out.scratch = cleanScratch();
  if (scope === "queue" || scope === "all") out.queue = cleanQueue(cfg);
  LAST_CLEANUP = out;
  console.log("[cleanup] " + reason + " scope=" + scope +
    (out.scratch ? " | 临时目录 " + out.scratch.tempDirs + " 个/" + Math.round(out.scratch.bytes / 1024) + "KB" : "") +
    (out.queue ? " | 队列文件 " + out.queue.files + " 个/" + Math.round(out.queue.bytes / 1024) + "KB" : ""));
  return out;
}

/** Designcenter 是否在运行 */
function nxRunning() {
  try {
    const { spawnSync } = require("child_process");
    const o = spawnSync("tasklist", ["/FI", "IMAGENAME eq ugraf.exe"], { encoding: "utf8", windowsHide: true }).stdout || "";
    return /ugraf\.exe/i.test(o);
  } catch (e) { return false; }
}

/** 盯着 Designcenter 退出,退出后按策略清理 */
let NX_WAS_RUNNING = null;
function startNxExitWatcher() {
  setInterval(() => {
    const now = nxRunning();
    if (NX_WAS_RUNNING === true && now === false) {
      const scope = loadConfig().cleanupOnNxExit || "all";
      if (scope === "off") console.log("[cleanup] Designcenter 已退出,策略为 off,跳过清理");
      else runCleanup(scope, "Designcenter 已退出");
    }
    NX_WAS_RUNNING = now;
  }, 8000);
}

/* ------------------------------------------------------------------ *
 * 进度与思维链
 * 一次提问/生成要几十秒到几分钟,页面上不能只显示"Generating..."。
 * 这里把阶段、工具调用、以及模型的 reasoning_content(思维链)实时暴露出去,
 * 页面轮询 /api/progress 显示,免得用户以为卡死。
 * ------------------------------------------------------------------ */
const PROGRESS = {
  active: false, id: 0, kind: "", question: "", stage: "", detail: "",
  started: 0, updated: 0, attempts: 0, tools: [], reasoning: []
};

function progressStart(kind, question) {
  PROGRESS.active = true;
  PROGRESS.id++;
  PROGRESS.kind = kind;
  PROGRESS.question = String(question || "").slice(0, 200);
  PROGRESS.stage = "thinking";
  PROGRESS.detail = "正在思考…";
  PROGRESS.started = Date.now();
  PROGRESS.updated = Date.now();
  PROGRESS.attempts = 0;
  PROGRESS.tools = [];
  PROGRESS.reasoning = [];
  console.log("[progress] start " + kind + ": " + PROGRESS.question.slice(0, 60));
}
function progressStage(stage, detail) {
  PROGRESS.stage = stage;
  PROGRESS.detail = detail || "";
  PROGRESS.updated = Date.now();
}
/** 追加思维链增量(流式),只保留尾部若干字符 */
function progressReasoningDelta(text) {
  if (!text) return;
  PROGRESS.reasoning.push(text);
  let all = PROGRESS.reasoning.join("");
  if (all.length > 8000) PROGRESS.reasoning = ["…" + all.slice(-7800)];
  PROGRESS.updated = Date.now();
}
function progressReasoning(text) { if (text) progressReasoningDelta(String(text)); }
function progressTool(name, args, res) {
  PROGRESS.tools.push({
    name, args: Object.keys(args || {}).length ? JSON.stringify(args).slice(0, 120) : "",
    ok: !!res.ok, ms: res.ms || 0
  });
  PROGRESS.updated = Date.now();
}
function progressEnd(stage) {
  PROGRESS.active = false;
  PROGRESS.stage = stage || "done";
  PROGRESS.updated = Date.now();
}

/** 读用户级环境变量(注册表),代表"新启动的进程会看到的值" */
function machineEnv(name) {
  try {
    const out = require("child_process").execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], { windowsHide: true }).toString("utf8");
    const m = out.match(/REG_SZ\s+(.+)/);
    return m ? m[1].trim() : "";
  } catch (e) { return ""; }
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png"
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (t) => esc(t).replace(/\r?\n/g, "<br>");
const mask = (k) => (k ? k.slice(0, 5) + "…" + k.slice(-4) : "");

/* ------------------------------------------------------------------ *
 * nx-skill 工具桥
 * ------------------------------------------------------------------ */
function nxEnv(cfg) {
  const e = Object.assign({}, process.env);
  e.PYTHONPATH = cfg.nxSkillRoot ? path.join(cfg.nxSkillRoot, "src") : "src";
  e.PYTHONIOENCODING = "utf-8";
  e.PYTHONUTF8 = "1";
  e.NX_SKILL_SKIP_GLOBAL_SEARCH = "true";
  if (cfg.nxRoot) e.NX_SKILL_NX_ROOT = cfg.nxRoot;              // 本机遗留 NX2512_ROOT 指向不存在的版本
  if (cfg.nxWorkspace) {
    e.NX_SKILL_WORKSPACE = cfg.nxWorkspace;      // 与 NXMCP 隔离
    // live 桥的 C# 客户端用这个变量校验"脚本必须在工程目录下";不设会回退到
    // 遗留的 NX2512_PROJECT_ROOT(=NXMCP),把我们的脚本拒掉
    e.NX_SKILL_PROJECT_ROOT = cfg.nxWorkspace;
  }
  return e;
}

function runNxSkill(cfg, args, timeoutMs, input) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let p;
    try {
      p = spawn(cfg.python || "python", ["-m", "nx_skill", ...args], {
        cwd: cfg.nxSkillRoot || ROOT, env: nxEnv(cfg), windowsHide: true
      });
    } catch (e) { resolve({ code: -1, ms: 0, envelope: null, raw: "", stderr: String(e) }); return; }
    let out = "", err = "";
    const timer = setTimeout(() => { try { p.kill(); } catch (e) { } }, timeoutMs || 60000);
    if (input !== undefined && input !== null) {
      try { p.stdin.write(typeof input === "string" ? input : JSON.stringify(input)); p.stdin.end(); } catch (e) { }
    }
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("close", (code) => {
      clearTimeout(timer);
      let env = null; try { env = JSON.parse(out); } catch (e) { }
      resolve({ code, ms: Date.now() - t0, envelope: env, raw: out.slice(0, 4000), stderr: err.slice(0, 800) });
    });
    p.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, ms: 0, envelope: null, raw: "", stderr: String(e) }); });
  });
}

/* ------------------------------------------------------------------ *
 * 读图管线:文件选择 → 预处理 → 图像简报 → 送进模型
 *
 * 分工是刻意分开的:
 *   · Node 只做搬运 —— 把浏览器上传的 base64 落盘、把路径变成工具参数;
 *   · 真正的解码/缩放/增强/测量放在 Python 侧(nx_skill/images.py),因为
 *     Pillow 与 numpy 装在宿主解释器里,而 NX 自带解释器既没有 pip 也没有
 *     site-packages(实测 NXBIN\python 下只有 NXOpen*.pyd 与 Python311.zip)。
 *   · 送进模型分两条路:能看图的供应商直接附 image_url(base64);不能看图的,
 *     把「图像简报」当文本附上去,并明确告诉它自己看不到图 —— 不假装看过。
 * ------------------------------------------------------------------ */
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"];
const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".bmp": "image/bmp",
  ".gif": "image/gif", ".tif": "image/tiff", ".tiff": "image/tiff", ".webp": "image/webp"
};

// 错误码 → 人话。Python 侧给的是稳定的 code,这里只负责翻成主人看得懂的句子。
const IMAGE_ERROR_TEXT = {
  IMAGE_NOT_FOUND: "找不到这个图像文件",
  IMAGE_UNSUPPORTED_FORMAT: "不是支持的图像格式(支持 PNG/JPG/BMP/GIF/TIFF/WebP)",
  IMAGE_TOO_LARGE: "图像文件太大",
  IMAGE_TOO_SMALL: "图像分辨率过低(短边小于 200 px,图纸上的尺寸字会读不准)",
  IMAGE_DECODE_FAILED: "图像解码失败(文件可能损坏,或扩展名与内容不符)",
  IMAGE_DEPENDENCY_MISSING: "本机 Python 缺少图像处理库(Pillow/numpy)",
  IMAGE_TIMEOUT: "图像处理超时",
  WORKSPACE_VIOLATION: "这个路径在工作区之外,而已被明确禁止",
  INVALID_ARGUMENT: "图像参数不合法"
};

function nxWorkspaceDir(cfg) {
  if (cfg.nxWorkspace) return cfg.nxWorkspace;
  return path.join(require("os").homedir(), "NXSkillWorkspace");
}

/** 跑一次 nx-skill CLI 并解析信封;拿不到信封就抛错,不静默当成功。 */
function nxSkillJson(cfg, args, timeoutMs, input) {
  return runNxSkill(cfg, args, timeoutMs, input).then((r) => {
    if (r.envelope) return r.envelope;
    throw new Error("nx-skill " + args.join(" ") + " 没有返回可解析的结果:" + (r.stderr || r.raw || "exit " + r.code));
  });
}

/** 把浏览器上传的 data URL 落到工作区(工作区外一律不写)。 */
function saveDataUrl(cfg, dataUrl, name) {
  const m = /^data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl || "").trim());
  if (!m) throw new Error("图像数据不是 data:image/...;base64 格式");
  const buf = Buffer.from(m[1].replace(/\s+/g, ""), "base64");
  if (!buf.length) throw new Error("图像数据为空");
  if (buf.length > 40 * 1024 * 1024) throw new Error("图像超过 40 MB 上限(实际 " + (buf.length / 1048576).toFixed(1) + " MB)");
  const safe = (String(name || "pasted").replace(/[^A-Za-z0-9._-]/g, "_") || "pasted").slice(-80);
  const ext = path.extname(safe).toLowerCase();
  const dir = path.join(nxWorkspaceDir(cfg), "images");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, IMAGE_EXTS.includes(ext) ? safe : safe + ".png");
  fs.writeFileSync(target, buf);
  return { path: target, bytes: buf.length };
}

/** 把一条图像简报写成模型读得懂的文本(给看不到图的供应商用)。 */
function imageBriefText(brief, opts) {
  const o = opts || {};
  const f = (brief && brief.file) || {};
  const lines = [];
  lines.push("【图像输入 · 由本机图像管线读出,不是模型看到的像素】");
  lines.push("- 文件:" + (f.fileName || "?") + " / " + (f.format || "?") + " / " + (f.width || "?") + "x" + (f.height || "?")
    + " px / " + ((f.sizeBytes || 0) / 1024).toFixed(0) + " KB"
    + (f.megapixels ? " / " + f.megapixels + " MP" : "")
    + (f.aspect ? " / 宽高比 " + f.aspect : "")
    + (f.dpi ? " / " + Math.round(f.dpi) + " dpi" : ""));
  if (o.prepared) {
    lines.push("- 预处理:" + (o.prepared.path || "") + "(已 " + (o.prepared.steps || []).join(" → ") + ")");
  }
  const m = (brief && brief.measurements) || null;
  if (m && m.available) {
    lines.push("- 墨迹占比 " + m.inkRatio + ",边缘密度 " + m.edgeDensity + ",灰度均值 " + m.meanGray + "/标准差 " + m.stdGray);
    if (Array.isArray(m.inkGrid)) {
      lines.push("- 版面墨迹图(16x16,`.`几乎空白 / `o`有线条 / `#`密集 —— 用来判断视图与标题栏位置):");
      m.inkGrid.forEach((row, i) => lines.push("    " + String(i).padStart(2, "0") + " " + row));
    }
  } else if (m) {
    lines.push("- 量化测量不可用:" + (m.reason || "未知原因"));
  }
  const s = (brief && brief.scale) || null;
  if (s && s.mmPerPixel) {
    lines.push("- 比例尺:" + s.mmPerPixel + " " + s.unit + "/px(来自调用方给的已知尺寸;误差 " + s.uncertainty + ")");
  } else {
    lines.push("- 比例尺:**没有**。呼叫方没给已知尺寸,所以不要推断任何物理尺寸。");
  }
  (f.warnings || []).forEach((w) => lines.push("- 警告:" + w));
  lines.push("");
  lines.push("要求:先确认投影角(第一/第三角)再读视图;尺寸以图上的标注文字为准,不要量线长当尺寸;");
  lines.push("读不出来或不确定的尺寸,要在 NX 里做成可编辑表达式,而不是猜一个数。");
  return lines.join("\n");
}

/**
 * 这个路径是不是「工作区里已经预处理过的图」?
 *
 * 工作台选完图会先调一次 /api/image/prepare 做预览,提问时再把那张**已经处理过**的
 * 文件路径发回来。再预处理一遍纯属浪费 —— 实测会多出一个 06_1600_1600.jpg。
 * 只认工作区 images/ 下的文件,别的地方一律照旧处理。
 */
function preparedWorkspaceImage(cfg, target) {
  try {
    const base = path.resolve(nxWorkspaceDir(cfg), "images");
    const resolved = path.resolve(String(target));
    return resolved.startsWith(base + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  } catch (e) { return false; }
}

/**
 * 一个图像从「用户给的」变成「能送进模型的」。
 * 输入 {path} 或 {dataUrl,name};输出统一信封,失败也返回而不是抛。
 */
async function readImageForModel(cfg, image, opts) {
  const o = opts || {};
  const maxSide = Math.min(4096, Math.max(320, Number(o.maxSide) || 1600));
  const out = { ok: false, code: null, message: null, stored: null, prepared: null, brief: null, dataUrl: null, briefText: null, warnings: [], reused: false };
  try {
    let sourcePath = String((image && image.path) || "").trim();
    if (!sourcePath) {
      if (!image || !image.dataUrl) throw new Error("没有图像:需要 path 或 dataUrl");
      out.stored = saveDataUrl(cfg, image.dataUrl, image.name);
      sourcePath = out.stored.path;
    }
    // 复用要客户端明说(reusePrepared),再叠加「必须落在工作区 images/ 下」这道护栏:
    // 光看路径会误判 —— 工作台把上传的原图也存在同一个目录里。
    const reuse = o.reusePrepared === true && preparedWorkspaceImage(cfg, sourcePath);
    if (reuse) {
      // 复用:只补一次简报,不再转换(省一次 Pillow 往返,也不再产出 *_1600.jpg 这种叠名字)。
      const buffer = fs.readFileSync(sourcePath);
      const ext = path.extname(sourcePath).toLowerCase();
      const mime = IMAGE_MIME[ext] || "image/jpeg";
      out.reused = true;
      out.prepared = {
        source: sourcePath,
        path: path.relative(nxWorkspaceDir(cfg), sourcePath).replace(/\\/g, "/"),
        absolutePath: sourcePath,
        format: ext.replace(".", ""),
        mime,
        bytes: buffer.length,
        steps: ["reused already-prepared workspace image"],
        warnings: [],
        probe: null
      };
      out.dataUrl = "data:" + mime + ";base64," + buffer.toString("base64");
      out.warnings = [];
    } else {
      const args = ["image", "prepare", sourcePath, "--max-side", String(maxSide), "--fmt", o.fmt || "jpeg", "--inline"];
      if (o.grayscale) args.push("--grayscale");
      const prep = await nxSkillJson(cfg, args, Math.max(15000, cfg.toolTimeoutMs || 60000));
      if (!prep.ok) {
        out.code = ((prep.error || {}).code) || "IMAGE_ERROR";
        out.message = ((prep.error || {}).message) || "图像预处理失败";
        out.warnings.push((prep.error || {}).suggestion || "");
        return out;
      }
      out.prepared = prep.result;
      out.dataUrl = prep.result.dataUrl || null;
      out.warnings = (prep.result.warnings || []).slice();
    }

    // 简报单独再跑一次 read:即使模型能看图,简报里的测量值也值得一起给它。
    const known = o.knownDimension && o.knownDimension.pixels && o.knownDimension.value ? o.knownDimension : null;
    const readArgs = ["image", "read", out.prepared.absolutePath || sourcePath];
    if (known) readArgs.push("--known-pixels", String(known.pixels), "--known-value", String(known.value), "--known-unit", String(known.unit || "mm"));
    const read = await nxSkillJson(cfg, readArgs, Math.max(15000, cfg.toolTimeoutMs || 60000));
    if (read.ok) out.brief = read.result;
    else out.warnings.push("图像简报失败:" + (((read.error || {}).message) || ""));

    out.briefText = imageBriefText(out.brief || { file: out.prepared.probe }, { prepared: out.prepared });
    out.ok = true;
    return out;
  } catch (e) {
    out.code = "IMAGE_PIPELINE_ERROR";
    out.message = e.message;
    return out;
  }
}

function imageFailureText(r) {
  const label = IMAGE_ERROR_TEXT[r.code] || "图像处理失败";
  const extra = r.message ? "(" + String(r.message).slice(0, 300) + ")" : "";
  let hint = "";
  if (r.code === "IMAGE_TOO_SMALL") hint = " 建议按 600 dpi 以上重新导出,或把图纸分块扫描。";
  else if (r.code === "IMAGE_UNSUPPORTED_FORMAT") hint = " 支持 PNG/JPG/BMP/GIF/TIFF/WebP;PDF 请先导出成 PNG。";
  else if (r.code === "IMAGE_NOT_FOUND") hint = " 检查路径,或在对话框里重新选一次。";
  else if (r.code === "IMAGE_DEPENDENCY_MISSING") hint = " 在宿主解释器里执行 pip install pillow numpy。";
  return "<p><b>读图失败:</b>" + esc(label) + esc(extra) + "</p><p>" + esc(hint) + "</p>"
    + (r.warnings && r.warnings.length ? "<p class='hint'>" + esc(r.warnings.join(" ")) + "</p>" : "");
}

/* ------------------------------------------------------------------ *
 * NXOpen API 名门禁
 * 模型很容易写出"看着像但不存在"的 NXOpen 调用(例如 NXOpen.Sketches.Xxx、
 * NXOpen.Sketch.ViewReorient.TrueValue)。这类脚本会在用户点执行时才炸。
 * 这里用本机安装自带的 NXOpen.xml 建成的离线索引,在提交前就拦下来。
 * ------------------------------------------------------------------ */
let NXOPEN_INDEX = null;
let NXOPEN_NS = null;
function nxopenIndex() {
  if (NXOPEN_INDEX) return NXOPEN_INDEX;
  const f = path.join(ROOT, "cache", "nxopen-names.txt");
  try {
    // 注意: Python 在 Windows 文本模式下写出的行尾是 \r\n,必须去掉 \r
    const names = fs.readFileSync(f, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    NXOPEN_INDEX = new Set(names);
    // 命名空间集合 = 每个名字的所有前缀(用于放行 import NXOpen.Features 这类写法)
    NXOPEN_NS = new Set();
    for (const n of names) {
      const parts = n.split(".");
      for (let i = 2; i < parts.length; i++) NXOPEN_NS.add(parts.slice(0, i).join("."));
    }
  } catch (e) { NXOPEN_INDEX = new Set(); NXOPEN_NS = new Set(); }
  return NXOPEN_INDEX;
}

/** 去掉注释与字符串字面量,避免注释里提到的 API 造成误报 */
function stripNonCode(src) {
  return String(src)
    .replace(/"""[-\s\S]*?"""/g, '""')
    .replace(/'''[-\s\S]*?'''/g, "''")
    .replace(/#[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

let NXOPEN_BY_LEAF = null;
/** 按"最后一段名字"反查候选,给出正确拼写建议 */
function suggestNames(tok, idx) {
  if (!NXOPEN_BY_LEAF) {
    NXOPEN_BY_LEAF = new Map();
    for (const n of idx) {
      const leaf = n.split(".").pop();
      let arr = NXOPEN_BY_LEAF.get(leaf);
      if (!arr) { arr = []; NXOPEN_BY_LEAF.set(leaf, arr); }
      if (arr.length < 8) arr.push(n);
    }
  }
  const parts = tok.split(".");
  const leaf = parts[parts.length - 1];
  // ① 最优:找到真实存在的父类型,列出它下面的真实成员(带叶名相似度优先)
  for (let i = parts.length - 1; i >= 2; i--) {
    const parent = parts.slice(0, i).join(".");
    if (!idx.has(parent)) continue;
    const pref = parent + ".";
    const key = leaf.slice(0, 3).toLowerCase();
    const same = [], other = [];
    for (const n of idx) {
      if (!n.startsWith(pref) || n === parent) continue;
      (n.split(".").pop().toLowerCase().indexOf(key) === 0 ? same : other).push(n);
      if (same.length >= 6) break;
    }
    return same.concat(other).slice(0, 5);
  }
  // ② 回退:按叶名反查
  const cands = NXOPEN_BY_LEAF.get(leaf);
  return cands ? cands.slice(0, 3) : [];
}

/** 返回脚本里不存在的 NXOpen 名字 */
function checkNxOpenNames(script) {
  const idx = nxopenIndex();
  if (!idx.size) return { ok: true, unknown: [], note: "索引缺失,已跳过 API 名检查" };
  const code = stripNonCode(script);
  const unknown = [];
  const seen = new Set();
  const re = /NXOpen(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const tok = m[0];
    if (seen.has(tok)) continue;
    seen.add(tok);
    // 严格:必须是真实存在的 API 名,或是一个命名空间(供 import 用)。
    // 不做"前缀宽松",否则 NXOpen.Sketch.Null 这种杜撰成员会被放过。
    if (idx.has(tok)) continue;
    if (NXOPEN_NS && NXOPEN_NS.has(tok)) continue;
    unknown.push({ token: tok, suggest: suggestNames(tok, idx) });
  }
  return { ok: unknown.length === 0, unknown };
}

/** 在 live 解释器里**本来就可用**的 NXOpen 基础模块 —— 只写 import NXOpen 就有它们。
 *  实测(2606,live 桥,干净解释器):Session / BaseSession / UI 在;其余都不在。
 *  这个白名单是量出来的,不是猜的:漏掉会误报,多列会放过真错误。 */
const NXOPEN_AUTOLOADED = new Set(["Session", "BaseSession", "UI"]);

/** 返回脚本里用到、却没有 import 的 NXOpen 子模块。
 *
 *  为什么必须拦这一条(2026-09-20 实测踩到):
 *  `import NXOpen` **不会**带出 `NXOpen.Features` / `NXOpen.GeometricUtilities` 这类子模块。
 *  journal(批处理)路径下 NX 会把子模块预加载好,所以"headless 实跑通过"的样例能过;
 *  而 live 桥是在 NX 进程里用 runpy 跑一个干净解释器,少一行 import 就是
 *  `AttributeError: module 'NXOpen' has no attribute 'Features'` ——
 *  偏偏 NX 对外只说"无法执行 python 脚本,请参见系统日志",现场几乎无法定位。
 *  所以这条在提交时静态查出来,直接退回给模型重写。
 */
function checkNxOpenImports(script) {
  const code = stripNonCode(script);
  const modules = new Set();          // 已 import 的二级模块名,如 Features、GeometricUtilities
  let m;
  const ire = /^[ \t]*(?:import|from)[ \t]+(NXOpen(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/gm;
  while ((m = ire.exec(code)) !== null) {
    const parts = m[1].split(".");
    if (parts.length >= 2) modules.add(parts[1]);
  }
  // from NXOpen import Features, Session
  const fre = /^[ \t]*from[ \t]+NXOpen[ \t]+import[ \t]+([^\n#]+)/gm;
  while ((m = fre.exec(code)) !== null) {
    m[1].split(",").forEach(part => {
      const name = part.trim().split(/[\s.]+/)[0];
      if (name) modules.add(name);
    });
  }
  const missing = new Set();
  const ure = /NXOpen(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g;
  while ((m = ure.exec(code)) !== null) {
    const parts = m[0].split(".");
    if (parts.length < 3) continue;                       // NXOpen.Point3d / NXOpen.Vector3d:根模块就够
    if (NXOPEN_AUTOLOADED.has(parts[1])) continue;         // 基础模块本来就可用
    if (!modules.has(parts[1])) missing.add("NXOpen." + parts[1]);
  }
  return { ok: missing.size === 0, missing: Array.from(missing) };
}

/** 用宿主 Python 对 journal 脚本做语法检查(只编译,不执行) */function checkPythonSyntax(file) {
  const { spawnSync } = require("child_process");
  const r = spawnSync((loadConfig().python || "python"), ["-c", "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)", file],
    { encoding: "utf8", windowsHide: true });
  if (r.status === 0) return { ok: true };
  const msg = ((r.stderr || "") + (r.stdout || "")).trim();
  return { ok: false, error: msg.split("\n").slice(-6).join("\n").slice(0, 1200) };
}

const TOOLS = {
  nx_status: {
    desc: "报告本机 NX / Designcenter 环境:实际安装根目录、版本、能力(API 文档/日志/python 模块)、工作区。回答任何与本机 NX 环境有关的问题前先调这个。",
    params: { type: "object", properties: {}, required: [] },
    args: () => ["doctor"],
    compact: (e) => {
      const r = (e && e.result) || {}, s = r.settings || {};
      return {
        detectedInstallations: (r.installations || []).map(i => ({
          root: i.root, release: i.release, nxbin: i.nxbin, apiXmlDocCount: i.apiXmlDocCount,
          capabilities: i.capabilities,
          // 内置 Copilot 是"这一版有没有"决定的,按结构特征识别,与版本号无关
          copilot: i.copilot || null
        })),
        workspace: s.workspace, livePort: s.livePort,
        runningNxGuiProcesses: r.nxGuiProcesses || [], problems: r.problems || [],
        note: "detectedInstallations 才是本机真实存在的 NX 安装;copilot.available 表示该安装带内置 Copilot 功能"
      };
    }
  },
  nx_live_status: {
    desc: "只读查看当前打开的 NX/Designcenter 工作零件与模型摘要。仅在需要了解当前模型或核对执行结果时调用；桥离线时如实报告。",
    params: { type: "object", properties: {}, required: [] },
    args: () => ["live", "status"],
    compact: (e) => ((e || {}).result || {})
  },
  nx_docs_search: {
    desc: "在 NX 安装自带的离线 API 文档里按关键字搜索类型/成员(精确对应本机版本,离线)。写 NXOpen 代码前用它核对 API 是否存在。",
    params: { type: "object", properties: { query: { type: "string", description: "关键字,如 ExtrudeBuilder" }, kinds: { type: "string", description: "可选:type / method / property" } }, required: ["query"] },
    args: (a) => ["docs", "search", String(a.query || ""), ...(a.kinds ? ["--kinds", String(a.kinds)] : []), "--summary"],
    compact: (e) => ({ members: (((e || {}).result || {}).members || []).slice(0, 8).map(m => ({ name: m.name, kind: m.kind, summary: m.summary, createdIn: m.createdIn })) })
  },
  nx_docs_member: {
    desc: "查一个具体 NXOpen 成员(方法/属性)的签名、参数、摘要和引入版本。",
    params: { type: "object", properties: { name: { type: "string", description: "完整名,如 NXOpen.Session.UndoToMark" } }, required: ["name"] },
    args: (a) => ["docs", "member", String(a.name || "")],
    compact: (e) => ((e || {}).result || {})
  },
  nx_docs_type: {
    desc: "查一个 NXOpen 类型的成员列表(方法/属性)与摘要。",
    params: { type: "object", properties: { name: { type: "string", description: "完整类型名,如 NXOpen.Features.ExtrudeBuilder" } }, required: ["name"] },
    args: (a) => ["docs", "type", String(a.name || "")],
    compact: (e) => { const r = (e || {}).result || {}; return { type: r.type, memberCount: r.memberCount, members: (r.members || []).slice(0, 12).map(m => ({ name: m.name, kind: m.kind, summary: m.summary, createdIn: m.createdIn })) }; }
  },
  nx_docs_samples: {
    desc: "查找当前 NX 安装自带的官方 NXOpen 示例路径。需要可参考的实现时调用，返回路径不等于已经验证了该示例适用于当前任务。",
    params: { type: "object", properties: { query: { type: "string", description: "API 类型或操作关键字" } }, required: [] },
    args: (a) => ["docs", "samples", String(a.query || ""), "--limit", "12"],
    compact: (e) => ((e || {}).result || {})
  },
  nx_route_intent: {
    desc: "把用户的自然语言请求路由到合适的 NX 应用(建模/CAE/制图等),给出推荐模块与做法指引。收到建模类需求时先调它。",
    params: { type: "object", properties: { text: { type: "string", description: "用户原话" } }, required: ["text"] },
    args: (a) => ["route", String(a.text || "")],
    compact: (e) => ((e || {}).result || {})
  },
  nx_modeling_plan: {
    desc: "生成符合 NX 建模规范的建模计划骨架(分阶段、命名约定、可诊断的步骤切分)。",
    params: { type: "object", properties: { text: { type: "string", description: "要建的东西" }, partName: { type: "string", description: "零件名" } }, required: ["text"] },
    args: (a) => ["plan", String(a.text || ""), ...(a.partName ? ["--part-name", String(a.partName)] : [])],
    compact: (e) => ((e || {}).result || {})
  },
  nx_visual_spec: {
    desc: "三视图/图片建模的规则与约束(识图建模时用)。",
    params: { type: "object", properties: {}, required: [] },
    args: () => ["visual-spec"],
    compact: (e) => ((e || {}).result || {})
  }
};

// ---- Review(人工节拍执行):计划落到 workspace/review/,由人在 NX 菜单里逐步执行 ----
TOOLS.nx_review_submit = {
  desc: "把一份建模计划提交到 NX 的人工复核队列(workspace/review/plan.json)。提交后【不会自动执行】——" +
    "必须由人在 NX 里打开 NX Skill → Review Plan 逐步点击执行。破坏性步骤(CAE 求解、保存、导出、布尔、删除)一律用 gate=manual。",
  params: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "用户的原始需求" },
      partPath: { type: "string", description: "可选:目标零件路径(留空则在当前窗口建模)" },
      steps: {
        type: "array",
        description: "有序步骤。name 必须形如 NN_Short_Action_Object(编号让人看得出历史顺序)",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "如 01_Base_Block、02_Mounting_Holes" },
            operation: { type: "string", enum: ["create_block", "journal", "status", "screenshot", "noop"] },
            gate: { type: "string", enum: ["auto", "manual"], description: "auto=可连续执行;manual=必须人点(默认)" },
            params: { type: "object", description: "create_block: {length,width,height,feature_name};journal: {path:'02_holes.py'}" },
            script: { type: "string", description: "operation=journal 时必填:NXOpen Python 脚本源码。会被复制到 review/scripts/<params.path> 供用户执行前审阅。" },
            note: { type: "string", description: "给人看的说明" }
          },
          required: ["name", "operation", "gate"]
        }
      }
    },
    required: ["steps"]
  },
  prepare: async (a, cfg) => {
    const os = require("os");
    const steps = (a.steps || []).map((s, i) => ({
      id: s.id || String(i + 1).padStart(2, "0"),
      name: s.name, operation: s.operation,
      gate: s.gate || "manual",
      params: Object.assign({}, s.params || {}),
      note: s.note || ""
    }));
    const args = ["review", "submit"];
    let tmp = null;
    for (let i = 0; i < steps.length; i++) {
      const s = a.steps[i] || {};
      if (s.operation !== "journal" || !s.script) continue;
      if (!tmp) tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nxreview-"));
      // 文件名必须与 params.path 一致:nx-skill 以源文件名为键复制进 review/scripts/
      const base = path.basename(String(steps[i].params.path || (steps[i].name + ".py")));
      steps[i].params.path = base;
      const f = path.join(tmp, base);
      fs.writeFileSync(f, String(s.script), "utf8");

      // 语法门禁:脚本要在 NX 里跑,写错语法只会在用户点击那一步才炸。
      // 这里先用宿主 Python 做一次 py_compile,把错误当场退回给模型重写。
      const py = await checkPythonSyntax(f);
      if (!py.ok) {
        throw new Error("步骤 " + steps[i].name + " 的脚本 " + base + " 语法有误,请修正后重新提交:\n" + py.error);
      }
      const api = checkNxOpenNames(String(s.script));
      if (!api.ok) {
        throw new Error("步骤 " + steps[i].name + " 的脚本 " + base + " 里用了不存在的 NXOpen API:" +
          api.unknown.map(u => "\n  - " + u.token + (u.suggest.length ? "   可能是: " + u.suggest.join(" / ") : "")).join("") +
          "\n请直接用上面给出的名字改掉,然后重新提交;不要再反复搜索 API。");
      }
      const builder = checkBuilderBooleanMembers(stripNonCode(String(s.script)), nxopenIndex());
      if (!builder.ok) {
        throw new Error("步骤 " + steps[i].name + " 的脚本 " + base + " 使用了本机 NXOpen Builder 不存在的布尔成员:" +
          builder.issues.map(x => "\n  - 第 " + x.line + " 行 " + x.member + "（" + x.type + "）；应使用 " + x.suggestion).join("") +
          "\n请按当前安装版 API 修正后重新提交。");
      }
      // 子模块 import 门禁:import NXOpen 不会带出 NXOpen.Features 这类子模块,
      // journal 环境会预加载、live 桥不会 —— 少一行 import 就是"无法执行 python 脚本"。
      const imp = checkNxOpenImports(String(s.script));
      if (!imp.ok) {
        throw new Error("步骤 " + steps[i].name + " 的脚本 " + base + " 用了这些 NXOpen 子模块但没有 import:" +
          imp.missing.map(x => "\n  - " + x).join("") +
          "\n请注意:import NXOpen **不会**带出子模块,脚本开头必须显式写 import NXOpen.<模块>。" +
          "例如用到 NXOpen.Features.CylinderBuilder 就先写 import NXOpen.Features;" +
          "用到 NXOpen.GeometricUtilities.BooleanOperation 就先写 import NXOpen.GeometricUtilities。" +
          "请在脚本开头补上对应的 import 后重新提交。");
      }
      args.push("--script", f);
    }
    return { args, input: JSON.stringify({ prompt: a.prompt || "", partPath: a.partPath || "", steps }), tmp };
  },
  compact: (e) => {
    const r = (e || {}).result || {};
    return {
      planPath: r.planPath, planId: r.planId, stepCount: r.stepCount,
      steps: (r.steps || []).map(s => ({ name: s.name, operation: s.operation, gate: s.gate })),
      scriptsWritten: r.scriptsWritten,
      nextAction: "计划已写入队列,不会自动执行。请立刻停止调用工具,直接告诉用户:" +
        "在 Designcenter 里打开 NX Skill → Review Plan,逐步点击执行;每步可撤销、会自动截图留痕。"
    };
  }
};
TOOLS.nx_review_status = {
  desc: "查看人工复核队列的进度:计划是否存在、每一步是完成/待执行/已撤销。",
  params: { type: "object", properties: {}, required: [] },
  args: () => ["review", "status"],
  compact: (e) => ((e || {}).result || {})
};
TOOLS.nx_review_clear = {
  desc: "清空复核队列(删除 plan.json 与 run.json)。只在用户明确要求时调用。",
  params: { type: "object", properties: {}, required: [] },
  args: () => ["review", "clear"],
  compact: (e) => ((e || {}).result || {})
};

const toolSchemas = () => Object.entries(TOOLS).map(([name, t]) => ({
  type: "function", function: { name, description: t.desc, parameters: t.params }
}));

/** 每个工具在一次提问里的调用额度。用完就从工具表里摘掉——
 *  实测光靠提示词劝不住模型反复搜索,摘掉工具才是结构性的解法。 */
const TOOL_LIMITS = {
  nx_status: 1, nx_live_status: 2, nx_route_intent: 1, nx_modeling_plan: 1, nx_visual_spec: 1,
  nx_docs_search: 2, nx_docs_member: 2, nx_docs_type: 2, nx_docs_samples: 1,   // 刻意收紧:API 名由提交时的门禁负责纠错
  nx_review_submit: 4, nx_review_status: 2, nx_review_clear: 1
};

function availableSchemas(cfg, used) {
  const limits = Object.assign({}, TOOL_LIMITS, cfg.toolLimits || {});
  return toolSchemas().filter(s => {
    const n = s.function.name;
    const lim = limits[n] === undefined ? 99 : limits[n];
    return (used[n] || 0) < lim;
  });
}

async function execTool(cfg, name, args) {
  const t = TOOLS[name];
  if (!t) return { ok: false, error: "unknown tool: " + name, ms: 0 };

  let argv, stdin, tmp;
  let r;
  try {
    if (t.prepare) {
      const p = await t.prepare(args || {}, cfg);
      argv = p.args; stdin = p.input; tmp = p.tmp;
    } else {
      argv = t.args(args || {});
      stdin = t.input ? t.input(args || {}) : undefined;
    }
    r = await runNxSkill(cfg, argv, cfg.toolTimeoutMs, stdin);
  } catch (e) {
    return { ok: false, error: "工具参数准备失败: " + (e.message || e), ms: 0 };
  } finally {
    // 必须在 finally 里清:校验失败时 prepare 会抛错,原来那样就把临时目录留在 %TEMP% 了
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { } }
  }
  const ok = !!(r.envelope && r.envelope.ok);
  return { ok, ms: r.ms, data: ok ? t.compact(r.envelope) : null, error: ok ? null : (r.stderr || r.raw || "tool failed") };
}

/* ------------------------------------------------------------------ *
 * 大模型调用
 * ------------------------------------------------------------------ */
async function chatOnce(cfg, messages, opts) {
  const a = active(cfg);
  if (!a.baseUrl) throw new Error("未配置 baseUrl(请在设置里选择供应商或填写自定义地址)");
  const headers = { "Content-Type": "application/json" };
  if (a.apiKey) headers["Authorization"] = "Bearer " + a.apiKey;
  const body = { model: a.model || "gpt-4o-mini", messages, stream: false };

  // 单次模型调用超时。没有它,供应商吊住连接就是无限等待 —— 界面只会停在
  // "正在接收回答"。带上图像的请求本身就更重,所以把上限做成可配置。
  const timeoutMs = Math.max(5000, Number(cfg.llmTimeoutMs) || Number(opts && opts.timeoutMs) || 180000);
  const signal = AbortSignal.timeout(timeoutMs);

  // 深度思考开关。MiMo 官方文档明确:调 tool 时开着 thinking 会导致
  // tool_calls 出现在 reasoning 里(不稳定输出)—— 实测就是这个让模型把
  // 工具调用当文本吐出来。默认:调工具时关,纯生成时也关(提速)。
  if (/^mimo/i.test(a.id)) {
    const want = (opts && opts.thinking) || (opts && opts.tools === true ? "off" : ((cfg.thinking || {}).author || "off"));
    body.thinking = { type: want === "on" ? "enabled" : "disabled" };
  }
  // 注意:部分供应商(实测 MiMo)不遵守 tool_choice:"none",仍会返回 tool_calls 且 content 为空。
  // 要强制出文本,唯一可靠的做法是【根本不发 tools 参数】。
  if (opts && opts.tools === true) {
    body.tools = opts.schemas || toolSchemas();
    if (!body.tools.length) { delete body.tools; }        // 全部用完就退化成纯文本对话
    else body.tool_choice = opts.toolChoice || "auto";
  }

  if (PROGRESS.active) progressStage("thinking", "等待模型返回(" + body.messages.length + " 条上下文)…");

  // 默认流式:只有流式才能把 reasoning_content(思考链)实时亮出来,
  // 否则用户要干等几十秒,分不清是卡住还是在思考。
  if (opts && opts.stream === false) {
    const res0 = await fetch(a.baseUrl + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res0.ok) { const t = await res0.text(); throw new Error("模型接口 " + res0.status + ": " + t.slice(0, 300)); }
    const j0 = await res0.json();
    try {
      const m0 = (j0.choices && j0.choices[0] && j0.choices[0].message) || {};
      if (m0.reasoning_content) progressReasoning(m0.reasoning_content);
    } catch (e) { }
    return j0;
  }

  body.stream = true;
  const res = await fetch(a.baseUrl + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) { const t = await res.text(); throw new Error("模型接口 " + res.status + ": " + t.slice(0, 300)); }
  if (!res.body) { // 不支持流式就退回
    const j1 = await res.json();
    return j1;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", content = "", thinking = "";
  const tcs = [];
  let firstTokenAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || line.charAt(0) === ":") continue;
      if (line.indexOf("data:") !== 0) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let obj; try { obj = JSON.parse(payload); } catch (e) { continue; }
      const d = obj.choices && obj.choices[0] && obj.choices[0].delta;
      if (!d) continue;
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
        if (PROGRESS.active) progressStage("streaming", "模型已开始输出,正在接收…");
      }
      if (d.reasoning_content) { thinking += d.reasoning_content; progressReasoningDelta(d.reasoning_content); }
      if (d.content) content += d.content;
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = (tc.index === undefined || tc.index === null) ? 0 : tc.index;
          if (!tcs[i]) tcs[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) tcs[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) tcs[i].function.name += tc.function.name;
            if (tc.function.arguments) tcs[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }
  const msg = { role: "assistant", content: content };
  const calls = tcs.filter(Boolean);
  if (calls.length) msg.tool_calls = calls;
  if (thinking && !PROGRESS.reasoning.length) progressReasoning(thinking);
  return { choices: [{ message: msg }] };
}

function renderTrace(trace) {
  if (!trace.length) return "";
  const rows = trace.map(s => {
    const argTxt = Object.keys(s.args || {}).length ? esc(JSON.stringify(s.args)) : "";
    const body = s.ok
      ? "<pre style='margin:6px 0 0;padding:8px;background:#f6f8fa;border-radius:6px;overflow:auto;max-height:220px;font-size:12px'>" + esc(JSON.stringify(s.data, null, 1)) + "</pre>"
      : "<div style='color:#b00;margin-top:4px'>" + esc(String(s.error).slice(0, 400)) + "</div>";
    return "<div style='border-left:3px solid " + (s.ok ? "#0a7" : "#c33") + ";padding:6px 10px;margin:6px 0;background:#fafbfc'>" +
      "<div style='font-size:13px'><b>" + (s.ok ? "✅" : "❌") + " " + esc(s.name) + "</b>" +
      (argTxt ? " <span style='color:#666'>" + argTxt + "</span>" : "") +
      " <span style='color:#888'>· " + s.ms + " ms</span></div>" + body + "</div>";
  }).join("");
  return "<details style='margin-top:14px'><summary style='cursor:pointer;color:#0F789B;font-size:13px'>🔧 nx-skill 工具调用 " +
    trace.length + " 次(点击展开)</summary>" + rows + "</details>";
}

/* ------------------------------------------------------------------ *
 * 问答主循环(带工具调用兜底)
 * ------------------------------------------------------------------ */
/** 有些供应商(实测 MiMo)偶尔把工具调用当普通文本吐出来:
 *  <tool_call><function=N><parameter=k>v</parameter></function></tool_call>
 *  这里兜底解析,避免整轮白跑。 */
/**
 * 文本形式的工具调用。两种都要认,因为它们在 content 里而不是 tool_calls 字段:
 *   1) 旧的 function/parameter 文本形式;
 *   2) DeepSeek 的 DSML 形式 —— 全角竖线包住标记,形如 DSML 竖线 invoke name="nx_status"。
 * 实测(2026-09-21):带图提问时 deepseek-chat 会把整段 DSML 写进正文。不认它后果是双重的
 * —— 工具没被执行,而且那几千字裸标记会原样漏给主人。
 */
const DSML_BAR = String.fromCharCode(0xFF5C);        // 全角竖线
const DSML_TAG = DSML_BAR + DSML_BAR + 'DSML' + DSML_BAR + DSML_BAR;

function parseTextToolCalls(content) {
  const out = [];
  if (typeof content !== 'string') return out;

  // 形式二:DSML(先做,因为它可能和形式一同现)
  if (content.indexOf(DSML_TAG) >= 0) {
    const chunks = content.split(new RegExp('<' + DSML_TAG + 'invoke[ >]'));
    for (let i = 1; i < chunks.length; i++) {
      const chunk = chunks[i];
      const head = chunk.match(/^name="([A-Za-z0-9_]+)"/) || chunk.match(/^([A-Za-z0-9_]+)"/);
      const name = head ? head[1] : '';
      if (!name) continue;
      const args = {};
      const paramRe = new RegExp(DSML_TAG + 'parameter name="([A-Za-z0-9_]+)"[^>]*>([\\s\\S]*?)</' + DSML_TAG + 'parameter>', 'g');
      let p;
      while ((p = paramRe.exec(chunk)) !== null) {
        const raw = p[2].trim();
        try { args[p[1]] = JSON.parse(raw); } catch (e) { args[p[1]] = raw; }
      }
      out.push({ id: 'dsml_' + out.length + '_' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
      console.log('[ask] 从 DSML 文本里解析出工具调用:' + name);
    }
    if (out.length) return out;
  }

  if (content.indexOf('<function=') < 0) return out;
  const fnRe = /<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>/g;
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const body = m[2];
    const args = {};
    const pRe = /<parameter=([A-Za-z0-9_]+)>([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = pRe.exec(body)) !== null) {
      const raw = p[2].trim();
      let v = raw;
      try { v = JSON.parse(raw); } catch (e) { /* 保留字符串 */ }
      args[p[1]] = v;
    }
    out.push({ id: 'textcall_' + out.length + '_' + Date.now(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  }
  return out;
}

/** 把残留的工具调用标记从正文里摘掉 —— 用户不该看到裸标记。 */
function stripToolMarkup(input) {
  let text = String(input || '');
  if (text.indexOf(DSML_TAG) >= 0) {
    text = text.replace(new RegExp('<' + DSML_TAG + 'invoke[\\s\\S]*?</' + DSML_TAG + 'invoke>', 'g'), '');
    text = text.replace(new RegExp(DSML_TAG + '[^\\n]*', 'g'), '');
  }
  text = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<function=[A-Za-z0-9_]+>[\s\S]*?<\/function>/g, '')   // 整块删,别把参数值留在正文
    .replace(/<\/?function[^>]*>/g, '')
    .replace(/<\/?parameter[^>]*>/g, '');

  // 标记被截断或折行时会留下碎片:单独成行的 < 、 </ 、 | 、 ｜ 。
  // 实测 2026-09-21:回答末尾吊着 "< < < / </" 五行,因为输出在半个标记处被截断。
  // 只削**结尾**那些"全是标记符号"的行,并且不含 '-' —— markdown 的 --- 分隔线不能被吃掉。
  const lines = text.split('\n');
  const debris = /^[\s<>/|\uFF5C]{1,8}$/;
  while (lines.length && debris.test(lines[lines.length - 1])) lines.pop();
  while (lines.length && lines[0].trim() === '') lines.shift();
  return lines.join('\n').trim();
}

/** 计划刚载入队列时,在答案最上方插一条醒目指路条 */
function renderReviewBanner(submitted, stepCount) {
  if (!submitted) return "";
  return "<div style='border:1px solid #0F789B;background:#eef6f9;border-radius:8px;padding:10px 12px;margin-bottom:10px'>" +
    "<div style='font-weight:600;color:#0F789B'>✅ 计划已载入复核队列" + (stepCount ? "（" + stepCount + " 步）" : "") + "</div>" +
    "<div style='margin-top:4px;font-size:13px'>在 Designcenter 里执行：菜单 <b>Help → NX Skill → Review Plan</b>，" +
    "或按 <b>Ctrl+Alt+Shift+R</b>。每步可单独撤销、自动截图留痕；计划<b>不会自动运行</b>。</div></div>";
}

/**
 * 构造 user 消息的内容。
 *
 * 能看图的供应商拿到标准的 OpenAI 多模态 content 数组(text + image_url);
 * 看不到图的供应商拿到「提问 + 图像简报」的纯文本,并且简报第一行就写明
 * 这不是它看到的像素 —— 模型不会假装看过图,主人也不会被"我看到了"骗到。
 */
function buildUserContent(question, a, img) {
  if (!img) return question;
  if (!img.ok) return question;

  const brief = img.briefText || "【图像输入】";
  if (a.vision === true && img.dataUrl) {
    return [
      { type: "text", text: question + "\n\n" + brief },
      { type: "image_url", image_url: { url: img.dataUrl, detail: "high" } }
    ];
  }
  const why = a.vision === null
    ? "(当前供应商 " + a.label + " 的看图能力未声明,按保守处理;确实支持多模态时可在 config.json 的 providers."
      + a.id + ".vision 写 true。)"
    : "(当前模型 " + a.label + " 不能读图,以下是本机图像管线读出来的结构化简报。)";
  return question + "\n\n" + why + "\n\n" + brief;
}

/**
 * 保证每个 assistant.tool_calls 里的 id 都有对应的 tool 回复。
 *
 * 供应商按协议校验这件事:少一条回复,整个请求被 400 拒掉,而且报错文案
 * (insufficient tool messages following tool_calls message)看不出是哪一轮造成的。
 * 实测 2026-09-21 就是因为额度在中途用完、后面几条没回,整轮对话直接报后端错。
 * 与其在每处 break 上小心翼翼,不如发请求前统一补齐。
 */
function repairToolPairing(messages) {
  const answered = new Set(messages.filter(m => m.role === "tool").map(m => m.tool_call_id));
  const out = [];
  for (const message of messages) {
    out.push(message);
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call && call.id && !answered.has(call.id)) {
          answered.add(call.id);
          out.push({
            role: "tool", tool_call_id: call.id, name: call.function && call.function.name,
            content: JSON.stringify({ error: "本条未执行(工具额度或收敛限制),请改用已有信息作答。" })
          });
        }
      }
    }
  }
  return out;
}

async function answer(question, cfg, history = [], image = null) {
  const a = active(cfg);
  const trace = [];
  progressStart("chat", question);
  try {
    return await answerInner(question, cfg, a, trace, history, image);
  } finally {
    progressEnd("done");
  }
}

async function answerInner(question, cfg, a, trace, history, imageResult) {

  if (a.id === "mock" && !question) { /* 不会发生 */ }

  const messages = [
    { role: "system", content: cfg.systemPrompt || DEFAULT_SYS },
    { role: "system", content: "本机信息必须以工具返回为准。回答当前工作零件或验证执行结果时调用 nx_live_status；读取失败就明确说无法核实。计划提交只表示已进入复核队列，不代表 NX 执行成功。NXOpen API 名称请先查本机文档。" },
    { role: "system", content: "只有工具真的返回成功才算做过。不要在正文里写「已提交」「已调用」「已执行」——系统记录才是判据,你写了也没用,还会误导用户。" },
    { role: "system", content: "收到图像时：先看图像工具的测量值再下结论。图上的尺寸以标注文字为准，不要拿线长当尺寸。本项目里 nx_image_read / nx_image_prepare 负责读图，nx_visual_spec 给出三视图建模规则。"
        + "没有已知尺寸时，任何物理尺寸都是不确定的——要么向你询问参考尺寸，要么在计划里做成可编辑表达式。" },
    ...history,
    { role: "user", content: buildUserContent(question, a, imageResult) }
  ];
  const seen = new Map();     // 去重:同工具同参数不重复执行
  const used = {};            // 每个工具已用次数(超过额度就从工具表摘掉)
  let final = "";
  const maxRounds = cfg.maxToolRounds || 6;
  const maxCalls = cfg.maxToolCalls || 8;      // 总调用数硬上限(轮数管不住一轮多调)
  let callCount = 0;

  for (let i = 0; i <= maxRounds; i++) {
    const schemas = availableSchemas(cfg, used);
    const noMoreTools = i === maxRounds || callCount >= maxCalls || schemas.length === 0;
    const j = await chatOnce(cfg, repairToolPairing(messages), noMoreTools ? { tools: false } : { tools: true, schemas });
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    let calls = msg.tool_calls || [];

    // 兜底:模型把工具调用写成了文本
    if (!calls.length) {
      const salvaged = parseTextToolCalls(msg.content);
      if (salvaged.length) {
        console.log("[ask] 兜底解析出文本形式的工具调用 " + salvaged.length + " 个");
        calls = salvaged;
        msg.content = stripToolMarkup(msg.content);
      }
    }

    if (!calls.length) { final = msg.content || ""; break; }
    if (noMoreTools) { break; }

    messages.push({ role: "assistant", content: msg.content || "", tool_calls: calls });

    for (const c of calls) {
      if (callCount >= maxCalls) {
        // 额度用完也必须回一条 tool 消息:OpenAI 兼容接口要求每个 tool_call_id
        // 都有对应的 tool 回复,少一条整个请求就是 400
        // ("insufficient tool messages following tool_calls message")。
        messages.push({
          role: "tool", tool_call_id: c.id, name: c.function.name,
          content: JSON.stringify({ error: "工具调用额度已用完,本条未执行。请用已有信息作答。" })
        });
        continue;
      }
      let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch (e) { }
      const key = c.function.name + ":" + JSON.stringify(args);
      let r;
      if (seen.has(key)) {
        const p = seen.get(key);
        r = { ok: p.ok, ms: p.ms, data: p.data, error: p.error, cached: true };
      } else {
        progressStage("tool", "调用 " + c.function.name + " …");
        r = await execTool(cfg, c.function.name, args);
        progressTool(c.function.name, args, r);
        seen.set(key, r);
      }
      used[c.function.name] = (used[c.function.name] || 0) + 1;
      callCount++;
      trace.push({ name: c.function.name, args, ok: r.ok, ms: r.ms, data: r.data, error: r.error });
      messages.push({
        role: "tool", tool_call_id: c.id, name: c.function.name,
        content: JSON.stringify(r.ok ? r.data : { error: r.error }).slice(0, 6000)
      });
    }

    // 收敛提示:只剩少量额度时,明确要求开始作答
    const left = maxCalls - callCount;
    if (left <= 2) {
      messages.push({ role: "system", content: "工具额度即将用完。如果用户的要求还没完成(例如还没提交计划),立刻用最后一次额度把它做完,然后作答;否则直接用已获得的信息给出回答。" });
    } else if (i >= 1) {
      messages.push({ role: "system", content: "信息够用就立刻推进:该提交就提交,该作答就作答。不要为了凑信息反复调用同一个工具(尤其不要重复搜索同类 API)。" });
    }
  }

  if (!final) {
    // 最终兜底:不带 tools 再要一次纯文本
    messages.push({ role: "system", content: "现在只用已经拿到的信息,用简体中文给出完整回答;如果用户要求提交计划而还没提交,请把它做完。" });
    try {
      const j2 = await chatOnce(cfg, repairToolPairing(messages), { tools: false });
      let c2 = ((j2.choices || [{}])[0].message || {}).content || "";
      // 最后一搏:模型把工具调用写成文本时,这里真的执行掉(通常就是 nx_review_submit)
      const late = parseTextToolCalls(c2);
      for (const c of late) {
        let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch (e) { }
        console.log("[ask] 兜底轮执行文本形式工具调用: " + c.function.name);
        const r = await execTool(cfg, c.function.name, args);
        trace.push({ name: c.function.name, args, ok: r.ok, ms: r.ms, data: r.data, error: r.error });
      }
      final = c2;
    } catch (e) { }
  }
  // 收尾:把残留的工具调用标记从正文清掉,别让用户看到裸标签
  if (final && (final.indexOf(DSML_TAG) >= 0 || final.indexOf('<function=') >= 0 || final.indexOf('<tool_call>') >= 0)) {
    final = stripToolMarkup(final);
  }
  if (!final) final = "（模型未能在额度内给出文本答复。请把问题拆小,或把「最大工具调用数」调大后重试。）";

  // 本次是否把计划写进了复核队列 —— 页面据此"自动载入"复核选项卡
  const submitted = trace.some(t => t.name === "nx_review_submit" && t.ok);
  const stepCount = submitted
    ? ((trace.filter(t => t.name === "nx_review_submit" && t.ok).pop().data || {}).stepCount || null)
    : null;

  return {
    html: renderReviewBanner(submitted, stepCount) + toHtml(final) + renderTrace(trace),
    text: final, trace, provider: a.id, model: a.model, reviewSubmitted: submitted, stepCount
  };
}

/* ------------------------------------------------------------------ *
 * 一次性生成计划并载入复核队列(不依赖模型的多轮工具调用)
 * 实测:长工具链上模型会把额度全花在查 API 上,计划反而交不出来。
 * 这里改成"单次请求 + 严格 JSON 契约 + 服务端校验 + 失败带错误重试一次"。
 * ------------------------------------------------------------------ */
/** 给模型的"示范":一份已通过语法与 API 名双重校验的完整计划样例 */
/** 给模型的"示范":一份**在 headless NX 里实际跑通过**的计划样例。
 * 四条实机验证出来的坑(文档与静态检查都看不出来):
 *   Origin     必须是 NXOpen.Point3d —— 传 Point 对象或 Vector3d 都报 "Expecting NXOpen.Point3d"
 *   Direction  必须是 NXOpen.Vector3d —— 传 CreateDirection 返回的 Direction 对象报 "Expecting NXOpen.Vector3d"
 *   布尔目标   用 BooleanOption.SetTargetBodies(list(...)) 这个方法;没有 TargetBodies 属性
 *   子模块     import NXOpen **不会**带出 NXOpen.Features / NXOpen.GeometricUtilities 这类子模块。
 *              journal 环境会预加载所以 headless 能跑,live 桥(干净解释器 + runpy)不行 ——
 *              用到哪个子模块就必须 import 哪个,否则就是 "无法执行 python 脚本,请参见系统日志"
 *              背后藏着的 AttributeError(2026-09-20 实测)。
 */
const EXAMPLE_RECIPE = ["import math", "import NXOpen", "import NXOpen.Features", "import NXOpen.GeometricUtilities", "", "", "def cylinder(part, x, y, z, dia, h, create):", "    b = part.Features.CreateCylinderBuilder(None)", "    b.Type = NXOpen.Features.CylinderBuilder.Types.AxisDiameterAndHeight", "    b.Origin = NXOpen.Point3d(x, y, z)", "    b.Direction = NXOpen.Vector3d(0.0, 0.0, 1.0)", "    b.Diameter.RightHandSide = str(dia)", "    b.Height.RightHandSide = str(h)", "    C = NXOpen.GeometricUtilities.BooleanOperation.BooleanType", "    b.BooleanOption.Type = C.Create if create else C.Subtract", "    if not create:", "        bodies = list(part.Bodies)", "        if not bodies:", "            raise RuntimeError('no target body for subtraction')", "        b.BooleanOption.SetTargetBodies(bodies)", "    f = b.Commit()", "    b.Destroy()", "    return f", "", "", "def main():", "    session = NXOpen.Session.GetSession()", "    part = session.Parts.Work", "    if part is None:", "        raise RuntimeError('no work part')", "    f = cylinder(part, 0.0, 0.0, 0.0, 200, 20, True)", "    f.SetName('01_Flange_Disc')", "", "", "if __name__ == '__main__':", "    main()"].join("\n");
const EXAMPLE_PLAN = JSON.stringify({
  prompt: "在法兰盘上做中心通孔和 6 个螺栓孔",
  partPath: "",
  steps: [
    { name: "01_Create_Flange_Disc", operation: "journal", gate: "auto",
      params: { path: "01_Create_Flange_Disc.py" }, note: "法兰盘体 OD200 H20", script: EXAMPLE_RECIPE },
    { name: "02_Bolt_Holes_Six", operation: "journal", gate: "manual",
      params: { path: "02_Bolt_Holes_Six.py" }, note: "O160 分度圆上 6xO16 螺栓孔(布尔求差)",
      script: ["import math", "import NXOpen", "import NXOpen.Features", "import NXOpen.GeometricUtilities", "", "", "def main():", "    session = NXOpen.Session.GetSession()", "    part = session.Parts.Work", "    C = NXOpen.GeometricUtilities.BooleanOperation.BooleanType", "    for i in range(6):", "        a = 2.0 * math.pi * i / 6.0", "        b = part.Features.CreateCylinderBuilder(None)", "        b.Type = NXOpen.Features.CylinderBuilder.Types.AxisDiameterAndHeight", "        b.Origin = NXOpen.Point3d(80.0 * math.cos(a), 80.0 * math.sin(a), -5.0)", "        b.Direction = NXOpen.Vector3d(0.0, 0.0, 1.0)", "        b.Diameter.RightHandSide = '16'", "        b.Height.RightHandSide = '30'", "        b.BooleanOption.Type = C.Subtract", "        bodies = list(part.Bodies)", "        if not bodies:", "            raise RuntimeError('no target body for subtraction')", "        b.BooleanOption.SetTargetBodies(bodies)", "        f = b.Commit()", "        f.SetName('02_Bolt_Hole_%02d' % (i + 1))", "        b.Destroy()", "", "", "if __name__ == '__main__':", "    main()"].join("\n") },
    { name: "03_Review_Screenshot", operation: "screenshot", gate: "manual", params: {}, note: "人工检查" }
  ]
}, null, 1);

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

async function authorPlan(cfg, question, partName, sourcePlan = "") {
  const contract = [
    "你是 NX 建模计划生成器。只输出 JSON,不要任何解释、不要 markdown 代码块以外的文字。",
    "输出格式:",
    '{"prompt":"用户需求原文","partPath":"","steps":[{"name":"01_Xxx_Yyy","operation":"journal|create_block|screenshot|status|noop","gate":"auto|manual","params":{"path":"01_Xxx_Yyy.py"},"script":"<NXOpen Python 源码>","note":"中文说明"}]}',
    "规则:",
    "1. 步骤名必须是 NN_Short_Action_Object(两位编号);步骤要覆盖用户要求的每个特征,不要只给一步。",
    "2. 需要几何操作用 operation=journal,并在 script 里给出完整可运行的 NXOpen Python 源码;params.path 用与步骤名一致的 .py 文件名。",
    "3. 脚本必须含 def main(): 与 if __name__ == '__main__': main();不要用 f-string;操作 session.Parts.Work;不要 Save/Export;不要自己调 SetUndoMark/UndoToMark。",
    "3b. 【必须】用的子模块要在脚本开头逐个 import:import NXOpen **不会**带出 NXOpen.Features / NXOpen.GeometricUtilities 这类子模块。用到 NXOpen.Features.CylinderBuilder 就先写 import NXOpen.Features;用到 NXOpen.GeometricUtilities.BooleanOperation 就先写 import NXOpen.GeometricUtilities。少一行 import,NX 只会报'无法执行 python 脚本',系统会拦下并告诉你缺哪个。",
    "4. 破坏性步骤(切除、布尔、保存、导出、求解)用 gate=manual;基础体/参考几何可用 gate=auto。",
    "5. 最后一步建议 operation=screenshot、gate=manual,供人工检查。",
    "6. 脚本里用到的 NXOpen 名字必须是真实存在的;系统会逐个校验,错了会把正确拼写告诉你。",
    "已核验的写法(在 headless NX 里实跑通过,照抄):builder 用 None 作参数;",
    "b.Origin = NXOpen.Point3d(x, y, z)  <-- 必须是 Point3d;传 Point 对象或 Vector3d 都会报错;",
    "b.Direction = NXOpen.Vector3d(0.0, 0.0, 1.0)  <-- 必须是 Vector3d!不要用 part.Directions.CreateDirection(...),它返回 Direction 对象,会报 Expecting NXOpen.Vector3d;",
    "b.Diameter.RightHandSide = 直径字符串 / b.Height.RightHandSide = 高度字符串;",
    "布尔:对 CylinderBuilder 使用 b.BooleanOption.Type = NXOpen.GeometricUtilities.BooleanOperation.BooleanType.Create 或 .Subtract;CylinderBuilder 没有 BooleanOperation 属性。不同 Builder 的布尔属性名可能不同,必须按当前安装版 API 核对,不可套用。",
    "求差要给目标体,而且用【方法】:b.BooleanOption.SetTargetBodies(list(part.Bodies)) —— 没有 TargetBodies 这个属性;",
    "提交 f = b.Commit()、命名 f.SetName('NN_Xxx')、清理 b.Destroy()。",
    "",
    "可用的建模 builder(全部已核验存在,直接用,不要自己造名字):\n  实体  : CreateBlockFeatureBuilder / CreateCylinderBuilder\n  特征  : CreateExtrudeBuilder / CreateRevolveBuilder\n  孔    : CreateHoleFeatureBuilder\n  倒角  : CreateChamferBuilder(对应 NXOpen.Features.ChamferBuilder)\n  圆角  : CreateEdgeBlendBuilder(对应 NXOpen.Features.EdgeBlendBuilder)\n  螺纹  : CreateThreadBuilder\n  统一写法:builder = part.Features.CreateXxxBuilder(None); ... ; f = builder.Commit(); f.SetName('NN_...'); builder.Destroy()\n**不存在**这些名字,别用:NXOpen.Features.SlotBuilder / GrooveBuilder / CountersinkBuilder / Sketches / Datums。\n要做键槽/凹槽/切口(没有专用 builder 的情况下),标准做法是:用一个小实体当刀具 ——\n  建一个 Block 或 Cylinder 放在要切的位置,然后 b.BooleanOption.Type = ...BooleanType.Subtract,\n  b.BooleanOption.SetTargetBodies(list(part.Bodies))。没有 BooleanOption.TargetBodies 属性;目标体列表为空时不要提交求差。\n倒角/圆角需要先选中边:用 part.Edges 或从已建对象的 body 上取边赋给 builder 的对应属性;\n拿不准某个属性名时,先调 nx_docs_member 查一次,不要猜。",
    "注意:上面 BooleanOption 的布尔示例只适用于 CylinderBuilder；BlockBuilder、ExtrudeBuilder 等必须分别查询本机 API,不能照搬成员名。",
    "倒角(实测最容易踩坑):NXOpen.Features.ChamferBuilder.ChamferOption 的合法取值是 SymmetricOffsets / TwoOffsets / OffsetAndAngle —— 没有 Symmetric。写法:cb = part.Features.CreateChamferBuilder(None); cb.Option = NXOpen.Features.ChamferBuilder.ChamferOption.SymmetricOffsets; cb.FirstOffset.RightHandSide = '2'; 设好边集后 cb.Commit()。如果边集(SmartCollector)用法无法确证,就不要写这一步:降级为 operation=noop、gate=manual,note 里写明让用户手工倒角。任何无法确证成员名的特征,一律降级为 manual 人工步骤 —— 宁少一步也不写错。",
    "下面是一份**已通过全部校验的真实样例**。**只学它的写法与结构,尺寸/特征/步骤数必须按用户实际需求来,严禁照抄样例内容。**",
    EXAMPLE_PLAN
  ].join("\n");

  const messages = [
    { role: "system", content: contract },
    { role: "user", content: "需求:" + question + (partName ? "\n零件名:" + partName : "") +
      (sourcePlan ? "\n\n以下是聊天中已经讨论的计划草稿。请保留其中符合原始需求的步骤、尺寸与约束，再按上面的 JSON 契约生成可复核计划；草稿不代表脚本已校验或已执行：\n" + String(sourcePlan).slice(0, 12000) : "") }
  ];

  progressStart("author", question);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    PROGRESS.attempts = attempt;
    progressStage("authoring", attempt === 1 ? "正在生成计划 JSON 与 NXOpen 脚本…" : "第 " + attempt + " 次修正后重新生成…");
    const j = await chatOnce(cfg, messages, { tools: false });
    const text = ((j.choices || [{}])[0].message || {}).content || "";
    const plan = extractJson(text);
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) {
      lastErr = "模型没有返回合法的计划 JSON";
      messages.push({ role: "assistant", content: text.slice(0, 2000) });
      messages.push({ role: "user", content: "这不是合法 JSON。请只输出 JSON 对象本身。" });
      continue;
    }
    progressStage("validating", "校验脚本语法与 NXOpen API 名…");
    const res = await execTool(cfg, "nx_review_submit", {
      prompt: sourcePlan ? question : (plan.prompt || question), partPath: plan.partPath || "", steps: plan.steps
    });
    progressTool("nx_review_submit", { attempt: attempt }, res);
    if (res.ok) {
      progressEnd("done");
      return { ok: true, attempt, planId: (res.data || {}).planId, stepCount: (res.data || {}).stepCount, steps: (res.data || {}).steps, raw: res.data };
    }
    lastErr = res.error || "提交被拒";
    console.log("[author] 第" + attempt + "次提交被拒: " + String(lastErr).replace(/\s+/g, " ").slice(0, 400));
    progressStage("retry", "校验未通过,把正确写法回给模型重写…");
    messages.push({ role: "assistant", content: text.slice(0, 4000) });
    messages.push({ role: "user", content: "校验未通过,请修正后重新输出完整 JSON。\n如果某个特征你无法确证 API,就把它降级成 operation=noop、gate=manual 的人工步骤(note 里写明让用户在 NX 里手工做什么),不要为了凑步骤去猜 API 名。\n错误:\n" + String(lastErr).slice(0, 1500) });
  }
  progressEnd("failed");
  return { ok: false, error: lastErr, attempts: 3 };
}

/* ------------------------------------------------------------------ */
function serve(file, res, onMissing) {
  fs.readFile(file, (err, buf) => {
    if (err) { onMissing(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(buf);
  });
}
function readBody(req, cb) { let raw = ""; req.on("data", c => raw += c); req.on("end", () => cb(raw)); }
const sendJson = (res, o) => { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(o)); };

/* 最近的请求记录,便于判断"NX 是否真的连上了我们" */
const RECENT = [];
/* NX 菜单里选好的图先放这儿,工作台打开时自己取走(取一次就清空)。 */
let PENDING_IMAGE = null;
function note(req, extra) {
  const ua = String(req.headers["user-agent"] || "");
  const from = /WebView2|Edg\//i.test(ua) ? "WebView2/NX" : (ua.slice(0, 30) || "?");
  const line = new Date().toLocaleTimeString("zh-CN") + "  " + req.method + " " + req.url + "  ← " + from + (extra ? "  " + extra : "");
  RECENT.push(line);
  if (RECENT.length > 60) RECENT.shift();
  console.log("[req] " + line);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== "/favicon.ico") note(req);

  /* ---- 伪 OpenAI:无真实模型时自测工具闭环 ---- */
  if (req.method === "POST" && parsed.pathname === "/mock/v1/chat/completions") {
    readBody(req, (raw) => {
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch (e) { }
      const msgs = body.messages || [];
      const lastUser = [...msgs].reverse().find(m => m.role === "user");
      const toolMsgs = msgs.filter(m => m.role === "tool");
      const hasTools = Array.isArray(body.tools) && body.tools.length;
      const noTools = body.tool_choice === "none";
      let out;
      if (hasTools && !noTools && !toolMsgs.length) {
        const q = String((lastUser && lastUser.content) || "");
        const call = /NXOpen|API|成员|类型/.test(q) ? { name: "nx_docs_search", args: { query: "ExtrudeBuilder" } } : { name: "nx_status", args: {} };
        out = { role: "assistant", content: null, tool_calls: [{ id: "call_mock_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] };
      } else if (toolMsgs.length) {
        out = { role: "assistant", content: "已通过工具查证:\n" + toolMsgs.map(m => "· " + m.name).join("\n") + "\n\n(mock 模型,用于验证工具闭环)" };
      } else {
        out = { role: "assistant", content: "mock: " + ((lastUser && lastUser.content) || "") };
      }
      sendJson(res, { choices: [{ message: out }] });
    });
    return;
  }

  /* ---- 读图交接:NX 菜单选的图交给工作台 ---- */
  if (parsed.pathname === "/api/image/handoff") {
    if (req.method === "POST") {
      readBody(req, (raw) => {
        let body = {}; try { body = JSON.parse(raw || "{}"); } catch (e) { }
        const target = String(body.path || "").trim();
        if (!target || !fs.existsSync(target)) { sendJson(res, { ok: false, error: "路径不存在:" + target }); return; }
        PENDING_IMAGE = { path: target, at: Date.now() };
        console.log("[handoff] NX 交来一张图:" + target);
        sendJson(res, { ok: true, path: target });
      });
    } else {
      // 超过 10 分钟的交接当过期:没人会隔那么久才回来取。
      const fresh = PENDING_IMAGE && (Date.now() - PENDING_IMAGE.at) < 10 * 60 * 1000;
      const pending = fresh ? PENDING_IMAGE.path : null;
      PENDING_IMAGE = null;
      sendJson(res, { ok: true, path: pending });
    }
    return;
  }

  /* ---- 读图:预处理 + 简报(界面预览与"这条图能不能看懂"的判断) ---- */
  if (req.method === "POST" && parsed.pathname === "/api/image/prepare") {
    readBody(req, async (raw) => {
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch (e) { }
      const cfg = loadConfig();
      const img = await readImageForModel(cfg, body.image || body, body.options || {});
      if (!img.ok) {
        sendJson(res, {
          ok: false, code: img.code, message: img.message,
          hint: IMAGE_ERROR_TEXT[img.code] || null, warnings: img.warnings, html: imageFailureText(img)
        });
        return;
      }
      const a = active(cfg);
      sendJson(res, {
        ok: true,
        prepared: {
          path: img.prepared.path, absolutePath: img.prepared.absolutePath,
          width: img.prepared.width, height: img.prepared.height, bytes: img.prepared.bytes,
          mime: img.prepared.mime, steps: img.prepared.steps
        },
        brief: img.brief,
        briefText: img.briefText,
        warnings: img.warnings,
        preview: img.dataUrl,
        vision: {
          supported: a.vision === true, unknown: a.vision === null,
          provider: a.id, label: a.label, model: a.model,
          route: a.vision === true ? "vision" : "brief"
        }
      });
    });
    return;
  }

  /* ---- 聊天后端 ---- */
  if (req.method === "POST" && parsed.pathname === "/api/ask") {
    readBody(req, async (raw) => {
      let q = "", history = [], image = null, imageOptions = {};
      try {
        const body = JSON.parse(raw || "{}");
        q = String(body.question || "").slice(0, 12000);
        image = body.image || null;
        imageOptions = body.imageOptions || {};
        if (Array.isArray(body.history)) history = body.history.slice(-8)
          .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
      } catch (e) { }
      const cfg = loadConfig();
      const t0 = Date.now();
      try {
        // 读图在提问之前完成:失败了就直接把失败原因答复给主人,而不是让模型
        // 凭空猜图里有什么。
        let img = null;
        if (image) {
          if (PROGRESS.active) progressStage("tool", "读图:预处理 + 测量…");
          img = await readImageForModel(cfg, image, imageOptions);
          if (!img.ok) {
            const ms = Date.now() - t0;
            console.log("[ask] 读图失败:" + img.code + " | " + ms + "ms");
            sendJson(res, {
              data: { answer: imageFailureText(img), text: (IMAGE_ERROR_TEXT[img.code] || "读图失败") + " " + (img.message || "") },
              meta: { ms, image: { ok: false, code: img.code } }
            });
            return;
          }
        }
        const a = await answer(q, cfg, history, img);
        const vision = active(cfg).vision === true;
        console.log("[ask] 问题:" + q.slice(0, 40) + " | 供应商:" + a.provider + " | 工具:" + a.trace.length
          + (img ? " | 图:" + (vision ? "多模态" : "简报") : "") + " | " + (Date.now() - t0) + "ms");
        sendJson(res, {
          data: { answer: a.html, text: a.text },
          meta: {
            provider: a.provider, model: a.model, ms: Date.now() - t0, tools: a.trace.length,
            reviewSubmitted: !!a.reviewSubmitted, stepCount: a.stepCount || null,
            image: img ? { ok: true, path: img.prepared.path, route: vision ? "vision" : "brief", warnings: img.warnings } : null
          }
        });
      } catch (e) {
        const aborted = e && (e.name === "TimeoutError" || e.name === "AbortError");
        const msg = aborted
          ? "模型调用超时(超过 " + ((cfg.llmTimeoutMs || 180000) / 1000) + " 秒未返回)。可以调大 config.json 的 llmTimeoutMs,或换更快/更小的模型再试。"
          : e.message;
        console.log("[ask] 失败:" + msg);
        sendJson(res, { data: { answer: "<p><b>" + (aborted ? "AI 调用超时" : "后端出错") + ":</b>" + esc(msg) + "</p>" }, meta: { ms: Date.now() - t0, error: aborted ? "LLM_TIMEOUT" : "BACKEND_ERROR" } });
      }
    });
    return;
  }

  /* ---- 设置:读 ---- */
  if (req.method === "GET" && parsed.pathname === "/api/settings") {
    const cfg = loadConfig();
    const a = active(cfg);
    sendJson(res, {
      ok: true,
      activeProvider: cfg.activeProvider,
      active: { id: a.id, label: a.label, baseUrl: a.baseUrl, model: a.model, apiKeyMasked: mask(a.apiKey), hasKey: !!a.apiKey, vision: a.vision },
      providers: Object.entries(PRESETS).map(([id, p]) => {
        const cur = cfg.providers[id] || {};
        return { id, label: p.label, presetBaseUrl: p.baseUrl, presetModel: p.model, models: p.models || [],
                 baseUrl: cur.baseUrl || p.baseUrl || "", model: cur.model || p.model || "", hasKey: !!cur.apiKey, apiKeyMasked: mask(cur.apiKey) };
      }),
      systemPrompt: cfg.systemPrompt,
      image: { oneShot: cfg.imageOneShot, maxSide: cfg.imageMaxSide },
      // 工具额度:状态栏上方那一条直接读这里。三个都可以在页面上改,不用开 config.json。
      tool: { maxToolRounds: cfg.maxToolRounds, maxToolCalls: cfg.maxToolCalls, toolTimeoutMs: cfg.toolTimeoutMs },
      nx: {
        nxSkillRoot: cfg.nxSkillRoot, nxRoot: cfg.nxRoot, nxWorkspace: cfg.nxWorkspace,
        maxToolRounds: cfg.maxToolRounds, toolTimeoutMs: cfg.toolTimeoutMs,
        // 本机装了什么、哪个版本带内置 Copilot —— 由 nxdetect 扫出来,不写死版本号。
        // 这里走快路径(不翻卸载登记表),首屏才不会被那 2~3 秒拖住;
        // 精确版本(2606.1700 这种)只在原版页面加载 /local-config.js 时才算,见 /api/nxenv。
        detected: nxInfo(cfg)
      },
      tools: Object.keys(TOOLS)
    });
    return;
  }

  /* ---- 设置:写 ---- */
  if (req.method === "POST" && parsed.pathname === "/api/settings") {
    readBody(req, (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      const cfg = loadConfig();
      if (b.activeProvider) cfg.activeProvider = b.activeProvider;
      if (b.provider && b.provider.id) {
        const id = b.provider.id;
        const cur = cfg.providers[id] || {};
        const next = Object.assign({}, cur);
        if (typeof b.provider.baseUrl === "string") next.baseUrl = b.provider.baseUrl.trim();
        if (typeof b.provider.model === "string") next.model = b.provider.model.trim();
        // apiKey 为空字符串 = 不改动;传 null = 清空
        if (b.provider.apiKey === null) next.apiKey = "";
        else if (typeof b.provider.apiKey === "string" && b.provider.apiKey.trim()) next.apiKey = b.provider.apiKey.trim();
        cfg.providers[id] = next;
      }
      if (typeof b.systemPrompt === "string") cfg.systemPrompt = b.systemPrompt;
      if (b.nx) {
        for (const k of ["nxSkillRoot", "nxRoot", "nxWorkspace"]) if (typeof b.nx[k] === "string") cfg[k] = b.nx[k].trim();
        if (b.nx.maxToolRounds) cfg.maxToolRounds = Number(b.nx.maxToolRounds) || 8;
      }
      // 状态栏上方那条「工具额度」单独发过来:只带 tool / image,不动供应商与提示词。
      if (b.tool) {
        const clamp = (value, low, high, fallback) => {
          const n = Number(value);
          return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;
        };
        if (b.tool.maxToolRounds !== undefined) cfg.maxToolRounds = clamp(b.tool.maxToolRounds, 1, 50, cfg.maxToolRounds);
        if (b.tool.maxToolCalls !== undefined) cfg.maxToolCalls = clamp(b.tool.maxToolCalls, 1, 80, cfg.maxToolCalls);
        if (b.tool.toolTimeoutMs !== undefined) cfg.toolTimeoutMs = clamp(b.tool.toolTimeoutMs, 5000, 600000, cfg.toolTimeoutMs);
      }
      if (b.image) {
        if (typeof b.image.oneShot === "boolean") cfg.imageOneShot = b.image.oneShot;
        if (b.image.maxSide !== undefined) {
          const n = Number(b.image.maxSide);
          if (Number.isFinite(n)) cfg.imageMaxSide = Math.min(4096, Math.max(320, Math.round(n)));
        }
      }
      saveConfig(cfg);
      sendJson(res, { ok: true });
    });
    return;
  }

  /* ---- 设置:测试连接 ---- */
  if (req.method === "POST" && parsed.pathname === "/api/settings/test") {
    readBody(req, async (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      const cfg = loadConfig();
      // 允许用面板里尚未保存的值直接测
      if (b.provider && b.provider.id) {
        cfg.providers[b.provider.id] = Object.assign({}, cfg.providers[b.provider.id], {
          baseUrl: b.provider.baseUrl || (cfg.providers[b.provider.id] || {}).baseUrl,
          model: b.provider.model || (cfg.providers[b.provider.id] || {}).model
        });
        if (b.provider.apiKey && b.provider.apiKey.trim()) cfg.providers[b.provider.id].apiKey = b.provider.apiKey.trim();
        if (b.useThis) cfg.activeProvider = b.provider.id;
      }
      const a = active(cfg);
      const t0 = Date.now();
      try {
        const headers = { "Content-Type": "application/json" };
        if (a.apiKey) headers["Authorization"] = "Bearer " + a.apiKey;
        const r = await fetch(a.baseUrl + "/chat/completions", {
          method: "POST", headers,
          body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: "只回复两个字:正常" }], stream: false })
        });
        const txt = await r.text();
        let ok = r.ok, reply = "", extra = "";
        try {
          const j = JSON.parse(txt);
          reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
          if (!ok && j.error) extra = j.error.message || JSON.stringify(j.error).slice(0, 200);
        } catch (e) { extra = txt.slice(0, 200); }
        sendJson(res, { ok, ms: Date.now() - t0, provider: a.id, model: a.model, baseUrl: a.baseUrl, reply: String(reply).slice(0, 200), error: extra });
      } catch (e) {
        sendJson(res, { ok: false, ms: Date.now() - t0, provider: a.id, model: a.model, baseUrl: a.baseUrl, error: String(e.message || e) });
      }
    });
    return;
  }

  /* ---- 连通性自检(NX 面板里也能打开这个地址看) ---- */
  if (parsed.pathname === "/api/ping") {
    sendJson(res, { ok: true, time: new Date().toLocaleString("zh-CN"), provider: active(loadConfig()).label, tools: Object.keys(TOOLS).length });
    return;
  }

  /* ---- 本机安装识别:列出所有 Designcenter/NX 安装,标注哪些版本带内置 Copilot ---- */
  if (parsed.pathname === "/api/nxenv") {
    const info = nxInfo(loadConfig(), true, true);   // 显式请求:绕过缓存 + 取精确版本
    sendJson(res, {
      ok: true,
      active: info.active,
      installations: info.installations,
      note: "hasCopilot = 该安装里同时检出了页面/Copilot 资源目录与 NXBIN/libcopilot* 库"
    });
    return;
  }

  /* ---- 给原版页面(legacy.html)注入版本等运行时配置,替代写死的 2606.1700 ---- */
  if (parsed.pathname === "/local-config.js") {
    const cfg = loadConfig();
    const info = nxInfo(cfg);
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.end("window.__PLCHAT_LOCAL_CONFIG__ = " + JSON.stringify({
      version: pageVersion(cfg),
      release: (info.active && info.active.release) || "",
      product: "NX_X",
      backendUrl: "/api/ask",
      hasCopilot: !!(info.active && info.active.hasCopilot)
    }) + ";\n");
    return;
  }
  if (parsed.pathname === "/api/log") {
    sendJson(res, { ok: true, count: RECENT.length, recent: RECENT });
    return;
  }

  /* ---- 复核队列(页面面板用) ---- */
  if (req.method === "GET" && parsed.pathname === "/api/review") {
    const cfg = loadConfig();
    const ws = cfg.nxWorkspace || "";
    const dir = ws ? path.join(ws, "review") : "";
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
    const plan = dir ? readJson(path.join(dir, "plan.json")) : null;
    const log = dir ? readJson(path.join(dir, "run.json")) : null;
    const byId = {};
    const records = log && (Array.isArray(log.steps) ? log.steps : log.records);
    (Array.isArray(records) ? records : []).forEach(r => { byId[r.id] = r; });
    const steps = ((plan && plan.steps) || []).map(s => {
      const r = byId[s.id] || {};
      return { id: s.id, name: s.name, operation: s.operation, gate: s.gate, note: s.note || "",
               status: r.status || "pending", ms: Math.round((r.durationSeconds || 0) * 1000),
               message: r.message || "", screenshot: r.screenshot || "" };
    });
    // 直接读注册表:本进程的环境是启动时的快照,setx 之后不会更新,
    // 而新启动的 Designcenter 会从注册表拿到新值 —— 要比较的是后者。
    const envWs = machineEnv("NX_SKILL_WORKSPACE") || machineEnv("NX2512_PROJECT_ROOT") || machineEnv("DC2512_PROJECT_ROOT") || "";
    const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    sendJson(res, {
      ok: true, workspace: ws, reviewDir: dir,
      envWorkspace: envWs,
      workspaceMismatch: !!envWs && norm(envWs) !== norm(ws),
      planPath: dir ? path.join(dir, "plan.json") : "",
      hasPlan: !!plan,
      plan: plan ? { planId: plan.planId, prompt: plan.prompt || "", partPath: plan.partPath || "", created: plan.created } : null,
      steps, counts: (log && log.counts) || null, updated: (log && log.updated) || null,
      nextAction: plan ? "在 Designcenter 里打开:NX Skill → Review Plan" : "还没有计划。让 AI 出个计划并点「提交到复核队列」。"
    });
    return;
  }
  if (req.method === "POST" && parsed.pathname === "/api/review/clear") {
    readBody(req, async () => {
      const cfg = loadConfig();
      const r = await runNxSkill(cfg, ["review", "clear"], cfg.toolTimeoutMs);
      sendJson(res, { ok: (r.envelope && r.envelope.ok) || false, result: (r.envelope && r.envelope.result) || null, stderr: r.stderr || "" });
    });
    return;
  }

  /* ---- 清理 ---- */
  if (req.method === "POST" && parsed.pathname === "/api/cleanup") {
    readBody(req, (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      sendJson(res, runCleanup(b.scope || "all", "手动清理"));
    });
    return;
  }
  if (parsed.pathname === "/api/cleanup") { sendJson(res, { last: LAST_CLEANUP, policy: loadConfig().cleanupOnNxExit || "all", nxRunning: nxRunning() }); return; }

  /* ---- 进度 / 思维链 ---- */
  if (parsed.pathname === "/api/progress") {
    sendJson(res, {
      active: PROGRESS.active, kind: PROGRESS.kind, question: PROGRESS.question,
      stage: PROGRESS.stage, detail: PROGRESS.detail,
      elapsedMs: PROGRESS.started ? Date.now() - PROGRESS.started : 0,
      attempts: PROGRESS.attempts,
      tools: PROGRESS.tools.slice(-12),
      reasoning: [PROGRESS.reasoning.join("")]
    });
    return;
  }

  /* ---- 生成计划:默认异步(长请求会被浏览器/WebView2 掐断) ---- */
  if (req.method === "POST" && parsed.pathname === "/api/plan/author") {
    readBody(req, async (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      const t0 = Date.now();
      const run = async () => {
        try {
          const out = await authorPlan(loadConfig(), b.question || "", b.partName || "", b.sourcePlan || "");
          console.log("[author] " + (out.ok ? "成功 第" + out.attempt + "次 计划 " + out.planId : "失败: " + out.error) + " | " + (Date.now() - t0) + "ms");
          return Object.assign({ ms: Date.now() - t0 }, out);
        } catch (e) {
          progressEnd("failed");
          return { ok: false, error: String(e.message || e), ms: Date.now() - t0 };
        }
      };
      if (b.wait === true) { sendJson(res, await run()); return; }   // 调试用:同步等
      const id = "job" + (++JOB_SEQ);
      JOBS.set(id, { id, state: "running", started: Date.now(), question: b.question || "", result: null });
      sendJson(res, { ok: true, async: true, jobId: id });           // 立刻回,不再让前端干等
      run().then((r) => { const j = JOBS.get(id); if (j) { j.state = r.ok ? "done" : "failed"; j.result = r; j.ended = Date.now(); } });
      for (const [k, v] of JOBS) if (v.ended && Date.now() - v.ended > 3600000) JOBS.delete(k);
    });
    return;
  }
  if (req.method === "GET" && parsed.pathname === "/api/plan/author/status") {
    const id = parsed.query.id;
    const j = JOBS.get(id);
    if (!j) { sendJson(res, { ok: false, error: "unknown job" }); return; }
    sendJson(res, {
      ok: true, id: j.id, state: j.state, question: j.question,
      elapsedMs: (j.ended || Date.now()) - j.started,
      result: j.result
    });
    return;
  }

  /* ---- 自动执行当前队列里的计划(headless 批处理) ---- */
  if (req.method === "POST" && parsed.pathname === "/api/plan/run") {
    readBody(req, async (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      const cfg = loadConfig();
      const live = b.mode === "live";
      const run = async () => {
        const t0 = Date.now();
        try {
          const out = live ? await runPlanLive(cfg) : await runPlanBatch(cfg);
          console.log("[run] " + (out.ok ? "成功 零件 " + out.part : "失败: " + out.error) + " | " + (Date.now() - t0) + "ms");
          return Object.assign({ ms: Date.now() - t0 }, out);
        } catch (e) { progressEnd("failed"); return { ok: false, error: String(e.message || e), ms: Date.now() - t0 }; }
      };
      if (b.wait === true) { sendJson(res, await run()); return; }
      const id = "run" + (++JOB_SEQ);
      JOBS.set(id, { id, state: "running", started: Date.now(), result: null });
      sendJson(res, { ok: true, async: true, jobId: id });
      run().then((r) => { const j = JOBS.get(id); if (j) { j.state = r.ok ? "done" : "failed"; j.result = r; j.ended = Date.now(); } });
    });
    return;
  }
  if (req.method === "GET" && parsed.pathname === "/api/plan/run/status") {
    const j = JOBS.get(parsed.query.id);
    if (!j) { sendJson(res, { ok: false, error: "unknown job" }); return; }
    sendJson(res, { ok: true, id: j.id, state: j.state, elapsedMs: (j.ended || Date.now()) - j.started, result: j.result });
    return;
  }

  /* ---- 脚本预检(不写盘、不提交) ---- */
  if (req.method === "POST" && parsed.pathname === "/api/nxopen/check") {
    readBody(req, (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      const src = String(b.script || "");
      const idx = nxopenIndex();
      sendJson(res, {
        ok: true,
        indexSize: idx.size,
        syntax: (() => { const fsx = require("fs"), osx = require("os"); const f = path.join(osx.tmpdir(), "precheck_" + Date.now() + ".py"); fsx.writeFileSync(f, src, "utf8"); const r = require("child_process").spawnSync((loadConfig().python || "python"), ["-c", "import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)", f], { encoding: "utf8", windowsHide: true }); try { fsx.unlinkSync(f); } catch (e) { } return r.status === 0 ? { ok: true } : { ok: false, error: ((r.stderr || "") + (r.stdout || "")).trim().split("\n").slice(-5).join("\n") }; })(),
        api: checkNxOpenNames(src),
        imports: checkNxOpenImports(src),
        builder: checkBuilderBooleanMembers(stripNonCode(src), idx)
      });
    });
    return;
  }

  /* ---- 工具 ---- */
  if (parsed.pathname === "/api/tools") { sendJson(res, Object.keys(TOOLS)); return; }
  if (req.method === "POST" && parsed.pathname === "/api/tool") {
    readBody(req, async (raw) => {
      let b = {}; try { b = JSON.parse(raw || "{}"); } catch (e) { }
      sendJson(res, await execTool(loadConfig(), b.name, b.args || {}));
    });
    return;
  }

  if (parsed.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }

  let p = decodeURIComponent(parsed.pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }

  serve(file, res, () => {
    const base = path.basename(p);
    serve(path.join(ROOT, "plchat_v2", "assets", "images", base), res, () => {
      serve(path.join(ROOT, "plchat_v2", "assets", "config", base), res, () => {
        res.writeHead(404); res.end("not found: " + p);
      });
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  const cfg = loadConfig();
  const a = active(cfg);
  console.log("Designcenter Copilot 本地宿主: http://127.0.0.1:" + PORT + "/");
  console.log("当前供应商 = " + a.id + "(" + a.label + ") · 模型 = " + (a.model || "(未设)") + " · 工具 " + Object.keys(TOOLS).length + " 个");
  const pol = cfg.cleanupOnNxExit || "all";
  console.log("退出清理策略 cleanupOnNxExit = " + pol + " · 启动时先清一次运行残留");
  if (pol !== "off") runCleanup("scratch", "宿主启动");
  startNxExitWatcher();
});
