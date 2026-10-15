// Fetching that can't be pointed at your own server or private network (SSRF protection).
// Every connection, including each redirect hop, resolves DNS through checkedLookup,
// so a hostname that later re-resolves to a private address is still refused.
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as ufetch } from "undici";

const PRIVATE_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const v4num = ip => ip.split(".").reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
export function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const n = v4num(ip);
    return PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (v4num(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return isPrivateIP(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

// Test hook: lets the test suite reach its local fixture server. Never set this in production.
const ALLOW_LOCAL = process.env.ALLOW_LOCAL_FETCH === "1";

function checkedLookup(hostname, opts, cb) {
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: opts.family || 4 }];
    const ok = ALLOW_LOCAL ? list : list.filter(a => !isPrivateIP(a.address));
    if (!ok.length) return cb(Object.assign(new Error("Blocked: that address points to a private network."), { code: "EBLOCKED" }));
    if (opts.all) cb(null, ok); else cb(null, ok[0].address, ok[0].family);
  });
}

export const guardedAgent = new Agent({ connect: { lookup: checkedLookup }, connectTimeout: 10_000, headersTimeout: 30_000, bodyTimeout: 60_000 });
const plainAgent = new Agent({ connectTimeout: 15_000, headersTimeout: 120_000, bodyTimeout: 120_000 });

export function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw httpError(400, "That doesn't look like a web address. Paste the full listing link, starting with https://"); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, "Only http and https links can be imported.");
  if (u.username || u.password) throw httpError(400, "Links with a username or password can't be imported.");
  if (u.port && !["80", "443"].includes(u.port) && !ALLOW_LOCAL) throw httpError(400, "That link uses an unusual port and can't be imported.");
  if (!ALLOW_LOCAL && (net.isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateIP(u.hostname.replace(/^\[|\]$/g, "")))) throw httpError(400, "That address points to a private network and can't be imported.");
  if (!ALLOW_LOCAL && /^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw httpError(400, "That address points to a private network and can't be imported.");
  return u;
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Fetch a public URL, following up to 5 redirects, each one re-checked.
export async function safeFetch(url, { maxBytes = 25e6, accept = "*/*", timeout = 20000 } = {}) {
  let current = assertPublicUrl(url).href;
  for (let hop = 0; hop < 6; hop++) {
    const ctl = AbortSignal.timeout(timeout);
    const res = await ufetch(current, { dispatcher: guardedAgent, redirect: "manual", signal: ctl,
      headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = assertPublicUrl(new URL(res.headers.get("location"), current)).href; await res.body?.cancel(); continue;
    }
    const buf = await readCapped(res, maxBytes);
    return { status: res.status, headers: res.headers, buf, url: current };
  }
  throw httpError(502, "That link redirected too many times.");
}

export async function plainFetch(url, opts = {}) {
  const res = await ufetch(url, { dispatcher: plainAgent, ...opts, signal: AbortSignal.timeout(opts.timeout || 120000) });
  const buf = await readCapped(res, opts.maxBytes || 30e6);
  return { status: res.status, headers: res.headers, buf };
}

async function readCapped(res, maxBytes) {
  const len = +res.headers.get("content-length") || 0;
  if (len > maxBytes) { await res.body?.cancel(); throw httpError(413, "That file is too large."); }
  if (!res.body) return Buffer.alloc(0);                     // e.g. 204 No Content
  const chunks = []; let total = 0;
  for await (const c of res.body) { total += c.length; if (total > maxBytes) throw httpError(413, "That file is too large."); chunks.push(c); }
  return Buffer.concat(chunks);
}
