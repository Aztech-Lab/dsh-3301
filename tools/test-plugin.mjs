/**
 * test-plugin.mjs —— 本地测试套件（不依赖浏览器、不影响现网门）。
 *
 * 在独立进程里用假 ctx 加载**部署副本**的 host 半部，起在测试端口上，
 * 然后按断言逐项验证：命名空间注册、tapIndex 注入、无口令放行、
 * 首次设置、用户名+口令登录、错口令、失败锁定、改口令仅限 loopback。
 *
 * 用法：node test-plugin.mjs [端口]    （默认 3396，store 用临时目录）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const PORT = Number(process.argv[2] ?? 3396);
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN = process.argv[3] ?? `${process.env.DSH_HOME ?? ""}/profiles/web/node_modules/dsh-3301/lib/plugin.js`;
const USER = "dsh";
const PASS = "test-pass-123";
const STORE = path.join(os.tmpdir(), `dsh-3301-test-${String(process.pid)}`);
process.env.DSH_PROXY_GATE_DIR = STORE;

let passed = 0;
let failed = 0;
const check = (label, condition, detail = "") => {
	if (condition) {
		passed += 1;
		console.log(`  ✅ ${label}`);
	} else {
		failed += 1;
		console.log(`  ❌ ${label}${detail === "" ? "" : `  (${detail})`}`);
	}
};

const mod = await import(pathToFileURL(PLUGIN).href);
console.log(`插件: ${PLUGIN}`);
console.log(`导出: ${Object.keys(mod).join(", ")}\n`);

let registeredNamespace;
let injected = "";
const fake = {
	logger: { info: () => {}, warn: (message) => console.log(`  [warn] ${message}`) },
	settings: {
		register(namespace, schema, options) {
			registeredNamespace = namespace;
			return { get: () => ({ ...(options?.base ?? {}) }), mutate: () => Promise.resolve(), subscribe: () => () => {} };
		},
	},
	webServer: {
		tapIndex(transform) {
			injected = transform('<!doctype html><html><head><base href="/"></head><body></body></html>');
			return () => {};
		},
	},
	connection: { authenticatedUrl: (base) => `${base}/?token=dry-run` },
	effect: (run) => run(),
	on: () => {},
};

console.log("=== 1) 装配 ===");
try {
	mod.apply(fake, {
		enabled: true,
		host: "127.0.0.1",
		port: PORT,
		sessionDays: 7,
		maxFailures: 3,
		lockoutMinutes: 1,
		injectClientBootstrap: true,
	});
	check("apply 未抛异常", true);
} catch (error) {
	check("apply 未抛异常", false, String(error));
}
check("命名空间为 dsh-3301", registeredNamespace === "dsh-3301", String(registeredNamespace));
check("tapIndex 注入了客户端兜底", injected.includes("dsh-3301-bootstrap") || injected.includes("__DSH_TRANSPORT__"), injected.slice(0, 120));
await new Promise((resolve) => setTimeout(resolve, 700));

let cookie;
async function call(pathname, options = {}) {
	const response = await fetch(`${BASE}${pathname}`, {
		redirect: "manual",
		...options,
		headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
	});
	const body = await response.text().catch(() => "");
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	return { status: response.status, body, location: response.headers.get("location") };
}
const form = (fields) => ({
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams(fields).toString(),
});

console.log("\n=== 2) 无口令：入口放行 ===");
const health1 = await call("/__gate/health");
const h1 = JSON.parse(health1.body);
check("health 报告未设置口令", health1.status === 200 && h1.hasPassword === false && h1.needsSetup === true, health1.body);
const anon = await call("/", { headers: { accept: "text/html" } });
check("无口令时 GET / 不被拦截（放行到上游）", anon.status === 502, `status=${String(anon.status)}`);
const loginPage = await call("/__gate/login");
check("登录页说明当前没有口令", loginPage.status === 200 && /没有口令/.test(loginPage.body), `status=${String(loginPage.status)}`);
const loginNoPw = await call("/__gate/login", form({ username: USER, password: "x", next: "/" }));
check("无口令时提交登录直接放行", loginNoPw.status === 303, `status=${String(loginNoPw.status)}`);

console.log("\n=== 3) 首次设置（loopback）===");
const setupPage = await call("/__gate/setup");
check("setup 页面可用", setupPage.status === 200 && /设置访问口令/.test(setupPage.body), `status=${String(setupPage.status)}`);
const mismatch = await call("/__gate/setup", form({ password: PASS, confirm: "other" }));
check("两次不一致被拒", mismatch.status === 400, `status=${String(mismatch.status)}`);
const setup = await call("/__gate/setup", form({ password: PASS, confirm: PASS }));
check("设置成功并直接登录", setup.status === 303 && cookie !== undefined, `status=${String(setup.status)}`);
const health2 = JSON.parse((await call("/__gate/health")).body);
check("health 报告已设置口令", health2.hasPassword === true && health2.needsSetup === false, JSON.stringify(health2));

console.log("\n=== 4) 有口令：登录校验 ===");
cookie = undefined;
const guarded = await call("/", { headers: { accept: "text/html" } });
check("未登录 GET / 跳转登录页", guarded.status === 303 && String(guarded.location).includes("/__gate/login"), `status=${String(guarded.status)}`);
const noUser = await call("/__gate/login", form({ password: PASS, next: "/" }));
check("缺用户名被拒", noUser.status === 401, `status=${String(noUser.status)}`);
const wrong = await call("/__gate/login", form({ username: USER, password: "nope", next: "/" }));
check("错口令被拒", wrong.status === 401, `status=${String(wrong.status)}`);
const good = await call("/__gate/login", form({ username: USER, password: PASS, next: "/" }));
check("正确凭据登录成功", good.status === 303 && cookie !== undefined, `status=${String(good.status)}`);
const withCookie = await call("/", { headers: { accept: "text/html" } });
check("带会话可进入（放行到上游）", withCookie.status === 502, `status=${String(withCookie.status)}`);

console.log("\n=== 5) 改口令（仅 loopback）===");
const status = JSON.parse((await call("/__gate/status")).body);
check("status 显示已设置及时间", status.set === true && typeof status.updatedAt === "string", JSON.stringify(status));
const badCurrent = await call("/__gate/password", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ current: "wrong", next: "another" }),
});
check("当前口令错误被拒", badCurrent.status === 403, `status=${String(badCurrent.status)}`);
const changed = await call("/__gate/password", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ current: PASS, next: PASS }),
});
check("当前口令正确则允许修改", changed.status === 200, `status=${String(changed.status)}`);

console.log("\n=== 5b) 清除口令（新口令留空）===");
const cleared = await call("/__gate/password", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ current: PASS, next: "" }),
});
const clearedBody = JSON.parse(cleared.body);
check("留空提交即清除口令", cleared.status === 200 && clearedBody.set === false, `${String(cleared.status)} ${cleared.body}`);
const openAgain = await call("/", { headers: { accept: "text/html" } });
check("清除后入口重新放行", openAgain.status === 502, `status=${String(openAgain.status)}`);
await call("/__gate/setup", form({ password: PASS, confirm: PASS }));
check("可再次设置口令（供后续用例）", JSON.parse((await call("/__gate/health")).body).hasPassword === true);

console.log("\n=== 6) 失败锁定（放在最后，会锁住本机 IP）===");
cookie = undefined;
const attempts = [];
for (let i = 0; i < 3; i += 1) {
	const attempt = await call("/__gate/login", form({ username: USER, password: "bad", next: "/" }));
	attempts.push(attempt.status);
}
console.log(`  （三次错误尝试的状态码：${attempts.join(", ")}）`);
console.log(`  （health: ${(await call("/__gate/health")).body}）`);
const locked = await call("/__gate/login", form({ username: USER, password: PASS, next: "/" }));
check("超过失败上限后被锁定", locked.status === 429, `status=${String(locked.status)}`);

console.log(`\n结果：通过 ${passed} · 失败 ${failed}`);
try {
	fs.rmSync(STORE, { recursive: true, force: true });
} catch {
	/* best effort */
}
process.exit(failed === 0 ? 0 : 1);
