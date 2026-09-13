/**
 * dsh-3301 — password-protected reverse proxy in front of a DSH Web GUI.
 *
 * DSH stays bound to 127.0.0.1 (loopback only, safe). This proxy binds to
 * 0.0.0.0 so a phone on the LAN can reach it. Auth is cookie-based to avoid
 * the repeated Basic-Auth re-prompt that breaks WebSocket/SSE-heavy apps:
 *   - First request must pass HTTP Basic Auth; on success the proxy issues a
 *     signed session cookie.
 *   - Every later request (including WebSocket upgrades, which carry cookies)
 *     is accepted by the cookie, so the browser never re-prompts.
 *
 * Two things are added on top of the plain forwarding path:
 *   - **DSH session** — DSH 1.2+ authenticates every GUI request with a signed,
 *     authority-bound cookie, so a proxy that only rewrites Host/Origin gets a
 *     401 from upstream. `lib/dsh-session.js` mints that cookie from the signing
 *     secret DSH persists under $DSH_HOME, and it is appended to every forwarded
 *     request (and refreshed once if upstream still answers 401).
 *   - **Client bootstrap** — `lib/client-bootstrap.js` injects the `ownsHost`
 *     transport signal into HTML responses so a LAN page keeps host-backed
 *     settings instead of degrading to memory-only.
 *
 * Security: optional HTTPS (self-signed cert) encrypts the password/session on
 * the wire; rate limiting locks out an IP after too many failed logins.
 *
 * Pure Node built-ins only — no native modules, no dependencies.
 */
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDshSession } from "./dsh-session.js";
import { bootstrapSource, isHtml, rewriteHtmlResponse, sanitizeHeaders } from "./client-bootstrap.js";

const DEFAULTS = {
	host: "0.0.0.0",
	port: 3301,
	user: "dsh",
	pass: "",
	upstream: "127.0.0.1:3080",
	// os.tmpdir() rather than "/tmp": the literal path is POSIX-only and does not
	// exist on Windows (a bare /tmp would make the CLI fail to store its secret).
	secretFile: path.join(os.tmpdir(), "dsh-3301-secret"),
	certFile: path.join(os.tmpdir(), "dsh-3301-cert.pem"),
	keyFile: path.join(os.tmpdir(), "dsh-3301-key.pem"),
	maxFailures: 5,
	lockoutMs: 5 * 60 * 1000,
	cookieName: "dsh_session",
	/** Credentials file holding DSH's browser-session secret; default $DSH_HOME/.credentials.yaml. */
	credentialsFile: undefined,
	/** Minted DSH session lifetime; must not exceed DSH's own cookieMaxAgeDays (30 by default). */
	sessionLifetimeDays: 7,
	/** Inject the client bootstrap into HTML responses. */
	bootstrap: true,
	/** Give up on rewriting an HTML response larger than this. */
	maxHtmlBytes: 8 * 1024 * 1024,
};

/**
 * Start the DSH reverse proxy.
 * @param options overrides of {@link DEFAULTS}
 * @returns { url, close(cb) }
 */
