/**
 * probe.mjs —— 按"真实浏览器"的请求头复现手机路径，定位卡在哪一步。
 * 与 check.mjs 的区别：带 Origin / Sec-Fetch-* / 完整 Accept-Encoding，
 * 并且走 LAN IP 而不是 127.0.0.1，同时打印每一步耗时。
 *
 * 用法：CHECK_PASS=<口令> node probe.mjs [host:port]
 * 默认目标 127.0.0.1:3301（手机用的那个地址）。
 */
const TARGET = process.argv[2] ?? process.env.PROBE_TARGET ?? "127.0.0.1:3301";
const USER = process.env.CHECK_USER ?? "dsh";
const PASS = process.env.CHECK_PASS ?? "<password>";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const ORIGIN = `http://${TARGET}`;

const BROWSER = {
	Authorization: AUTH,
	Origin: ORIGIN,
	"Sec-Fetch-Site": "same-origin",
	"Sec-Fetch-Mode": "cors",
	"Sec-Fetch-Dest": "empty",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	"User-Agent":
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

async function timed(path, headers, timeoutMs = 8000) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${ORIGIN}${path}`, { headers, redirect: "manual", signal: controller.signal });
		const buf = Buffer.from(await res.arrayBuffer());
		return {
			status: res.status,
			ms: Date.now() - started,
			encoding: res.headers.get("content-encoding") ?? "-",
			length: buf.length,
			body: buf,
		};
	} catch (error) {
		return { status: 0, ms: Date.now() - started, error: String(error?.cause?.message ?? error.message), body: Buffer.alloc(0) };
	} finally {
		clearTimeout(timer);
	}
}

const show = (label, r) =>
	console.log(
		`  ${label.padEnd(28)} -> ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.length} B  enc=${r.encoding}` +
			(r.error ? `  ERROR: ${r.error}` : "")
	);

console.log(`目标: ${ORIGIN}（模拟手机浏览器）\n`);

console.log("=== A) 首页 ===");
const page = await timed("/", { ...BROWSER, Accept: "text/html,application/xhtml+xml" });
show("GET /", page);
const html = page.body.toString("utf8");
console.log(`  含 dsh-proxy-bootstrap : ${html.includes("dsh-proxy-bootstrap")}`);

console.log("\n=== B) 首页引用的插件 bundle ===");
const bundle = /\/plugins\/\?\?[^"']+/.exec(html)?.[0];
if (bundle) {
	const r = await timed(bundle.replaceAll("&amp;", "&"), { ...BROWSER, Accept: "*/*" });
	show("GET /plugins/??…", r);
} else {
	console.log("  未在 HTML 中找到 /plugins/?? 链接");
}

console.log("\n=== C) 主脚本资源 ===");
for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
	const r = await timed(m[1], { ...BROWSER, Accept: "*/*" });
	show(`GET ${m[1].slice(0, 26)}…`, r);
}

console.log("\n=== D) 客户端启动时要用的接口 ===");
for (const path of ["/api/__probe", "/api/remote.mux"]) {
	const r = await timed(path, { ...BROWSER, Accept: "*/*" }, 6000);
	show(`GET ${path}`, r);
}

console.log("\n=== E) WebSocket（带 Origin，模拟浏览器握手）===");
const wsResult = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timeout（8s 无响应 = 卡点在这）"), 8000);
	try {
		const ws = new WebSocket(`ws://${TARGET}/api/remote.mux`, { headers: { Authorization: AUTH, Origin: ORIGIN } });
		ws.addEventListener("open", () => { clearTimeout(timer); resolve("open (101)"); ws.close() });
		ws.addEventListener("error", (e) => { clearTimeout(timer); resolve(`error: ${e?.message ?? "握手失败"}`) });
	} catch (error) {
		clearTimeout(timer);
		resolve(`throw: ${error.message}`);
	}
});
console.log(`  ws://${TARGET}/api/remote.mux -> ${wsResult}`);
