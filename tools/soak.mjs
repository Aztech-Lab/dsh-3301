/**
 * soak.mjs —— 压力/健壮性测试：专门复现刚才那次"代理崩掉"的场景。
 *
 * 做法：多轮并发地发真实浏览器式请求，并且**故意中途取消**请求
 * （客户端断开会让上游响应流触发 error —— 这正是之前未处理的致命路径），
 * 最后再确认代理仍然活着。
 *
 * 用法：CHECK_PASS=<口令> node soak.mjs [host:port] [轮数]
 */
const TARGET = process.argv[2] ?? process.env.PROBE_TARGET ?? "127.0.0.1:3301";
const ROUNDS = Number(process.argv[3] ?? 6);
const USER = process.env.CHECK_USER ?? "dsh";
const PASS = process.env.CHECK_PASS ?? "<password>";
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const ORIGIN = `http://${TARGET}`;

const BROWSER = {
	Authorization: AUTH,
	Origin: ORIGIN,
	"Sec-Fetch-Site": "same-origin",
	"Accept-Encoding": "gzip, deflate, br",
	Accept: "text/html,application/xhtml+xml",
	"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
};

let ok = 0;
let aborted = 0;
let failed = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
	// 1) 正常请求
	const normal = await fetch(`${ORIGIN}/`, { headers: BROWSER, redirect: "manual" }).catch((e) => ({ status: 0, err: e.message }));
	const normalOut = [normal.status, normal.body ? await normal.text() : ""];
	if (normalOut[0] === 200 && normalOut[1].includes("dsh-proxy-bootstrap")) ok += 1;
	else {
		failed += 1;
		console.log(`  第 ${round} 轮 正常请求失败: status=${normalOut[0]}`);
	}

	// 2) 中途取消（模拟用户在加载时离开 / 浏览器取消请求）
	for (let i = 0; i < 3; i += 1) {
		const controller = new AbortController();
		const p = fetch(`${ORIGIN}/`, { headers: BROWSER, signal: controller.signal }).catch(() => undefined);
		setTimeout(() => controller.abort(), 3 + i);
		await p;
		aborted += 1;
	}

	// 3) WebSocket 握手（成功即关闭，模拟浏览器反复重连）
	await new Promise((resolve) => {
		const timer = setTimeout(resolve, 4000);
		try {
			const ws = new WebSocket(`ws://${TARGET}/api/remote.mux`, { headers: { Authorization: AUTH, Origin: ORIGIN } });
			ws.addEventListener("open", () => { clearTimeout(timer); ws.close(); resolve(); });
			ws.addEventListener("error", () => { clearTimeout(timer); resolve(); });
		} catch {
			clearTimeout(timer);
			resolve();
		}
	});

	process.stdout.write(`  第 ${round}/${ROUNDS} 轮完成：正常 ${ok} · 主动取消 ${aborted} · 失败 ${failed}\r`);
}

console.log();
const alive = await fetch(`${ORIGIN}/`, { headers: BROWSER, redirect: "manual" }).catch((e) => ({ status: 0, err: e.message }));
const body = alive.status === 200 ? await alive.text() : "";
const stillAlive = alive.status === 200 && body.includes("dsh-proxy-bootstrap");
console.log(`\n结果：正常请求成功 ${ok} 次，主动取消 ${aborted} 次，失败 ${failed} 次`);
console.log(stillAlive ? "代理仍然存活 ✅（客户端中断不再杀进程）" : `代理已不可用 ❌ status=${alive.status} ${alive.err ?? ""}`);
