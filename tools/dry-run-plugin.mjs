/**
 * dry-run-plugin.mjs —— 在 DSH 之外干跑 host 半部，快速暴露 apply 异常与登录流程问题。
 *
 * 用法：node dry-run-plugin.mjs [插件路径] [端口]
 * 默认跑部署副本（profile 里的那份，依赖才能解析），默认端口 3399。
 *
 * 用假 ctx 提供 settings/webServer/connection/effect/on 的最小面；
 * 因为 token 是假的，代理转发必然 502（这是预期的），本脚本只验证
 * apply 是否抛错、以及门自身的路由（health/status/password/login/权限）。
 */
import { pathToFileURL } from "node:url";

const target = process.argv[2] ?? "C:/Users/<you>/.dsh/profiles/web/node_modules/dsh-proxy/lib/plugin.js";
const PORT = Number(process.argv[3] ?? process.env.DRY_PORT ?? 3399);
const BASE = `http://127.0.0.1:${PORT}`;
const NEW_PASSWORD = "dry-run-pass";

const mod = await import(pathToFileURL(target).href);
console.log(`loaded ${target}`);
console.log(`exports: ${Object.keys(mod).join(", ")}`);

let registeredNamespace;
const fake = {
	logger: { info: (m) => console.log(`  [host] ${m}`), warn: (m) => console.log(`  [host:warn] ${m}`) },
	settings: {
		register(namespace, schema, options) {
			registeredNamespace = namespace;
			console.log(`  [host] settings.register(${namespace}) base=${JSON.stringify(options?.base)}`);
			return {
				get: () => ({ ...(options?.base ?? {}) }),
				mutate: () => Promise.resolve(),
				subscribe: () => () => {},
			};
		},
	},
	webServer: {
		tapIndex(transform) {
			const sample = transform("<!doctype html><html><head><base href=\"/\"></head><body></body></html>");
			console.log(`  [host] tapIndex registered; injection=${sample.includes("dsh-proxy-bootstrap") ? "present" : "MISSING"}`);
			return () => {};
		},
	},
	connection: {
		authenticatedUrl(base) {
			console.log(`  [host] authenticatedUrl(${base})`);
			return `${base}/?token=dry-run-token`;
		},
	},
	effect(run, label) {
		console.log(`  [host] effect(${label})`);
		return run();
	},
	on(event) {
		console.log(`  [host] on(${event})`);
	},
};

console.log("apply(...)");
try {
	mod.apply(fake, {
		enabled: true,
		host: "127.0.0.1",
		port: PORT,
		sessionDays: 1,
		maxFailures: 2,
		lockoutMinutes: 1,
		injectClientBootstrap: true,
	});
	console.log("apply returned without throwing ✅");
} catch (error) {
	console.error("APPLY THREW ❌");
	console.error(error);
	process.exit(1);
}

await new Promise((resolve) => setTimeout(resolve, 800));

let cookie;
async function call(path, options = {}) {
	const response = await fetch(`${BASE}${path}`, {
		redirect: "manual",
		...options,
		headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
	});
	const setCookie = response.headers.get("set-cookie");
	if (setCookie) cookie = setCookie.split(";")[0];
	return { status: response.status, body: await response.text().catch(() => ""), location: response.headers.get("location") };
}

const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);

console.log("\n门路由检查");
const health = await call("/__gate/health");
line("GET /__gate/health", `${health.status} ${health.body.slice(0, 90)}`);

const anon = await call("/");
line("GET / (未登录)", `${anon.status} -> ${anon.location ?? ""}`);

const status = await call("/__gate/status");
line("GET /__gate/status", `${status.status} ${status.body.slice(0, 90)}`);

const init = await call("/__gate/password", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ current: "", next: NEW_PASSWORD }),
});
line("POST /__gate/password", `${init.status} ${init.body.slice(0, 90)}`);

const wrong = await call("/__gate/login", {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ username: "dsh", password: "nope", next: "/" }).toString(),
});
line("POST /__gate/login (错口令)", `${wrong.status}（期望 401）`);

cookie = undefined;
const login = await call("/__gate/login", {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({ username: "dsh", password: NEW_PASSWORD, next: "/" }).toString(),
});
line("POST /__gate/login (正确)", `${login.status}, cookie=${cookie ? "有" : "无"}`);

const proxied = await call("/");
line("GET / (已登录, 真上游)", `${proxied.status}（假 token 预期 502）`);

console.log(`\n命名空间: ${registeredNamespace}`);
process.exit(0);
