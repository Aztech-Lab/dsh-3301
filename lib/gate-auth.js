/**
 * dsh-3301 — gate credential store (no plaintext password, ever).
 *
 * What is stored:
 *   - `password`: a salted **scrypt verifier** — algorithm parameters, a random
 *     salt, and the derived key. The password itself is never written anywhere,
 *     so the file cannot be reversed into it.
 *   - `sessionSecret`: a random 32-byte value used to sign gate session cookies.
 *
 * Where: `$DSH_HOME/dsh-3301/auth.json` (override with DSH_PROXY_GATE_DIR).
 * The directory and file are created with inherited ACLs removed and access
 * narrowed to the owning account plus SYSTEM/Administrators, because this
 * deployment's parent directory would otherwise let any local user read (and
 * even replace) it. On POSIX the same tightening is a 0600 mode.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

/** scrypt parameters: ~16 MiB working set, well above interactive-login cost. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };
const FILE_VERSION = 1;
const SECRET_BYTES = 32;

/** Directory holding the gate store. */
export function storeDir() {
	return (
		process.env.DSH_PROXY_GATE_DIR ||
		path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "dsh-3301")
	);
}

/** Path of the gate store file. */
export function storeFile() {
	return path.join(storeDir(), "auth.json");
}

/**
 * Best-effort permission tightening.
 *
 * The directory gets explicit grants for the owning account, SYSTEM, and
 * Administrators *first*, and only then has its inherited ACEs removed — that
 * order matters, because removing inheritance while no explicit grant exists
 * would leave the directory (and anything inside it) unreachable for everyone.
 * Container-inherit flags are only valid on a directory, so files are never
 * passed here: they inherit the directory's grants.
 *
 * Failures are reported through the returned warning instead of throwing, and a
 * failed tightening rolls the inheritance removal back so the store stays usable.
 */
function tightenDirectory(dir) {
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(dir, 0o700);
			return undefined;
		} catch (error) {
			return `could not chmod ${dir}: ${error.message}`;
		}
	}
	const whoami =
		process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
	const principals = [whoami, "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"].filter(Boolean);
	const grant = spawnSync("icacls", [dir, "/grant:r", ...principals.map((id) => `${id}:(OI)(CI)F`)], { stdio: "ignore" });
	if (grant.error || grant.status !== 0) return `icacls /grant:r failed for ${dir} (store left with inherited permissions)`;
	const inherit = spawnSync("icacls", [dir, "/inheritance:r"], { stdio: "ignore" });
	if (inherit.error || inherit.status !== 0) {
		spawnSync("icacls", [dir, "/inheritance:e"], { stdio: "ignore" });
		return `icacls /inheritance:r failed for ${dir}; inheritance restored`;
	}
	return undefined;
}

/** Create the store directory when missing; returns any permission warning. */
export function ensureStoreDir() {
	const dir = storeDir();
	fs.mkdirSync(dir, { recursive: true });
	return tightenDirectory(dir);
}

function readStore() {
	try {
		const parsed = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
		if (parsed !== null && typeof parsed === "object") return parsed;
	} catch {
		/* absent or unreadable: start from an empty store */
	}
	return { version: FILE_VERSION, password: null, sessionSecret: undefined };
}

function writeStore(store) {
	const warning = ensureStoreDir();
	const file = storeFile();
	fs.writeFileSync(file, `${JSON.stringify({ ...store, version: FILE_VERSION }, null, "\t")}\n`, { mode: 0o600 });
	if (process.platform !== "win32") {
		try {
			fs.chmodSync(file, 0o600);
		} catch (error) {
			return warning ?? `could not chmod ${file}: ${error.message}`;
		}
	}
	return warning;
}

const b64 = (buffer) => Buffer.from(buffer).toString("base64");
const unbase64 = (text) => Buffer.from(String(text), "base64");

function derive(password, salt, params) {
	return crypto.scryptSync(Buffer.from(String(password), "utf8"), salt, params.keylen, {
		N: params.N,
		r: params.r,
		p: params.p,
		maxmem: SCRYPT.maxmem,
	});
}

/** Whether a gate password has been set. */
export function hasPassword() {
	const stored = readStore().password;
	return stored !== null && typeof stored === "object" && typeof stored.hash === "string";
}

/** Non-secret password metadata for status surfaces. */
export function passwordInfo() {
	const stored = readStore().password;
	if (stored === null || typeof stored !== "object" || typeof stored.hash !== "string") return { set: false, updatedAt: undefined };
	return { set: true, updatedAt: stored.updatedAt };
}

/**
 * Remove the stored password verifier: the entry becomes unprotected and any
 * browser that can reach the port gets in. The session-signing secret is kept,
 * so sessions already issued stay valid (they simply stop being required).
 */
export function clearPassword() {
	const store = readStore();
	store.password = null;
	return { warning: writeStore(store) };
}

/**
 * Replace the gate password with a fresh scrypt verifier.
 * @returns {{ warning?: string }} any permission warning worth surfacing
 */
export function setPassword(password) {
	if (typeof password !== "string" || password === "") throw new Error("dsh-3301: password must not be empty");
	const salt = crypto.randomBytes(16);
	const hash = derive(password, salt, SCRYPT);
	const store = readStore();
	store.password = {
		algo: "scrypt",
		N: SCRYPT.N,
		r: SCRYPT.r,
		p: SCRYPT.p,
		keylen: SCRYPT.keylen,
		salt: b64(salt),
		hash: b64(hash),
		updatedAt: new Date().toISOString(),
	};
	return { warning: writeStore(store) };
}

/** Constant-time password verification against the stored verifier. */
export function verifyPassword(password) {
	const stored = readStore().password;
	if (stored === null || typeof stored !== "object" || typeof stored.hash !== "string") return false;
	if (typeof password !== "string") return false;
	let expected;
	try {
		expected = unbase64(stored.hash);
	} catch {
		return false;
	}
	const actual = derive(password, unbase64(stored.salt), {
		N: stored.N,
		r: stored.r,
		p: stored.p,
		keylen: stored.keylen,
	});
	return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Session-cookie signing secret, created and persisted on first use. */
export function sessionSecret() {
	const store = readStore();
	if (typeof store.sessionSecret === "string" && store.sessionSecret.length > 0) return unbase64(store.sessionSecret);
	const created = crypto.randomBytes(SECRET_BYTES);
	store.sessionSecret = b64(created);
	writeStore(store);
	return created;
}
