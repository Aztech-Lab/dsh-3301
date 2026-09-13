/**
 * probe-gate.mjs —— 按"真实浏览器"复现手机路径，定位卡点（插件形态：表单登录 + cookie）。
 *
 * 用法：GATE_PASS=<口令> node probe-gate.mjs [host:port]
 * 默认目标 127.0.0.1:3301（手机用的那个地址，经 LAN 而非 loopback）。
 */
const TARGET = process.argv[2] ?? process.env.PROBE_TARGET ?? "127.0.0.1:3301";
const USER = process.env.GATE_USER ?? "dsh";
const PASS = process.env.GATE_PASS ?? (() => { const v = process.env.GATE_PASS; if (!v) throw new Error("set GATE_PASS to the gate password"); return v; })();
const ORIGIN = `http://${TARGET}`;

const BROWSER = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Encoding": "gzip, deflate, br",
	"User-Agent":
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

let cookie;

async function timed(label, path, headers = {}, timeoutMs = 8000) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${ORIGIN}${path}`, {
			headers: { ...BROWSER, ...headers, ...(cookie ? { cookie } : {}) },
			redirect: "manual",
			signal: controller.signal,
		});
		const body = Buffer.from(await response.arrayBuffer());
		console.log(
			`  ${label.padEnd(30)} -> ${String(response.status).padStart(3)}  ${String(Date.now() - started).padStart(5)}ms  ` +
				`${body.length} B  enc=${response.headers.get("content-encoding") ?? "-"}`
		);
		return { status: response.status, body };
	} catch (error) {
		console.log(`  ${label.padEnd(30)} -> 失败 ${String(error?.cause?.message ?? error.message)}`);
		return { status: 0, body: Buffer.alloc(0) };
	} finally {
		clearTimeout(timer);
	}
}

console.log(`目标 ${ORIGIN}（模拟手机浏览器）\n=== 表单登录 ===`);
const login = await fetch(`${ORIGIN}/__gate/login`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER },
	body: new URLSearchParams({ username: USER, password: PASS, next: "/" }).toString(),
	redirect: "manual",
});
const setCookie = login.headers.get("set-cookie");
if (setCookie) cookie = setCookie.split(";")[0];
console.log(`  POST /__gate/login             -> ${login.status}  cookie=${cookie ? "有" : "无"}`);
if (!cookie) {
	console.log("\n登录失败，后续步骤无意义。");
	process.exit(1);
}

console.log("\n=== 页面与资源 ===");
const page = await timed("GET /", "/");
const html = page.body.toString("utf8");
console.log(`  含 dsh-3301-bootstrap 注入   : ${html.includes("dsh-3301-bootstrap")}`);

const bundle = /\/plugins\/\?\?[^"']+/.exec(html)?.[0];
if (bundle) await timed("GET /plugins/??…", bundle.replaceAll("&amp;", "&"));

console.log("\n=== 客户端启动接口 ===");
await timed("GET /api/__probe", "/api/__probe");

console.log("\n=== WebSocket（带 Origin）===");
const wsResult = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timeout（卡点在这）"), 8000);
	try {
		const ws = new WebSocket(`ws://${TARGET}/api/remote.mux`, { headers: { cookie, Origin: ORIGIN } });
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve("open (101)");
			ws.close();
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			resolve(`error: ${event?.message ?? "握手失败"}`);
		});
	} catch (error) {
		clearTimeout(timer);
		resolve(`throw: ${error.message}`);
	}
});
console.log(`  ws://${TARGET}/api/remote.mux -> ${wsResult}`);
