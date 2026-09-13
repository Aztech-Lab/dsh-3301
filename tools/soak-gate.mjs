/**
 * soak-gate.mjs —— 插件形态的健壮性测试：多轮并发请求 + **故意中途取消** + WebSocket 反复握手，
 * 最后确认门仍然存活（历史 bug：未处理的流错误会杀掉进程）。
 *
 * 用法：GATE_PASS=<口令> node soak-gate.mjs [host:port] [轮数]
 */
const TARGET = process.argv[2] ?? process.env.PROBE_TARGET ?? "127.0.0.1:3301";
const ROUNDS = Number(process.argv[3] ?? 5);
const USER = process.env.GATE_USER ?? "dsh";
const PASS = process.env.GATE_PASS ?? (() => { const v = process.env.GATE_PASS; if (!v) throw new Error("set GATE_PASS to the gate password"); return v; })();
const ORIGIN = `http://${TARGET}`;

const BROWSER = {
	Accept: "text/html,application/xhtml+xml",
	"Accept-Encoding": "gzip, deflate, br",
	"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
};

const login = await fetch(`${ORIGIN}/__gate/login`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded", ...BROWSER },
	body: new URLSearchParams({ username: USER, password: PASS, next: "/" }).toString(),
	redirect: "manual",
});
const setCookie = login.headers.get("set-cookie");
if (!setCookie) {
	console.log(`登录失败（${login.status}），无法压测。`);
	process.exit(1);
}
const cookie = setCookie.split(";")[0];
console.log(`登录成功，开始 ${ROUNDS} 轮压测（含中途取消）…`);

let ok = 0;
let aborted = 0;
let failed = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
	try {
		const page = await fetch(`${ORIGIN}/`, { headers: { ...BROWSER, cookie }, redirect: "manual" });
		const body = await page.text();
		if (page.status === 200 && body.includes("dsh-3301-bootstrap")) ok += 1;
		else {
			failed += 1;
			console.log(`  第 ${round} 轮 正常请求异常: status=${page.status}`);
		}
	} catch (error) {
		failed += 1;
		console.log(`  第 ${round} 轮 请求失败: ${String(error?.cause?.message ?? error.message)}`);
	}

	for (let i = 0; i < 3; i += 1) {
		const controller = new AbortController();
		const pending = fetch(`${ORIGIN}/`, { headers: { ...BROWSER, cookie }, signal: controller.signal }).catch(() => undefined);
		setTimeout(() => controller.abort(), 3 + i);
		await pending;
		aborted += 1;
	}

	await new Promise((resolve) => {
		const timer = setTimeout(resolve, 4000);
		try {
			const ws = new WebSocket(`ws://${TARGET}/api/remote.mux`, { headers: { cookie, Origin: ORIGIN } });
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				ws.close();
				resolve();
			});
			ws.addEventListener("error", () => {
				clearTimeout(timer);
				resolve();
			});
		} catch {
			clearTimeout(timer);
			resolve();
		}
	});

	process.stdout.write(`  第 ${round}/${ROUNDS} 轮：正常 ${ok} · 取消 ${aborted} · 失败 ${failed}\r`);
}

console.log();
const health = await fetch(`${ORIGIN}/__gate/health`).catch(() => undefined);
const payload = health ? await health.json().catch(() => undefined) : undefined;
const alive = health?.status === 200 && payload?.ok === true;
console.log(`\n结果：正常 ${ok} · 中途取消 ${aborted} · 失败 ${failed}`);
console.log(
	alive
		? `门仍然存活 ✅（password=${String(payload.hasPassword)} sessionDays=${String(payload.sessionDays)}）`
		: `门已不可用 ❌ status=${String(health?.status)}`
);
