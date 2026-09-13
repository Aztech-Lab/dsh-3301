# dsh-3301

> Formerly published as `dsh-proxy`; the project and package are now `dsh-3301`.
## Proxies your DeepSeek Harness (DSH) port to `http://<this-machine-ip>:3301` with added security, so you can access DSH from anywhere on the LAN — including your phone.

> ~~⚠️ **DSH 1.1 only.** DeepSeek Harness **1.2** added a **local token verification**
> that breaks this reverse-proxy approach (the proxy can no longer pass through
> to the GUI). This project targets DSH **1.1**. If you're on 1.2+, a different
> access method is required.~~
>
> ✅ **Updated:** that limitation is solved. The project now also ships as a **DSH plugin**
> (identity `dsh-3301`) that works on current DSH — see
> [Plugin form](#plugin-form-dsh-3301) below. The standalone proxy remains supported.

**English** · [中文](./README.zh-CN.md)

Password-protected **reverse proxy** (HTTP + WebSocket) — and now also a DSH **plugin** (`dsh-3301`) — in front of a
[DSH](https://github.com/deepseek-ai/dsh) Web GUI.

DSH stays bound to `127.0.0.1` (loopback only, safe). This proxy binds to
`0.0.0.0` so a phone on the LAN can reach it — behind a password. The plugin form starts with **no password**: set one, or leave the entry open. The plugin form starts with **no password**: set one, or leave the entry open. The plugin form starts with **no password**: set one, or leave the entry open.

> **Zero-install dependencies** — the standalone CLI is pure Node built-ins and the plugin reuses packages DSH already ships. Cross-platform (macOS / Linux /
> Windows × x86 / ARM) — verified on Windows; macOS/Linux follow from the platform branches in the code, but have not been tested on real hardware yet.

## For agents (TL;DR)

A password-protected reverse proxy in front of DSH. DSH stays loopback-only;
this binds `0.0.0.0:3301` and forwards HTTP + WebSocket to it. Auth is a
signed cookie (30-day session), optional HTTPS, rate-limited. To run:
`DSH_PROXY_PASS=<pw> node lib/cli.js`. To stop on macOS:
`launchctl bootout gui/$(id -u)/com.dsh.lan-proxy`. See below for details.

> **Plugin form — preferred on current DSH:** `node tools/deploy.mjs dsh-3301` (or
> `dsh plugin --profile web add dsh-3301`), restart DSH, then open `http://<host-ip>:3301`.
> There is no default password, and the settings card lives at
> **Settings → Plugins → Plugin configuration → dsh-3301**. Details below.

## Plugin form (`dsh-3301`)

The standalone proxy below still works, but the supported way to run this on current DSH is as a
**plugin**, and the package/plugin identity is **`dsh-3301`** (the npm name `dsh-proxy` is taken by
an unrelated LLM-gateway plugin).

- DSH itself stays bound to `127.0.0.1` — it never listens on the LAN.
- The plugin opens the LAN entry (`0.0.0.0:3301` by default) **inside the DSH process**: no
  separate daemon, no scheduled task, it starts and stops with DSH.
- **No default password.** Until one is set the entry does not authenticate at all; leaving the
  password field empty when saving **clears** it again.
- The password is stored only as a **salted scrypt verifier** in `$DSH_HOME/dsh-3301/auth.json` —
  no plaintext is written — and changing or clearing it is **loopback-only**.
- Login is a **form** (the password crosses the wire once per login, unlike Basic) with per-IP
  failure lockout and a signed session cookie (**30 days** by default).
- The session comes from the official `ctx.connection.authenticatedUrl()` API — the plugin no longer
  reads your credential file — and the client bootstrap is injected with
  `ctx.webServer.tapIndex()`, i.e. before compression, so no HTML rewriting.

> ⚠️ **Until you set a password, anyone who can reach port 3301 gets into DSH.** Set one *before*
> exposing the machine: **Settings → Plugins → Plugin configuration → dsh-3301**, or
> `http://127.0.0.1:3301/__gate/setup` from the host itself.

```sh
# Today: clone and deploy (there is deliberately no npm package yet — see the note below)
git clone https://github.com/Aztech-Lab/dsh-3301
cd dsh-3301
node tools/deploy.mjs dsh-3301
```

> The first line people reach for — `dsh plugin --profile web add dsh-3301` — needs an npm package,
> and none is published (by choice: the repository is the install source, and it has no build step).
> Use the clone-and-deploy path above until that changes.

> The deploy target is your DSH profile (`$DSH_HOME/profiles/<profile>`), which normally lives
> **outside this repository**. If the write is refused (`EACCES: permission denied`), grant that
> directory write access, or run the command as the user that owns `$DSH_HOME`.

Restart DSH afterwards, then open **Settings → Plugins → Plugin configuration → dsh-3301**:

| Field | Meaning |
|---|---|
| Enabled | turning it off releases the listening port |
| Bind host | `0.0.0.0` (LAN reachable) / `127.0.0.1` (host only) |
| Port | default `3301` |
| Username | login name on the gate form, default `dsh` |
| Session lifetime | session-cookie validity, default **30 days** |
| Failure limit / lockout | per-IP lockout after repeated failed logins |
| Inject client bootstrap | adds `__DSH_TRANSPORT__.ownsHost` so a LAN page keeps host-backed settings |
| Password | write-only input: empty = clear; changing it requires the current password |

For first-run setup you can also open `http://127.0.0.1:3301/__gate/setup` on the host, and
`http://127.0.0.1:3301/__gate/health` reports the entry's state without authentication.

The card follows the shipped DSH plugin cards; its styling uses the declarations and theme
variables of DSH's own `dsh-client-ui-settings-plugins` package (BSD-3-Clause). All implementation
code here is original.

> The standalone CLI (`node lib/cli.js`, `DSH_PROXY_*` environment variables) is unchanged and still
> supported for running a proxy outside DSH.

## Why

> This section describes the **standalone CLI** form; the plugin form above differs in auth (form login + scrypt) and needs no TLS of its own.

- **DSH stays loopback-only** — never exposed directly.
- **Cookie-session auth** — avoids the repeated Basic-Auth re-prompt that breaks
  WebSocket/SSE-heavy apps. First request passes Basic Auth, then a signed
  session cookie is issued; later requests (incl. WebSocket upgrades) are
  accepted by the cookie. The session cookie persists **30 days** (Max-Age), so
  you don't re-authenticate on every browser restart. The proxy **appends** its
  cookie to DSH's own Set-Cookie (e.g. language prefs) instead of overwriting
  it, so DSH settings persist.
- **HTTPS (optional)** — a self-signed cert encrypts the password/session on
  the wire.
- **Rate limiting** — locks out an IP after too many failed logins.
- **Zero-install dependencies** — the CLI is pure Node built-ins; the plugin reuses packages DSH already ships.

## Run (standalone CLI)

> Running it as a DSH plugin is the path above.

```bash
DSH_PROXY_PASS=yourpassword node lib/cli.js
# or after installing the bin
DSH_PROXY_PASS=yourpassword dsh-3301
```

Then open `http://<this-machine-ip>:3301` from any device on the LAN.

### Env (standalone CLI only — the plugin is configured from its settings card)

| var | default | meaning |
|---|---|---|
| `DSH_PROXY_PORT` | `3301` | listen port |
| `DSH_PROXY_HOST` | `0.0.0.0` | listen host |
| `DSH_PROXY_USER` | `dsh` | basic-auth username |
| `DSH_PROXY_PASS` | *(required)* | basic-auth password |
| `DSH_UPSTREAM` | `127.0.0.1:3080` | upstream DSH host:port |
| `DSH_PROXY_SECRET_FILE` | `os.tmpdir()/dsh-3301-secret` | session-signing secret file |
| `DSH_PROXY_CERT` | `/tmp/dsh-3301-cert.pem` | HTTPS cert (enables TLS if present) |
| `DSH_PROXY_KEY` | `/tmp/dsh-3301-key.pem` | HTTPS key |

## HTTPS (recommended, standalone CLI only)

> The plugin's `3301` entry is plain HTTP — put TLS or a tunnel in front of it if the network is untrusted.

Generate a self-signed cert once, then the proxy serves HTTPS:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/dsh-3301-key.pem -out /tmp/dsh-3301-cert.pem \
  -days 365 -subj "/CN=dsh-3301"
```

Browsers will show a one-time self-signed warning — accept it once. The
password and session are then encrypted on the wire.

## macOS launchd (auto-start, standalone CLI only)

> The plugin starts and stops with DSH, so no launchd entry is needed.

See `com.dsh.lan-proxy.plist` (template). Load it with:

```bash
launchctl bootstrap gui/$(id -u) /path/to/com.dsh.lan-proxy.plist
```

### Manual stop / start

```bash
# stop (turn the proxy off)
launchctl bootout gui/$(id -u)/com.dsh.lan-proxy

# start again
launchctl bootstrap gui/$(id -u) /path/to/Library/LaunchAgents/com.dsh.lan-proxy.plist

# check status
launchctl list | grep dsh.lan-proxy
```

## Security notes & risks

**What's hardened:**
- DSH stays loopback-only (never exposed directly).
- Auth is a HMAC-SHA256 signed cookie with constant-time comparison and
  `HttpOnly` — tamper-proof and resistant to timing attacks.
- Rate limiting (5 failures → 5 min lockout) is on by default.
- HTTPS (when enabled) encrypts the password and session on the wire.

**Known risks / things to be aware of:**
- **Weak / plaintext password** — the default example uses a short numeric
  password stored in plaintext in the launchd plist. Anyone who can read the
  plist (or the process env) sees it. **Use a strong, random password** and
  keep it out of plaintext config where possible.
- **Self-signed cert** — browsers show a one-time warning. The encryption is
  real (RSA 2048), but the cert isn't from a trusted CA, so a MITM on first
  connect is theoretically possible if the user blindly accepts without
  verifying the fingerprint.
- **LAN exposure** — the proxy binds to `0.0.0.0`; anyone on the LAN can
  attempt access. The password is the only gate. On an untrusted network this
  is not sufficient.
- **No per-IP allowlist** — access is password-only. If you need stricter
  control, put this behind a VPN (e.g. Tailscale) or add an IP allowlist.

**Recommended deployment:**
1. Use a **strong password** (≥12 chars, mixed).
2. **Enable HTTPS** (self-signed is fine for a trusted LAN).
3. Put it behind a **VPN** (Tailscale/WireGuard) if the LAN isn't trusted.
4. Keep the password out of plaintext config (use a secret file with 0600
   perms, or an env from a secure source).

## Contributing

Contributions are welcome! Ideas that would help:

- **IP allowlist** / per-user access control.
- **OAuth2 / SSO** login (replace the password with an existing account).
- **Proper TLS** via mkcert or Let's Encrypt.
- **Brute-force hardening** (exponential backoff, persistent lockout state).
- **Tests** and CI.
- Better docs / translations.

Open an issue or PR — see the [GitHub repo](https://github.com/).

## Acknowledgement

This work is conducted by [Aztech Labs](https://github.com/Aztech-Lab) with DeepSeek Harness (Deepseek-V4.1-Flash).

## License

MIT
