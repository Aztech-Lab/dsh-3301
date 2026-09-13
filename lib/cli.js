#!/usr/bin/env node
/**
 * dsh-3301 — CLI launcher.
 *
 * Env:
 *   DSH_PROXY_PORT          listen port (default 3301)
 *   DSH_PROXY_HOST          listen host (default 0.0.0.0)
 *   DSH_PROXY_USER          basic-auth username (default dsh)
 *   DSH_PROXY_PASS          basic-auth password (required)
 *   DSH_UPSTREAM            upstream host:port (default 127.0.0.1:3080)
 *   DSH_PROXY_SECRET_FILE   file holding the session-signing secret
 *   DSH_PROXY_CERT          HTTPS cert path (optional; enables TLS if present)
 *   DSH_PROXY_KEY           HTTPS key path (optional)
 *   DSH_HOME                Harness home (default ~/.dsh); locates the DSH session secret
 *   DSH_PROXY_CREDENTIALS   credentials file (default $DSH_HOME/.credentials.yaml)
 *   DSH_PROXY_SESSION_DAYS  minted DSH session lifetime in days (default 7, max 30)
 *   DSH_PROXY_BOOTSTRAP     set to 0 to skip the client bootstrap injection
 */
import { startProxy } from "./index.js";

// A long-running LAN service must not die silently on a stray stream error:
// report it and keep serving, so one bad connection cannot take the entry down.
const report = (kind) => (error) => {
	console.error(`dsh-3301: ${kind}:`, error instanceof Error ? (error.stack ?? error.message) : error);
};
process.on("uncaughtException", report("uncaughtException"));
process.on("unhandledRejection", report("unhandledRejection"));

startProxy({
	host: process.env.DSH_PROXY_HOST,
	port: process.env.DSH_PROXY_PORT ? Number(process.env.DSH_PROXY_PORT) : undefined,
	user: process.env.DSH_PROXY_USER,
	pass: process.env.DSH_PROXY_PASS,
	upstream: process.env.DSH_UPSTREAM,
	secretFile: process.env.DSH_PROXY_SECRET_FILE,
	certFile: process.env.DSH_PROXY_CERT,
	keyFile: process.env.DSH_PROXY_KEY,
	credentialsFile: process.env.DSH_PROXY_CREDENTIALS,
	sessionLifetimeDays: process.env.DSH_PROXY_SESSION_DAYS ? Number(process.env.DSH_PROXY_SESSION_DAYS) : undefined,
	bootstrap: process.env.DSH_PROXY_BOOTSTRAP === "0" ? false : undefined,
});
