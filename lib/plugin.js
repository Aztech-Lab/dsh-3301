/**
 * dsh-3301 — DSH host half: the LAN gate plugin.
 *
 * Replaces the standalone listener with an in-process plugin, which removes
 * three moving parts the CLI needed:
 *   - **DSH session** comes from `ctx.connection.authenticatedUrl()` — the same
 *     API `dsh-web-app` prints at startup — so no credential file is read.
 *   - **Client bootstrap** rides `ctx.webServer.tapIndex()`, i.e. it is injected
 *     before the webserver compresses the page, so no HTML buffering.
 *   - **Lifecycle** is a plugin fiber: no scheduled task, no separate process.
 *
 * The gate itself keeps the hardened model: a form login (the password crosses
 * the wire once per login instead of on every Basic-auth request), a signed
 * HttpOnly session cookie, per-IP failure lockout, and a password that exists
 * only as a scrypt verifier (see `gate-auth.js`). Changing the password is
 * limited to loopback callers.
 *
 * Settings namespace `dsh-3301` is registered with the settings service,
 * so the browser half (`lib/client.js`) can render an editable card in
 * Settings → Plugins and values persist through the deployment's settings store.
 */
import http from "node:http";
import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { bootstrapSource, injectBootstrap } from "./client-bootstrap.js";
import { clearPassword, hasPassword, passwordInfo, sessionSecret, setPassword, verifyPassword } from "./gate-auth.js";

/** Stable Cordis plugin name. */
export const name = "dsh-3301";
/** Services required: the webserver for the bootstrap tap, connection for the session, settings for the namespace. */
export const inject = ["webServer", "connection", "settings"];

/** Settings namespace backing the browser card. */
export const GATE_NAMESPACE = "dsh-3301";
const COOKIE_NAME = "dsh_3301";
const BASE_PATH = "/__gate";
const LOGIN_PATH = `${BASE_PATH}/login`;
const LOGOUT_PATH = `${BASE_PATH}/logout`;
const HEALTH_PATH = `${BASE_PATH}/health`;
const STATUS_PATH = `${BASE_PATH}/status`;
const PASSWORD_PATH = `${BASE_PATH}/password`;
/** First-use password creation; loopback callers only. */
const SETUP_PATH = `${BASE_PATH}/setup`;
const UPSTREAM = { host: "127.0.0.1", port: 3080 };
const UPSTREAM_AUTHORITY = `${UPSTREAM.host}:${UPSTREAM.port}`;
const DSH_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Composition config and settings schema. Every field is user-tunable at
 * runtime through the settings namespace the plugin registers.
 */
export const Config = z.object({
	enabled: z.boolean().default(true),
	host: z.string().default("0.0.0.0"),
	port: z.natural().min(1).max(65535).default(3301),
	/** Login name shown on the gate form; the password remains the real secret. */
	username: z.string().default("dsh"),
	sessionDays: z.natural().min(1).max(3650).default(30),
	maxFailures: z.natural().min(1).default(5),
	lockoutMinutes: z.natural().min(1).default(5),
	injectClientBootstrap: z.boolean().default(true),
	/** Optional operator-supplied hint shown beside the password field; empty by default. */
	passwordHint: z.string().default(""),
});

const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function sanitizeHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(key.toLowerCase())) continue;
		// Never let a DSH session cookie reach the browser: the gate injects its own.
		if (key.toLowerCase() === "set-cookie") {
			const kept = (Array.isArray(value) ? value : [value]).filter((entry) => !/^dsh-auth-/i.test(String(entry)));
			if (kept.length === 0) continue;
			out[key] = kept;
			continue;
		}
		out[key] = value;
	}
	return out;
}

function loopbackPeer(req) {
	const address = req.socket?.remoteAddress ?? "";
	return address === "::1" || address === "127.0.0.1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function headerToken(request, name) {
	const header = request.headers.cookie;
	if (typeof header !== "string") return undefined;
	for (const segment of header.split(";")) {
		const at = segment.indexOf("=");
		if (at === -1) continue;
		if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
	}
	return undefined;
}