export function startProxy(options = {}) {
	const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) };
	const [UPSTREAM_HOST, UPSTREAM_PORT] = String(o.upstream).split(":");
	const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
	const COOKIE_NAME = o.cookieName;
	const log = o.log || console.log;

	if (!o.pass) {
		throw new Error("dsh-3301: pass is required");
	}

	// DSH session: minted locally from the persisted signing secret, kept in memory.
	const session = createDshSession({
		authority: UPSTREAM_AUTHORITY,
		file: o.credentialsFile,
		lifetimeDays: o.sessionLifetimeDays,
		log,
	});
	const bootstrap = o.bootstrap ? bootstrapSource() : "";
	const sessionStatus = session.status();

	// Persistent signing secret so existing cookies survive a restart.
	let secret;
	try {
		secret = fs.readFileSync(o.secretFile, "utf8").trim();
	} catch {
		secret = crypto.randomBytes(32).toString("hex");
		fs.writeFileSync(o.secretFile, secret, { mode: 0o600 });
	}

	const sign = (value) => crypto.createHmac("sha256", secret).update(value).digest("base64url");
	const makeToken = () => {
		const value = crypto.randomBytes(24).toString("base64url");
		return `${value}.${sign(value)}`;
	};
	const validToken = (token) => {
		if (typeof token !== "string") return false;
		const idx = token.lastIndexOf(".");
		if (idx < 0) return false;
		const value = token.slice(0, idx);
		const sig = token.slice(idx + 1);
		const expected = sign(value);
		const a = Buffer.from(sig);
		const b = Buffer.from(expected);
		return a.length === b.length && crypto.timingSafeEqual(a, b);
	};
	const getCookie = (req, name) => {
		const header = req.headers["cookie"] || "";
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq < 0) continue;
			if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
		}
		return undefined;
	};
	const checkBasicAuth = (req) => {
		const header = req.headers["authorization"] || "";
		const m = /^Basic\s+(.+)$/i.exec(header);
		if (!m) return false;
		let decoded;
		try { decoded = Buffer.from(m[1], "base64").toString("utf8"); } catch { return false; }
		const idx = decoded.indexOf(":");
		if (idx < 0) return false;
		return decoded.slice(0, idx) === o.user && decoded.slice(idx + 1) === o.pass;
	};
	const authenticate = (req) => {
		const cookie = getCookie(req, COOKIE_NAME);
		if (cookie && validToken(cookie)) return { ok: true };
		if (checkBasicAuth(req)) return { ok: true, token: makeToken() };
		return { ok: false };
	};

	// ── rate limiting ────────────────────────────────────────────────────────
	const failures = new Map();
	const isLocked = (ip) => {
		const f = failures.get(ip);
		if (!f) return false;
		if (f.lockedUntil && f.lockedUntil > Date.now()) return true;
		if (f.lockedUntil && f.lockedUntil <= Date.now()) failures.delete(ip);
		return false;
	};
	const recordFailure = (ip) => {
		const f = failures.get(ip) || { count: 0, lockedUntil: 0 };
		f.count += 1;
		if (f.count >= o.maxFailures) { f.lockedUntil = Date.now() + o.lockoutMs; f.count = 0; }
		failures.set(ip, f);
	};
	const recordSuccess = (ip) => failures.delete(ip);
	const clientIp = (req) => req.socket?.remoteAddress || "unknown";

	/**
	 * Headers DSH sees: loopback Host, no Origin (so the browser-trust fence
	 * passes), plus this process's own DSH session cookie appended to whatever
	 * the client sent.
	 * @throws when no DSH session can be minted
	 */
	const forwardHeaders = (headers) => {
		const h = { ...headers };
		h.host = UPSTREAM_AUTHORITY;
		delete h.origin;
		const dshCookie = session.cookie();
		h.cookie = h.cookie ? `${h.cookie}; ${dshCookie}` : dshCookie;
		return h;
	};
	const unauthorized = (res, locked) => {
		if (locked) {
			res.writeHead(429, { "Retry-After": String(o.lockoutMs / 1000) });
			res.end("Too many failed attempts. Try again later.");
			return;
		}
		res.writeHead(401, { "WWW-Authenticate": 'Basic realm="dsh"' });
		res.end("Unauthorized");
	};
	/** Upstream could not be given a session: explain instead of forwarding a confusing 401. */
	const noSession = (res, error) => {
		res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
		res.end(`dsh-3301: cannot reach DSH with a session.\n${error.message}\n`);
	};

	const hasTls = fs.existsSync(o.certFile) && fs.existsSync(o.keyFile);

	/** Forward one HTTP request, retrying once with a fresh DSH session after a 401. */
	const forwardHttp = (req, res, auth, attempt = 0) => {
		let headers;
		try {
			headers = forwardHeaders(req.headers);
		} catch (error) {
			noSession(res, error);
			return;
		}
		const proxyReq = http.request(
			{ host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers },
			(proxyRes) => {
				// A client or upstream that vanishes mid-response must not take the
				// process down: an unhandled 'error' on a stream is fatal in Node.
				proxyRes.on("error", () => {
					if (!res.headersSent) {
						res.writeHead(502);
						res.end();
					} else {
						res.destroy();
					}
				});
				// A stale/revoked session still looks valid locally; re-mint once.
				const replayable = req.method === "GET" || req.method === "HEAD";
				if (proxyRes.statusCode === 401 && attempt === 0 && replayable) {
					proxyRes.resume();
					session.invalidate();
					forwardHttp(req, res, auth, 1);
					return;
				}
				const headersOut = { ...proxyRes.headers };
				if (auth.token) {
					// Append our session cookie to DSH's own Set-Cookie (e.g. language
					// prefs) instead of overwriting it, so DSH settings persist. Max-Age
					// keeps the session across browser restarts (no re-auth prompt).
					const sessionCookie = `${COOKIE_NAME}=${auth.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${hasTls ? "; Secure" : ""}`;
					const dshCookies = proxyRes.headers["set-cookie"];
					headersOut["Set-Cookie"] = dshCookies ? [...dshCookies, sessionCookie] : sessionCookie;
				}
				if (bootstrap !== "" && isHtml(headersOut)) {
					const chunks = [];
					let size = 0;
					let overflow = false;
					proxyRes.on("data", (chunk) => {
						if (overflow) return;
						size += chunk.length;
						if (size > o.maxHtmlBytes) { overflow = true; return; }
						chunks.push(chunk);
					});
					proxyRes.on("end", () => {
						if (res.writableEnded) return;
						if (overflow) {
							noSession(res, new Error(`HTML response exceeded maxHtmlBytes (${o.maxHtmlBytes})`));
							return;
						}
						const raw = Buffer.concat(chunks);
						const rewritten = rewriteHtmlResponse(headersOut, raw, bootstrap);
						if (rewritten === undefined) {
							res.writeHead(proxyRes.statusCode, sanitizeHeaders(headersOut));
							res.end(raw);
							return;
						}
						res.writeHead(proxyRes.statusCode, rewritten.headers);
						res.end(rewritten.body);
					});
					return;
				}
				res.writeHead(proxyRes.statusCode, sanitizeHeaders(headersOut));
				proxyRes.pipe(res);
			}
		);
		proxyReq.on("error", () => {
			if (!res.headersSent) { res.writeHead(502); res.end("Bad Gateway"); }
			else res.destroy();
		});
		req.on("error", () => res.destroy());
		res.on("error", () => {});
		req.pipe(proxyReq);
	};

	const server = (hasTls ? https : http).createServer(
		hasTls ? { cert: fs.readFileSync(o.certFile), key: fs.readFileSync(o.keyFile) } : {},
		(req, res) => {
			const ip = clientIp(req);
			if (isLocked(ip)) return unauthorized(res, true);
			const auth = authenticate(req);
			if (!auth.ok) { recordFailure(ip); return unauthorized(res, false); }
			recordSuccess(ip);
			forwardHttp(req, res, auth);
		}
	);

	server.on("upgrade", (req, socket, head) => {
		const ip = clientIp(req);
		if (isLocked(ip)) { socket.end(["HTTP/1.1 429 Too Many Requests", "Connection: close", "", ""].join("\r\n")); return; }
		const auth = authenticate(req);
		if (!auth.ok) {
			recordFailure(ip);
			socket.end(["HTTP/1.1 401 Unauthorized", 'WWW-Authenticate: Basic realm="dsh"', "Connection: close", "", ""].join("\r\n"));
			return;
		}
		recordSuccess(ip);
		let headers;
		try {
			headers = forwardHeaders(req.headers);
		} catch (error) {
			socket.end(["HTTP/1.1 502 Bad Gateway", "Connection: close", "", String(error.message)].join("\r\n"));
			return;
		}
		const proxyReq = http.request({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, headers });
		proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
			const statusLine = `HTTP/1.1 101 Switching Protocols\r\n`;
			const headers = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
			let response = statusLine + headers + "\r\n";
			if (auth.token) response += `Set-Cookie: ${COOKIE_NAME}=${auth.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${hasTls ? "; Secure" : ""}\r\n`;
			socket.write(response);
			if (proxyHead && proxyHead.length) socket.write(proxyHead);
			proxySocket.on("error", () => socket.destroy());
			socket.on("error", () => proxySocket.destroy());
			proxySocket.pipe(socket);
			socket.pipe(proxySocket);
		});
		// Upstream answered the handshake with an ordinary response (401/404/…):
		// forward it verbatim instead of leaving the client waiting forever.
		proxyReq.on("response", (up) => {
			up.on("error", () => socket.destroy());
			const lines = [`HTTP/1.1 ${String(up.statusCode)} ${up.statusMessage ?? ""}`.trim()];
			for (const [key, value] of Object.entries(sanitizeHeaders(up.headers))) {
				if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`);
				else lines.push(`${key}: ${value}`);
			}
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);
			up.pipe(socket);
		});
		proxyReq.on("error", () => socket.destroy());
		socket.on("error", () => proxyReq.destroy());
		if (head && head.length) proxyReq.write(head);
		proxyReq.end();
	});

	server.listen(o.port, o.host, () => {
		log(
			`dsh-3301: listening on ${hasTls ? "https" : "http"}://${o.host}:${o.port} -> http://${UPSTREAM_AUTHORITY} ` +
				`(user: ${o.user}, rate-limit: ${o.maxFailures}/${o.lockoutMs / 60000}min)`
		);
		log(
			`dsh-3301: DSH session authority ${sessionStatus.authority}, ` +
				`credentials ${sessionStatus.credentialsFile}, ` +
				`secret ${sessionStatus.hasSecret ? "found" : "MISSING (start the DSH web GUI once)"}, ` +
				`bootstrap ${bootstrap === "" ? "off" : "on"}`
		);
	});

	return {
		url: `${hasTls ? "https" : "http"}://${o.host}:${o.port}`,
		close(cb) { try { server.close(cb); } catch { cb?.(); } },
	};
}
