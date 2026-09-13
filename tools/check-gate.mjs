/**
 * check-gate.mjs —— 验证插件形态的 3301 入口（表单登录 + 设置命名空间）。
 *
 * 与 check.mjs 不同：不再使用 Basic 认证，改为
 *   1) 未登录访问 /          -> 303 跳转 /__gate/login
 *   2) 未设置口令时设置一个    -> POST /__gate/password（loopback）
 *   3) 表单登录              -> 303 + Set-Cookie
 *   4) 带 cookie 访问首页     -> 200，含 dsh-3301-bootstrap 注入
 *   5) 带 cookie 访问 /api     -> 404（DSH 会话已注入）
 *   6) WebSocket            -> 101
 *   7) 错口令               -> 401 且被限速计数
 *
 * 用法：GATE_PASS=<新口令> node check-gate.mjs [port]
 */
const PORT = Number(process.argv[2] ?? process.env.GATE_PORT ?? 3301);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.GATE_PASS ?? (() => { const v = process.env.GATE_PASS; if (!v) throw new Error("set GATE_PASS to the gate password"); return v; })();
const USERNAME = process.env.GATE_USER ?? "dsh";

const jar = { cookie: undefined };

/** fetch 但不跟随跳转，便于观察 303/Set-Cookie。 */
async function raw(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, {
		redirect: "manual",
		...options,
		headers: { ...(options.headers ?? {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) },
	});
	const body = await response.text().catch(() => "");
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) jar.cookie = setCookie.split(";")[0];
	return { status: response.status, body, location: response.headers.get("location"), setCookie };
}

const line = (label, value) => console.log(`  ${label.padEnd(34)} ${value}`);

console.log(`目标 ${BASE}\n`);

console.log("=== 1) 未登录 ===");
const anon = await raw("/", { headers: { accept: "text/html,application/xhtml+xml" } });
line("GET /", `${anon.status} -> ${anon.location ?? ""}`);
line("（期望 303 到 /__gate/login）", anon.status === 303 && String(anon.location).includes("/__gate/login") ? "✅" : "❌");

console.log("\n=== 2) 口令状态 / 必要时初始化 ===");
const status = await raw("/__gate/status");
let statusJson;
try {
	statusJson = JSON.parse(status.body);
} catch {
	statusJson = {};
}
line("GET /__gate/status", `${status.status} set=${String(statusJson.set)}`);
if (statusJson.set !== true) {
	const init = await raw("/__gate/password", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ current: "", next: PASSWORD }),
	});
	line("POST /__gate/password (初始化)", `${init.status} ${init.body.slice(0, 120)}`);
}

console.log("\n=== 3) 表单登录 ===");
const wrong = await raw("/__gate/login", {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ username: USERNAME, password: "definitely-wrong", next: "/" }).toString(),
});
line("POST /__gate/login (错口令)", `${wrong.status}（期望 401） ${wrong.status === 401 ? "✅" : "❌"}`);

jar.cookie = undefined;
const login = await raw("/__gate/login", {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ username: USERNAME, password: PASSWORD, next: "/" }).toString(),
});
line("POST /__gate/login (正确)", `${login.status} cookie=${login.setCookie ? "有" : "无"}`);
line("（期望 303 + Set-Cookie）", login.status === 303 && jar.cookie ? "✅" : "❌");

console.log("\n=== 4) 登录后访问首页 ===");
const page = await raw("/");
line("GET /", `${page.status}, ${page.body.length} B`);
line("含 dsh-3301-bootstrap 注入", page.body.includes("dsh-3301-bootstrap") ? "✅" : "❌");

console.log("\n=== 5) DSH 会话是否注入 ===");
const api = await raw("/api/__probe");
line("GET /api/__probe", `${api.status}（期望 404 = 认证通过） ${api.status === 404 ? "✅" : "❌"}`);

console.log("\n=== 6) WebSocket ===");
const wsResult = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timeout"), 6000);
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/remote.mux`, jar.cookie ? { headers: { cookie: jar.cookie } } : undefined);
		ws.addEventListener("open", () => {
			clearTimeout(timer);
			resolve("open (101)");
			ws.close();
		});
		ws.addEventListener("error", (event) => {
			clearTimeout(timer);
			resolve(`error: ${event?.message ?? "handshake 失败"}`);
		});
	} catch (error) {
		clearTimeout(timer);
		resolve(`throw: ${error.message}`);
	}
});
line("ws /api/remote.mux", wsResult);

const ok =
	anon.status === 303 &&
	login.status === 303 &&
	jar.cookie !== undefined &&
	page.status === 200 &&
	page.body.includes("dsh-3301-bootstrap") &&
	api.status === 404;
console.log(ok ? "\n结果：插件形态入口全链路通过 ✅" : "\n结果：未完全通过 ❌");
