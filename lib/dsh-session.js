/**
 * dsh-3301 — DSH browser-session acquisition.
 *
 * DSH 1.2+ authenticates every GUI request with a signed, authority-bound
 * cookie minted by `dsh-client-connection`. A reverse proxy that only rewrites
 * Host/Origin therefore forwards traffic that DSH answers with 401 — the proxy
 * needs a real session of its own.
 *
 * DSH persists the cookie-signing secret in the `client-connection/browser-session`
 * grant record of `$DSH_HOME/.credentials.yaml` (see the browser-authentication
 * section of the dsh-client-connection README). This module reads that record and
 * mints the same cookie shape DSH's own index exchange issues:
 *
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
 *                 + "." + base64url(HMAC-SHA256(secret, body))
 *
 * The cookie is bound to the authority DSH sees — i.e. the upstream Host the
 * proxy forwards, which is the loopback authority. Sessions minted here carry
 * the same capability as a browser on the host itself.
 *
 * Nothing is written back: the secret is only read, and the cookie stays in
 * memory. Delete the credential record (or change the secret) and every minted
 * session becomes invalid on the next request.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Grant record holding the browser-session signing secret. */
const RECORD_KEY = "client-connection/browser-session";
/** Secret length mandated by dsh-client-connection. */
const SECRET_BYTES = 32;
/** Refresh at half of the lifetime to stay ahead of expiry. */
const REFRESH_RATIO = 0.5;

const b64url = (buffer) =>
	Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

/** Resolve the Harness home the way DSH itself does. */
export function resolveDshHome() {
	return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** Resolve the credentials file holding the browser-session record. */
export function resolveCredentialsFile(dshHome = resolveDshHome()) {
	return process.env.DSH_PROXY_CREDENTIALS || path.join(dshHome, ".credentials.yaml");
}

/** Decode a base64url 32-byte secret, or return undefined when malformed. */
function decodeSecret(value) {
	if (typeof value !== "string") return undefined;
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const secret = Buffer.from(normalized + padding, "base64");
	return secret.length === SECRET_BYTES ? secret : undefined;
}

/**
 * Read the signing secret out of the credentials file.
 *
 * Only the browser-session record is consulted: the search starts at the record
 * key and takes the first `secret:` entry after it (YAML writes that record's
 * payload fields in order), so other credential entries are never touched.
 *
 * @returns {Buffer|undefined} the secret, or undefined when absent/malformed
 */
export function readSigningSecret(file = resolveCredentialsFile()) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	const at = text.indexOf(RECORD_KEY);
	if (at < 0) return undefined;
	const match = /^\s*secret:\s*['"]?([A-Za-z0-9_-]{40,})['"]?\s*$/m.exec(text.slice(at));
	return match ? decodeSecret(match[1]) : undefined;
}

/**
 * Create a session provider for one upstream authority.
 *
 * @param options.authority  authority DSH sees (upstream host:port)
 * @param options.file       credentials file; defaults to $DSH_HOME/.credentials.yaml
 * @param options.lifetimeDays cookie lifetime in days; must not exceed DSH's
 *                             `cookieMaxAgeDays` (30 by default) because DSH
 *                             rejects cookies whose window exceeds its own
 * @param options.log        logger
 */
export function createDshSession({ authority, file, lifetimeDays = 7, log = () => {} } = {}) {
	if (typeof authority !== "string" || authority === "") throw new Error("dsh-3301: session authority is required");
	const credentialsFile = file || resolveCredentialsFile();
	const lifetimeMs = lifetimeDays * 24 * 60 * 60 * 1000;
	const refreshMs = Math.max(60_000, Math.floor(lifetimeMs * REFRESH_RATIO));

	let cached;
	let warned = false;

	const cookieName = "dsh-auth-" + b64url(crypto.createHash("sha256").update(authority).digest());

	/** Mint a fresh cookie value; throws with an actionable message when impossible. */
	function mint() {
		const secret = readSigningSecret(credentialsFile);
		if (secret === undefined) {
			throw new Error(
				`dsh-3301: no browser-session secret in ${credentialsFile}. ` +
					`Start the DSH web GUI at least once (it creates the record), or point DSH_PROXY_CREDENTIALS at the right file.`
			);
		}
		const issuedAt = Date.now();
		const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + lifetimeMs };
		const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
		const signature = b64url(crypto.createHmac("sha256", secret).update(body).digest());
		return { name: cookieName, value: `v1.${body}.${signature}`, issuedAt };
	}

	return {
		/** Current `name=value` pair, minting or refreshing as needed. */
		cookie() {
			if (cached === undefined || Date.now() - cached.issuedAt > refreshMs) {
				try {
					cached = mint();
				} catch (error) {
					if (!warned) {
						warned = true;
						log(`dsh-3301: ${error.message}`);
					}
					throw error;
				}
			}
			return `${cached.name}=${cached.value}`;
		},
		/** Drop the cached cookie so the next call mints a new one (used after a 401). */
		invalidate() {
			cached = undefined;
		},
		/** Diagnostics for the startup line without revealing the cookie value. */
		status() {
			return {
				authority,
				credentialsFile,
				lifetimeDays,
				hasSecret: readSigningSecret(credentialsFile) !== undefined,
			};
		},
	};
}
