/**
 * dsh-3301 — client bootstrap injection.
 *
 * DSH decides whether a page counts as "the host" from the page's own address:
 * `isLoopback: transport?.ownsHost === true || … || isLoopbackHostname(pageLocation.hostname)`.
 * A LAN page behind this proxy is never a loopback address, so without the
 * `ownsHost` signal the settings plane degrades to memory-only (edits do not
 * persist) and host-native actions such as opening a produced file stay
 * disabled.
 *
 * This module injects a small script into HTML responses that
 *   1. merges `ownsHost: true` into `globalThis.__DSH_TRANSPORT__`, preserving
 *      every other field a different shell may have put there, and
 *   2. installs an RFC 4122 v4 `crypto.randomUUID` fallback when the browser
 *      withholds it (secure-context-only API, absent on plain-HTTP LAN origins).
 *
 * HTML is decompressed before injection and returned identity-encoded, because
 * injecting into a compressed body would corrupt it. Other content types are
 * streamed untouched, so assets keep their compression.
 */
import zlib from "node:zlib";

const MARKER = "<!--dsh-3301-bootstrap-->";
const SCRIPT_ATTR = 'data-dsh-3301-bootstrap="1"';

/** Inline bootstrap source; each half is defensive and independent. */
export function bootstrapSource({ transport = true, uuidFallback = true } = {}) {
	const parts = [];
	if (transport) {
		parts.push(
			"var t=g.__DSH_TRANSPORT__;" +
				"if(t===undefined||t===null){g.__DSH_TRANSPORT__={ownsHost:true}}" +
				"else if(t.ownsHost!==true){try{t.ownsHost=true}catch(e){g.__DSH_TRANSPORT__=Object.assign({},t,{ownsHost:true})}}"
		);
	}
	if (uuidFallback) {
		parts.push(
			"var c=g.crypto;" +
				'if(c&&typeof c.randomUUID!=="function"&&typeof c.getRandomValues==="function"){' +
				"try{c.randomUUID=function(){" +
				"var b=c.getRandomValues(new Uint8Array(16));" +
				"b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;" +
				'var s="";for(var i=0;i<16;i++){s+=(b[i]+256).toString(16).slice(1)}' +
				'return s.slice(0,8)+"-"+s.slice(8,12)+"-"+s.slice(12,16)+"-"+s.slice(16,20)+"-"+s.slice(20)' +
				"}}catch(e){}" +
				"}"
		);
	}
	if (parts.length === 0) return "";
	return "(function(){try{var g=typeof globalThis!=='undefined'?globalThis:window;" + parts.join("") + "}catch(e){}})();";
}

/** Insert the script after the opening <head> tag; idempotent. */
export function injectBootstrap(html, source = bootstrapSource()) {
	if (source === "" || typeof html !== "string") return html;
	if (html.includes(MARKER)) return html;
	const tag = `${MARKER}<script ${SCRIPT_ATTR}>${source}</script>`;
	const head = /<head(\s[^>]*)?>/i.exec(html);
	if (head === null) return tag + html;
	const at = head.index + head[0].length;
	return html.slice(0, at) + tag + html.slice(at);
}

/** Whether a response is HTML we should rewrite. */
export function isHtml(headers) {
	const type = String(headers["content-type"] || "");
	return /^text\/html\b/i.test(type);
}

/** Decode a compressed HTML body; returns undefined when the encoding is unsupported. */
function decode(body, encoding) {
	const value = String(encoding || "").toLowerCase();
	try {
		if (value === "" || value === "identity") return body;
		if (value === "gzip") return zlib.gunzipSync(body);
		if (value === "deflate") return zlib.inflateSync(body);
		if (value === "br") return zlib.brotliDecompressSync(body);
	} catch {
		return undefined;
	}
	return undefined;
}

/** Hop-by-hop headers must not be forwarded; framing is decided locally. */
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

/**
 * Copy response headers without hop-by-hop entries. Forwarding upstream's
 * `transfer-encoding` alongside a body this process re-frames produces an
 * invalid response (Content-Length with Transfer-Encoding), so it is dropped
 * everywhere a body is re-sent.
 */
export function sanitizeHeaders(headers) {
	const out = {};
	for (const [key, value] of Object.entries(headers)) {
		if (HOP_BY_HOP.has(key.toLowerCase())) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Rewrite one buffered HTML response.
 *
 * @param headers upstream response headers (not mutated)
 * @param body    raw upstream body bytes
 * @param source  bootstrap source
 * @returns {{ headers: object, body: Buffer }} response to send, or undefined
 *          when the body could not be decoded (caller should then stream it raw)
 */
export function rewriteHtmlResponse(headers, body, source = bootstrapSource()) {
	const decoded = decode(body, headers["content-encoding"]);
	if (decoded === undefined) return undefined;
	const original = decoded.toString("utf8");
	const html = injectBootstrap(original, source);
	if (html === original) return { headers: sanitizeHeaders(headers), body };
	const out = sanitizeHeaders(headers);
	out["content-length"] = String(Buffer.byteLength(html));
	delete out["content-encoding"];
	out.vary = out.vary ? `${out.vary}, Accept-Encoding` : "Accept-Encoding";
	return { headers: out, body: Buffer.from(html, "utf8") };
}
