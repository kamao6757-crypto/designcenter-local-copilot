/* 自测:文本形式的工具调用(含 DeepSeek 的 DSML)能不能被认出来并清干净。
 *
 * 为什么值得一个测试:实测 2026-09-21,带图提问时 deepseek-chat 会把整段 DSML
 * 写进 content(而不是 tool_calls)，结果是工具没执行、几千字裸标记还漏给了用户。
 * 这两条路径都必须有断言。
 *
 * 跑法:node tools/test-tool-markup.js
 */
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function slice(startMarker, endAfter, fromMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error("找不到 " + startMarker);
  const from = fromMarker ? source.indexOf(fromMarker, start) : start;
  if (from < 0) throw new Error("找不到 " + fromMarker);
  const end = source.indexOf(endAfter, from);
  if (end < 0) throw new Error("找不到结束标记 " + endAfter);
  return source.slice(start, end + endAfter.length);
}

// 从 DSML 常量开始,一直切到 stripToolMarkup 结尾 —— 三样东西必须一起 eval。
const code = slice("const DSML_BAR", "\n}\n", "function stripToolMarkup");
const factory = new Function(code + "\nreturn { DSML_TAG, parseTextToolCalls, stripToolMarkup };");
const { DSML_TAG, parseTextToolCalls, stripToolMarkup } = factory();

const B = DSML_TAG;
const OPEN = (name) => "<" + B + "invoke name=\"" + name + "\">";
const PARAM = (key, value) => "<" + B + "parameter name=\"" + key + "\">" + value + "</" + B + "parameter>";
const CLOSE = "</" + B + "invoke>";

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log("  ok   " + label); }
  else { failed += 1; console.log("  FAIL " + label + (detail ? " -> " + detail : "")); }
}

console.log("DSML 形式（实测里 deepseek-chat 写进正文的形状）:");
const dsml = "好的,我先查一下。\n" + OPEN("nx_status") + "\n" + PARAM("verbose", "true") + "\n" + CLOSE + "\n然后继续。";
const calls = parseTextToolCalls(dsml);
check("解析出 1 个工具调用", calls.length === 1, "得到 " + calls.length);
check("工具名正确", calls[0] && calls[0].function.name === "nx_status", calls[0] && calls[0].function.name);
check("参数被解析成 JSON", calls[0] && JSON.parse(calls[0].function.arguments).verbose === true,
  calls[0] && calls[0].function.arguments);

console.log("清理:");
const cleaned = stripToolMarkup(dsml);
check("不留标记", cleaned.indexOf(B) < 0, cleaned);
check("保留正文", cleaned.indexOf("我先查一下") >= 0 && cleaned.indexOf("然后继续") >= 0, cleaned);
check("不留参数值", cleaned.indexOf("true") < 0, cleaned);

console.log("多个调用:");
const two = OPEN("nx_status") + PARAM("a", "1") + CLOSE + OPEN("nx_route_intent") + PARAM("prompt", "法兰盘") + CLOSE;
const twoCalls = parseTextToolCalls(two);
check("解析出 2 个工具调用", twoCalls.length === 2, "得到 " + twoCalls.length);
check("第二个名字正确", twoCalls[1] && twoCalls[1].function.name === "nx_route_intent");
check("中文参数无损", twoCalls[1] && JSON.parse(twoCalls[1].function.arguments).prompt === "法兰盘");

console.log("旧的 function 形式:");
const legacy = "先查文档\n<function=nx_docs_search><parameter=query>ExtrudeBuilder</parameter></function>";
const legacyCalls = parseTextToolCalls(legacy);
check("解析出 1 个工具调用", legacyCalls.length === 1, "得到 " + legacyCalls.length);
check("工具名正确", legacyCalls[0] && legacyCalls[0].function.name === "nx_docs_search");
check("参数正确", legacyCalls[0] && JSON.parse(legacyCalls[0].function.arguments).query === "ExtrudeBuilder");
check("清理后只剩正文", stripToolMarkup(legacy) === "先查文档", JSON.stringify(stripToolMarkup(legacy)));

console.log("不误伤:");
check("普通文本原样返回", stripToolMarkup("普通回答,没有标记。") === "普通回答,没有标记。");
check("没有标记时解析为空", parseTextToolCalls("普通回答").length === 0);
check("非字符串输入不抛异常", parseTextToolCalls(null).length === 0);
check("代码块里的尖括号不动", stripToolMarkup("看这段: a < b && c > d").indexOf("a < b && c > d") >= 0);
check("markdown 分隔线不被吃掉", stripToolMarkup("正文\n\n---\n") === "正文\n\n---", JSON.stringify(stripToolMarkup("正文\n\n---\n")));

console.log("被截断的标记碎片（实测 2026-09-21 回答末尾吊着五行 < / </）:");
const truncated = "正文最后一句。\n<\n<\n<\n</\n</";
check("结尾碎片被削掉", stripToolMarkup(truncated) === "正文最后一句。", JSON.stringify(stripToolMarkup(truncated)));
const withCode = "结论如下。\n\n```\nif (a < b) {}\n```";
check("正文里的代码块不动", stripToolMarkup(withCode).indexOf("if (a < b) {}") >= 0, JSON.stringify(stripToolMarkup(withCode)));

console.log("\n通过 " + passed + " 项,失败 " + failed + " 项。");
process.exit(failed ? 1 : 0);
