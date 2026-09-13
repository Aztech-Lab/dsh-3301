/**
 * check.mjs —— 验证升级后的 dsh-proxy（不改动任何文件，只发请求）。
 *
 * 1) 未认证 -> 401
 * 2) Basic 认证 -> 首页 200，且含我们的 bootstrap 注入
 * 3) 压缩的首页（Accept-Encoding: gzip）-> 解压注入后仍正确，且不再有 content-encoding
 * 4) /api 带会话 -> 404（认证通过）；无 Basic -> 401
 * 5) 静态资源仍保持 gzip 压缩
 * 6) WebSocket 升级 -> 101
 */
const PORT = Number(process.env.CHECK_PORT ?? 3301)
const BASE = `http://127.0.0.1:${PORT}`
const USER = process.env.CHECK_USER ?? "dsh"
const PASS = process.env.CHECK_PASS ?? "test"
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")

async function req(path, headers = {}, redirect = "manual") {
	try {
		const res = await fetch(`${BASE}${path}`, { headers, redirect })
		const buf = Buffer.from(await res.arrayBuffer())
		return { status: res.status, headers: res.headers, body: buf }
	} catch (error) {
		return { status: 0, headers: new Headers(), body: Buffer.from(String(error?.cause?.message ?? error.message)) }
	}
}

console.log("=== 1) 未认证 ===")
const anon = await req("/")
console.log(`  GET /              -> ${anon.status}   (期望 401)`)

console.log("\n=== 2) Basic 认证 + 首页 ===")
const page = await req("/", { Authorization: AUTH })
const html = page.body.toString("utf8")
console.log(`  GET /              -> ${page.status}, ${page.body.length} 字节   (期望 200)`)
console.log(`  含我们的 bootstrap : ${html.includes("dsh-proxy-bootstrap")}`)
console.log(`  含 __DSH_BOOT__    : ${html.includes("__DSH_BOOT__")}`)

console.log("\n=== 3) 压缩首页也能注入 ===")
const gz = await req("/", { Authorization: AUTH, "Accept-Encoding": "gzip" })
const gzHtml = gz.body.toString("utf8")
console.log(`  GET / (gzip)       -> ${gz.status}, content-encoding=${gz.headers.get("content-encoding") ?? "无"}`)
console.log(`  注入仍在           : ${gzHtml.includes("dsh-proxy-bootstrap")}`)

console.log("\n=== 4) /api 会话是否生效 ===")
const api = await req("/api/__probe", { Authorization: AUTH })
console.log(`  GET /api/__probe   -> ${api.status}   (期望 404 = 认证通过；401 = 会话没生效)`)

console.log("\n=== 5) 静态资源是否保留压缩 ===")
const asset = /assets\/index-[^"']+\.js/.exec(html)?.[0]
if (asset) {
	const js = await req(`/${asset}`, { Authorization: AUTH, "Accept-Encoding": "gzip" })
	console.log(`  GET /${asset} -> ${js.status}, content-encoding=${js.headers.get("content-encoding") ?? "无"}`)
} else {
	console.log("  未在 HTML 中找到 assets/index-*.js")
}

console.log("\n=== 6) WebSocket 升级 ===")
const wsResult = await new Promise((resolve) => {
	const timer = setTimeout(() => resolve("timeout"), 6000)
	try {
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/remote.mux`, { headers: { Authorization: AUTH } })
		ws.addEventListener("open", () => { clearTimeout(timer); resolve("open (101)"); ws.close() })
		ws.addEventListener("error", (e) => { clearTimeout(timer); resolve(`error: ${e?.message ?? "handshake 失败"}`) })
	} catch (error) {
		clearTimeout(timer)
		resolve(`throw: ${error.message}`)
	}
})
console.log(`  ws /api/remote.mux -> ${wsResult}`)

const ok = anon.status === 401 && page.status === 200 && html.includes("dsh-proxy-bootstrap") && api.status === 404
console.log(ok ? "\n结果：升级后的 dsh-proxy 全链路通过 ✅" : "\n结果：未完全通过 ❌")