function sameSecret(a, b) {
	const left = Buffer.from(String(a));
	const right = Buffer.from(String(b));
	return left.length === right.length && timingSafeEqual(left, right);
}

export function apply(ctx, config) {
	// Registering the namespace is the one step that can fail from configuration
	// alone (schema mismatch, service refusal). Falling back to the composition
	// config keeps the gate usable instead of failing the whole plugin fiber.
	let scope;
	try {
		scope = ctx.settings.register(GATE_NAMESPACE, Config, { base: config ?? {} });
	} catch (error) {
		ctx.logger?.warn?.(
			`dsh-3301: settings namespace registration failed (${error instanceof Error ? error.message : String(error)}); ` +
				`using the composition config only`
		);
		const fallback = { ...(config ?? {}) };
		scope = { get: () => fallback, update: () => {}, replace: () => {}, mutate: () => Promise.resolve(), subscribe: () => () => {} };
	}
	const settings = () => scope.get() ?? {};
	const log = {
		info: (message) => ctx.logger?.info?.(message),
		warn: (message) => ctx.logger?.warn?.(message),
	};

	// ── gate session cookie ────────────────────────────────────────────────
	const sign = (value) => crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
	const issueSession = () => {
		const value = crypto.randomBytes(24).toString("base64url");
		return `${value}.${sign(value)}`;
	};
	const validSession = (request) => {
		const token = headerToken(request, COOKIE_NAME);
		if (typeof token !== "string") return false;
		const at = token.lastIndexOf(".");
		if (at <= 0) return false;
		return sameSecret(token.slice(at + 1), sign(token.slice(0, at)));
	};
	/**
	 * A request may proceed when the gate has no password at all — protecting the
	 * entry is the operator's choice — or when it carries a valid session cookie.
	 */
	const authorized = (request) => !hasPassword() || validSession(request);
	const sessionCookie = (token, days) =>
		`${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(days * 24 * 3600)}`;

	// ── DSH session, minted through the official in-process API ────────────
	let dshCookie;
	let dshCookieAt = 0;
	let dshPending;
	function acquireDshCookie(force = false) {
		if (!force && dshCookie !== undefined && Date.now() - dshCookieAt < DSH_SESSION_TTL_MS) return Promise.resolve(dshCookie);
		if (dshPending !== undefined) return dshPending;
		dshPending = new Promise((resolve) => {
			let entry;
			try {
				entry = new URL(ctx.connection.authenticatedUrl(`http://${UPSTREAM_AUTHORITY}`));
			} catch (error) {
				log.warn(`dsh-3301: token URL unavailable: ${String(error)}`);
				resolve(dshCookie);
				return;
			}
			const exchange = http.request(
				{
					host: UPSTREAM.host,
					port: UPSTREAM.port,
					path: `${entry.pathname}${entry.search}`,
					method: "GET",
					headers: { Host: UPSTREAM_AUTHORITY },
				},
				(res) => {
					res.resume();
					const set = res.headers["set-cookie"];
					const value = Array.isArray(set) ? set.find((entry) => /^dsh-auth-/i.test(entry)) : undefined;
					if (value !== undefined) {
						dshCookie = value.split(";")[0];
						dshCookieAt = Date.now();
					} else {
						log.warn(`dsh-3301: session exchange returned status ${String(res.statusCode)} without a cookie`);
					}
					resolve(dshCookie);
				}
			);
			exchange.on("error", (error) => {
				log.warn(`dsh-3301: session exchange failed: ${error.message}`);
				resolve(dshCookie);
			});
			exchange.end();
		}).finally(() => {
			dshPending = undefined;
		});
		return dshPending;
	}

	// ── failure lockout ───────────────────────────────────────────────────
	const failures = new Map();
	/**
	 * One peer key per client. Node reports the same loopback client as either
	 * `127.0.0.1` or `::ffff:127.0.0.1` depending on the bind address family, and
	 * two keys would split the failure count so the lockout never triggers.
	 */
	const peerOf = (req) => String(req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
	const locked = (ip) => {
		const entry = failures.get(ip);
		if (entry === undefined) return false;
		// `until === 0` means failures are still being counted, not that a lock
		// expired: deleting here would reset the count on every attempt and the
		// lockout would never trigger.
		if (entry.until === 0) return false;
		if (entry.until > Date.now()) return true;
		failures.delete(ip);
		return false;
	};
	const recordFailure = (ip, max, lockoutMs) => {
		const entry = failures.get(ip) ?? { count: 0, until: 0 };
		entry.count += 1;
		if (entry.count >= max) {
			entry.until = Date.now() + lockoutMs;
			entry.count = 0;
			log.warn(`dsh-3301: locked out ${ip} for ${String(Math.round(lockoutMs / 60000))}min`);
		}
		failures.set(ip, entry);
	};

	const loginPage = (failed, next, username) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-3301 · DSH 局域网入口</title>
<style>body{font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#eee}
form{background:#1c1c1e;padding:26px;border-radius:14px;min-width:250px}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;margin-top:12px;border-radius:8px;border:1px solid #444;background:#2a2a2c;color:#eee}
button{background:#3b6ef0;border-color:#3b6ef0;cursor:pointer}p{margin:0 0 6px}p.err{color:#ff6b6b}</style>
<form method="POST" action="${LOGIN_PATH}">
<h3 style="margin:0 0 6px">dsh-3301 局域网入口</h3>
${failed ? '<p class="err">凭据不对</p>' : '<p style="color:#999">输入访问凭据</p>'}
<input type="hidden" name="next" value="${next.replaceAll('"', "&quot;")}">
<input type="text" name="username" value="${String(username ?? "dsh").replaceAll('"', "&quot;")}" autocomplete="username" placeholder="用户名">
<input type="password" name="password" autofocus autocomplete="current-password" placeholder="口令">
<button type="submit">进入</button></form>`;

	/** Shared inline styling for the gate's own pages. */
	const PAGE_STYLE = `body{font:16px/1.6 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#eee}
form{background:#1c1c1e;padding:26px;border-radius:14px;min-width:260px;max-width:340px}
input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px;margin-top:12px;border-radius:8px;border:1px solid #444;background:#2a2a2c;color:#eee}
button{background:#3b6ef0;border-color:#3b6ef0;cursor:pointer}
p{margin:0 0 6px}p.err{color:#ff6b6b}p.hint{color:#999;font-size:13px;line-height:1.5}`;

	/**
	 * First-use password creation, served to loopback callers only. The gate ships
	 * with no password and refuses every login until one exists, so this page is
	 * the only way in — and it is reachable only from the machine running DSH.
	 */
	const setupPage = (invalid) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-3301 · 首次设置口令</title>
<style>${PAGE_STYLE}</style>
<form method="POST" action="${SETUP_PATH}">
<h3 style="margin:0 0 6px">dsh-3301 · 设置访问口令</h3>
${invalid ? '<p class="err">两次输入不一致，或口令为空</p>' : '<p class="hint">可选：设置后局域网设备需要输入口令；留空不设置则入口不校验口令。</p>'}
<input type="password" name="password" autofocus autocomplete="new-password" placeholder="新口令">
<input type="password" name="confirm" autocomplete="new-password" placeholder="再输一次">
<button type="submit">设置并进入</button>
<p class="hint" style="margin-top:10px">只保存 scrypt 校验子，不存明文；日后可在 设置 → 插件 → dsh-3301 里修改。</p>
</form>`;

	/** Shown while no password exists: the entry is open, and here is how to close it. */
	const needsSetupPage = (port) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-3301 · DSH 局域网入口</title>
<style>${PAGE_STYLE}</style>
<div style="background:#1c1c1e;padding:26px;border-radius:14px;max-width:360px">
<h3 style="margin:0 0 8px">dsh-3301 · 此入口当前没有口令</h3>
<p class="hint">未设置口令时，能连到该端口即可直接进入（无需登录）。</p>
<p class="hint" style="margin-top:10px">想加上口令保护，在本机打开 <b>设置 → 插件 → dsh-3301</b>，或访问：<br>
<code style="color:#9cf">http://127.0.0.1:${String(port)}${SETUP_PATH}</code></p>
</div>`;

	const readBody = (req, limit = 8192) =>
		new Promise((resolve) => {
			let body = "";
			req.on("data", (chunk) => {
				body += chunk;
				if (body.length > limit) req.destroy();
			});
			req.on("end", () => resolve(body));
			req.on("error", () => resolve(""));
		});

	// ── one listener, rebuilt whenever the address settings change ─────────
	let server;
	let bound = { host: undefined, port: undefined };
	const gateCookieForUpstream = (clientCookies) => {
		const own = clientCookies === undefined ? [] : [clientCookies];
		if (dshCookie === undefined) return own.join("; ") || undefined;
		return [...own, dshCookie].join("; ");
	};
	const forwardHeaders = (request) => {
		const headers = { ...request.headers };
		headers.host = UPSTREAM_AUTHORITY;
		delete headers.origin;
		delete headers["sec-fetch-site"];
		const cookie = gateCookieForUpstream(headers.cookie);
		if (cookie === undefined) delete headers.cookie;
		else headers.cookie = cookie;
		return headers;
	};

	const sendJson = (res, status, payload, extra = {}) => {
		const body = JSON.stringify(payload);
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
		res.end(body);
	};

	const corsFor = (req) => {
		const origin = req.headers.origin;
		if (typeof origin !== "string" || !loopbackPeer(req)) return {};
		try {
			const host = new URL(origin).hostname;
			if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return {};
		} catch {
			return {};
		}
		return {
			"access-control-allow-origin": origin,
			"access-control-allow-methods": "GET, POST, OPTIONS",
			"access-control-allow-headers": "content-type",
			"access-control-max-age": "600",
		};
	};

	/** Handle the gate's own endpoints. Returns true when the request is answered here. */
	const handleGateRoute = (req, res, current) => {
		const path = (req.url ?? "/").split("?")[0];
		const query = new URL(req.url ?? "/", "http://gate.invalid").searchParams;

		if (path === HEALTH_PATH) {
			sendJson(res, 200, {
				/** Identity, so anyone probing the port can tell which project answered. */
				name: "dsh-3301",
				port: bound.port ?? current.port,
				ok: true,
				hasPassword: hasPassword(),
				/** True until a password exists: the LAN entry stays closed until then. */
				needsSetup: !hasPassword(),
				username: current.username,
				sessionDays: current.sessionDays,
				/** Diagnostics: thresholds in force and how many peers are locked out. */
				maxFailures: current.maxFailures,
				lockoutMinutes: current.lockoutMinutes,
				lockedPeers: failures.size,
				/** Diagnostics: each tracked peer and how long its lock still lasts. */
				lockState: [...failures.entries()].map(([ip, entry]) => ({ ip, remainingMs: entry.until - Date.now(), count: entry.count })),
				listening: `${String(bound.host)}:${String(bound.port)}`,
				upstream: UPSTREAM_AUTHORITY,
			});
			return true;
		}

		// Loopback-only management surface (the settings card runs on the host).
		if (path === STATUS_PATH || path === PASSWORD_PATH) {
			const cors = corsFor(req);
			if (req.method === "OPTIONS") {
				res.writeHead(204, cors);
				res.end();
				return true;
			}
			if (!loopbackPeer(req)) {
				sendJson(res, 403, { ok: false, error: "只能在运行 DSH 的本机上修改口令" }, cors);
				return true;
			}
			if (path === STATUS_PATH && req.method === "GET") {
				sendJson(res, 200, { ok: true, ...passwordInfo(), sessionDays: current.sessionDays }, cors);
				return true;
			}
			if (path === PASSWORD_PATH && req.method === "POST") {
				readBody(req).then((body) => {
					let payload;
					try {
						payload = JSON.parse(body);
					} catch {
						payload = Object.fromEntries(new URLSearchParams(body));
					}
					const next = typeof payload?.next === "string" ? payload.next : "";
					const currentPassword = typeof payload?.current === "string" ? payload.current : "";
					if (hasPassword() && !verifyPassword(currentPassword)) {
						sendJson(res, 403, { ok: false, error: "当前口令不正确" }, cors);
						return;
					}
					try {
						// An empty new password removes it: the entry becomes unprotected
						// instead of the write being refused.
						const { warning } = next === "" ? clearPassword() : setPassword(next);
						log.info(next === "" ? "dsh-3301: gate password cleared" : "dsh-3301: gate password updated");
						sendJson(res, 200, { ok: true, ...passwordInfo(), warning }, cors);
					} catch (error) {
						sendJson(res, 500, { ok: false, error: String(error?.message ?? error) }, cors);
					}
				});
				return true;
			}
			sendJson(res, 405, { ok: false, error: "method not allowed" }, cors);
			return true;
		}

		if (path === LOGOUT_PATH) {
			res.writeHead(303, { location: LOGIN_PATH, "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0` });
			res.end();
			return true;
		}

		if (path === SETUP_PATH) {
			// First-use password creation, loopback only, and only while none exists.
			if (!loopbackPeer(req)) {
				res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(needsSetupPage(bound.port ?? current.port));
				return true;
			}
			if (hasPassword()) {
				// A password already exists: the settings card (or POST /__gate/password) owns changes.
				res.writeHead(303, { location: "/", "cache-control": "no-store" });
				res.end();
				return true;
			}
			if (req.method === "GET") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(setupPage(false));
				return true;
			}
			if (req.method === "POST") {
				readBody(req).then((body) => {
					const fields = Object.fromEntries(new URLSearchParams(body));
					const password = typeof fields.password === "string" ? fields.password : "";
					const confirm = typeof fields.confirm === "string" ? fields.confirm : "";
					if (password === "" || password !== confirm) {
						res.writeHead(400, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
						res.end(setupPage(true));
						return;
					}
					const { warning } = setPassword(password);
					if (warning !== undefined) log.warn(`dsh-3301: ${warning}`);
					log.info("dsh-3301: gate password created from the loopback setup page");
					res.writeHead(303, {
						location: "/",
						"set-cookie": sessionCookie(issueSession(), current.sessionDays),
						"cache-control": "no-store",
					});
					res.end();
				});
				return true;
			}
			res.writeHead(405, { allow: "GET, POST" });
			res.end();
			return true;
		}

		if (path === LOGIN_PATH) {
			if (req.method === "GET") {
				if (!hasPassword()) {
					// No password configured: the entry is not protected — just explain that.
					res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
					res.end(needsSetupPage(bound.port ?? current.port));
					return true;
				}
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(loginPage(false, query.get("next") ?? "/", current.username));
				return true;
			}
			if (req.method === "POST") {
				readBody(req).then((body) => {
					const fields = Object.fromEntries(new URLSearchParams(body));
					const peer = peerOf(req);
					const lockoutMs = current.lockoutMinutes * 60_000;
					if (locked(peer, lockoutMs)) {
						res.writeHead(429, { "retry-after": String(Math.round(lockoutMs / 1000)), "cache-control": "no-store" });
						res.end("too many attempts");
						return;
					}
					if (!hasPassword()) {
						// Nothing to authenticate against: let the visitor straight in.
						res.writeHead(303, { location: "/", "cache-control": "no-store" });
						res.end();
						return;
					}
					const username = typeof current.username === "string" && current.username !== "" ? current.username : "dsh";
					if (!sameSecret(fields.username ?? "", username) || !verifyPassword(fields.password ?? "")) {
						recordFailure(peer, current.maxFailures, lockoutMs);
						res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
						res.end(loginPage(true, fields.next ?? "/", username));
						return;
					}
					failures.delete(peer);
					res.writeHead(303, {
						location: fields.next && fields.next.startsWith("/") ? fields.next : "/",
						"set-cookie": sessionCookie(issueSession(), current.sessionDays),
						"cache-control": "no-store",
					});
					res.end();
				});
				return true;
			}
			res.writeHead(405, { allow: "GET, POST" });
			res.end();
			return true;
		}

		if (!validSession(req)) {
			const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
			if (req.method === "GET" && wantsHtml) {
				res.writeHead(303, { location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url ?? "/")}`, "cache-control": "no-store" });
				res.end();
			} else {
				res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(JSON.stringify({ ok: false, error: "gate session required" }));
			}
			return true;
		}
		return false;
	};

	const proxyHttp = async (req, res, attempt = 0) => {
		if (dshCookie === undefined) await acquireDshCookie(attempt > 0);
		if (dshCookie === undefined) {
			res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
			res.end("dsh-3301: cannot obtain a DSH session for the loopback server\n");
			return;
		}
		const headers = forwardHeaders(req);
		const upstream = http.request(
			{ host: UPSTREAM.host, port: UPSTREAM.port, method: req.method, path: req.url ?? "/", headers },
			(upstreamRes) => {
				upstreamRes.on("error", () => {
					if (!res.headersSent) res.writeHead(502);
					res.end();
				});
				const replayable = req.method === "GET" || req.method === "HEAD";
				if (upstreamRes.statusCode === 401 && attempt === 0 && replayable) {
					upstreamRes.resume();
					dshCookie = undefined;
					proxyHttp(req, res, 1).catch(() => res.destroy());
					return;
				}
				res.writeHead(upstreamRes.statusCode ?? 502, sanitizeHeaders(upstreamRes.headers));
				upstreamRes.pipe(res);
			}
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
			res.end("dsh-3301: upstream unreachable");
		});
		req.on("error", () => res.destroy());
		res.on("error", () => {});
		req.pipe(upstream);
	};

	const proxyUpgrade = async (req, socket, head) => {
		if (!authorized(req)) {
			socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		if (dshCookie === undefined) await acquireDshCookie();
		if (dshCookie === undefined) {
			socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		const upstream = http.request({
			host: UPSTREAM.host,
			port: UPSTREAM.port,
			method: req.method,
			path: req.url ?? "/",
			headers: forwardHeaders(req),
		});
		upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
			const lines = ["HTTP/1.1 101 Switching Protocols"];
			for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
				lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
			}
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
			if (upstreamHead?.length) socket.unshift(upstreamHead);
			if (head?.length) upstreamSocket.unshift(head);
			upstreamSocket.pipe(socket);
			socket.pipe(upstreamSocket);
			const close = () => {
				socket.destroy();
				upstreamSocket.destroy();
			};
			socket.on("error", close);
			upstreamSocket.on("error", close);
			socket.on("close", close);
			upstreamSocket.on("close", close);
		});
		// Upstream answered the handshake with an ordinary response: forward it.
		upstream.on("response", (upstreamRes) => {
			upstreamRes.on("error", () => socket.destroy());
			const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode)} ${upstreamRes.statusMessage ?? ""}`.trim()];
			for (const [key, value] of Object.entries(sanitizeHeaders(upstreamRes.headers))) {
				if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
				else lines.push(`${key}: ${value}`);
			}
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
			upstreamRes.pipe(socket);
		});
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		if (head?.length) upstream.write(head);
		upstream.end();
	};

	let tapDisposer;
	const start = () => {
		const listening = settings();
		server = http.createServer((req, res) => {
			// This listener belongs to the plugin, so the DSH webserver's own error
			// wrapper does not cover it: an uncaught throw here would kill the whole
			// DSH process, so every request is handled defensively.
			try {
				const path = (req.url ?? "/").split("?")[0];
				if (path.startsWith(BASE_PATH)) {
					// Read settings per request so card edits apply without a rebind.
					if (handleGateRoute(req, res, settings())) return;
				} else if (!authorized(req)) {
					// Everything outside the gate's own endpoints needs a gate session.
					const wantsHtml = String(req.headers.accept ?? "").includes("text/html");
					if (req.method === "GET" && wantsHtml) {
						res.writeHead(303, { location: `${LOGIN_PATH}?next=${encodeURIComponent(req.url ?? "/")}`, "cache-control": "no-store" });
						res.end();
					} else {
						res.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
						res.end(JSON.stringify({ ok: false, error: "gate session required" }));
					}
					return;
				}
				proxyHttp(req, res).catch(() => {
					if (!res.headersSent) res.writeHead(500);
					res.end();
				});
			} catch (error) {
				log.warn(`dsh-3301: request handling failed: ${error instanceof Error ? error.message : String(error)}`);
				try {
					if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
					res.end();
				} catch {
					res.destroy();
				}
			}
		});
		server.on("upgrade", (req, socket, head) => {
			try {
				proxyUpgrade(req, socket, head).catch(() => socket.destroy());
			} catch (error) {
				log.warn(`dsh-3301: upgrade handling failed: ${error instanceof Error ? error.message : String(error)}`);
				socket.destroy();
			}
		});
		server.timeout = 0;
		server.requestTimeout = 0;
		server.headersTimeout = 60_000;
		server.keepAliveTimeout = 65_000;
		server.on("error", (error) => log.warn(`dsh-3301: listener error: ${error.message}`));
		server.listen(listening.port, listening.host, () => {
			bound = { host: listening.host, port: listening.port };
			log.info(`dsh-3301: LAN gate on http://${listening.host}:${String(listening.port)} -> http://${UPSTREAM_AUTHORITY}`);
			log.info(
				`dsh-3301: password ${hasPassword() ? "set" : "NOT SET (open Settings → Plugins → dsh-3301 on this machine)"}, ` +
					`session ${String(listening.sessionDays)}d, lockout ${String(listening.maxFailures)}/${String(listening.lockoutMinutes)}min`
			);
		});
	};

	const stop = () => {
		if (server === undefined) return;
		const retiring = server;
		server = undefined;
		bound = { host: undefined, port: undefined };
		try {
			retiring.closeAllConnections?.();
			retiring.close();
		} catch {
			/* already closed */
		}
	};

	/** Bring the listener in line with the current settings. */
	const reconcile = () => {
		const current = settings();
		if (current.enabled === false) {
			if (server !== undefined) log.info("dsh-3301: disabled by settings");
			stop();
			return;
		}
		if (server !== undefined && bound.host === current.host && bound.port === current.port) return;
		stop();
		start();
	};

	ctx.effect(() => {
		reconcile();
		return () => stop();
	}, "dsh-3301: listener");

	// Client bootstrap, injected server-side before compression.
	const source = bootstrapSource();
	ctx.effect(
		() =>
			ctx.webServer.tapIndex((html) => (settings().injectClientBootstrap === false ? html : injectBootstrap(html, source))),
		"dsh-3301: client bootstrap tap"
	);

	// Settings commits (document edits, the card, other surfaces) re-run reconcile.
	ctx.on?.("settings/updated", () => reconcile());
	acquireDshCookie().catch(() => {});
	log.info(`dsh-3301: namespace ${GATE_NAMESPACE} registered (settings UI card provided by lib/client.js)`);
	void tapDisposer;
}
