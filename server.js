// Reel Listing Studio server: hosts the Studio page and adds "paste a listing link".
//   GET  /               the Studio
//   GET  /api/health     lets the Studio know link import is available
//   POST /api/import     { url } → ZIP of photos + listing.json (same format as the Chrome Grabber)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importListing } from "./lib/import.js";
import { providerInfo } from "./lib/providers.js";
import { assertPublicUrl } from "./lib/safe-fetch.js";
import { runAI, aiEnabled } from "./lib/ai.js";
import { startClip, clipStatus, clipVideo, clipsEnabled, clipModel, clipSource } from "./lib/clips.js";
import * as acct from "./lib/accounts.js";
import { paypalEnabled, ensureSetup, clientConfig, confirmSubscription, cancelSubscription, createTopup, captureTopup, handleWebhook } from "./lib/paypal.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8787;
const ACCESS_KEY = process.env.ACCESS_KEY || "";            // optional: invite code required to create an account (private beta)
const SECURE = process.env.TRUST_PROXY === "1";
const PER_HOUR = +process.env.IMPORTS_PER_HOUR || 20;       // per visitor
const MAX_PARALLEL = +process.env.MAX_PARALLEL_IMPORTS || 3;
const CACHE_HOURS = +process.env.CACHE_HOURS || 24;
const AI_PER_HOUR = +process.env.AI_PER_HOUR || 60;            // per visitor
const CLIPS_PER_HOUR = +process.env.CLIPS_PER_HOUR || 30;       // per visitor — each clip costs you money
const MAX_CLIPS_PER_VIDEO = +process.env.MAX_CLIPS_PER_VIDEO || 6;
const DEPTH_MODEL = path.join(DIR, "public", "models", "depth_q8.onnx");
const STATIC = { "/vendor/": path.join(DIR, "public", "vendor"), "/models/": path.join(DIR, "public", "models") };
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".onnx": "application/octet-stream" };

const STUDIO = path.join(DIR, "public", "index.html");
const SKELETON_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style></head><body>`;
const page = () => { const body = fs.readFileSync(STUDIO, "utf8"); return /^<!doctype/i.test(body) ? body : SKELETON_HEAD + body + "</body></html>"; };

// --- small in-memory helpers (fine for one server; use Redis if you run several) ---
const hits = new Map(), aiHits = new Map(), clipHits = new Map(), authHits = new Map();
function allow(ip, map = hits, limit = PER_HOUR) {
  const now = Date.now(), list = (map.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= limit) { map.set(ip, list); return false; }
  list.push(now); map.set(ip, list); return true;
}
const cache = new Map(); let cacheBytes = 0; const CACHE_MAX = 400e6;
function cacheGet(k) { const e = cache.get(k); if (!e) return null; if (Date.now() - e.at > CACHE_HOURS * 3600e3) { cache.delete(k); cacheBytes -= e.zip.length; return null; } return e; }
function cacheSet(k, v) { cache.set(k, { ...v, at: Date.now() }); cacheBytes += v.zip.length;
  for (const [key, e] of cache) { if (cacheBytes <= CACHE_MAX) break; cache.delete(key); cacheBytes -= e.zip.length; } }
let running = 0;

const needUser = req => { const u = acct.userFrom(req); if (!u) throw Object.assign(new Error("Sign in (or create a free account) to use this."), { status: 401 }); return u; };
const meJson = u => acct.publicUser(u);
const json = (res, status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const clientIp = req => (process.env.TRUST_PROXY === "1" && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "?";
const cacheKey = u => { try { const x = new URL(u); x.hash = ""; ["utm_source", "utm_medium", "utm_campaign", "fbclid", "gclid"].forEach(p => x.searchParams.delete(p)); return x.href; } catch { return u; } };

async function readJson(req, limit = 10000) {
  let s = ""; for await (const c of req) { s += c; if (s.length > limit) throw Object.assign(new Error("Request too large."), { status: 413 }); }
  try { return JSON.parse(s || "{}"); } catch { throw Object.assign(new Error("Send JSON like {\"url\": \"https://...\"}."), { status: 400 }); }
}

export const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");                       // no one can embed the studio in their page
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.TRUST_PROXY === "1") res.setHeader("strict-transport-security", "max-age=31536000");
  try {
    if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); return res.end(page());
    }
    if (req.method === "GET") {
      const pre = Object.keys(STATIC).find(p => u.pathname.startsWith(p));
      if (pre) {
        const name = path.basename(decodeURIComponent(u.pathname.slice(pre.length)));
        const file = path.join(STATIC[pre], name), type = TYPES[path.extname(name)];
        if (!type || !name || name.startsWith(".") || !fs.existsSync(file)) return json(res, 404, { error: "Not found." });
        const st = fs.statSync(file);
        res.writeHead(200, { "content-type": type, "content-length": st.size, "cache-control": "public, max-age=604800, immutable" });
        return fs.createReadStream(file).pipe(res);
      }
    }
    // browsers can't send JSON to another site without permission, so requiring it blocks cross-site form tricks
    if (req.method === "POST" && u.pathname.startsWith("/api/") && u.pathname !== "/api/paypal/webhook" && !/^application\/json/i.test(req.headers["content-type"] || ""))
      return json(res, 415, { error: "Send JSON." });
    if (u.pathname.startsWith("/api/account/") || u.pathname === "/api/me") {
      if (req.method === "GET" && u.pathname === "/api/me") {
        let paypal = null; try { paypal = await clientConfig(); } catch (e) { console.error("paypal setup", e.message); }
        return json(res, 200, { user: meJson(acct.userFrom(req)), tiers: acct.TIERS, topup: acct.TOPUP, paypal, inviteRequired: !!ACCESS_KEY });
      }
      if (req.method === "POST" && (u.pathname === "/api/account/signup" || u.pathname === "/api/account/login")) {
        if (!allow(clientIp(req), authHits, 20)) return json(res, 429, { error: "Too many sign-in attempts. Wait a few minutes, then try again." });
        const body = await readJson(req);
        const token = u.pathname.endsWith("signup") ? acct.signup(body) : acct.login(body);
        res.setHeader("set-cookie", acct.sessionCookie(token, SECURE));
        return json(res, 200, { user: meJson(acct.userFrom({ headers: { cookie: `${acct.cookieName}=${token}` } })) });
      }
      if (req.method === "POST" && u.pathname === "/api/account/logout") {
        acct.logout(acct.tokenFrom(req)); res.setHeader("set-cookie", acct.sessionCookie("", SECURE)); return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && u.pathname === "/api/account/password") {
        const user = needUser(req); acct.changePassword(user, await readJson(req)); return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && u.pathname === "/api/account/subscribe") {
        const user = needUser(req); const { subscriptionID } = await readJson(req); return json(res, 200, { user: meJson(await confirmSubscription(user, subscriptionID)) });
      }
      if (req.method === "POST" && u.pathname === "/api/account/cancel") {
        const user = needUser(req); return json(res, 200, { user: meJson(await cancelSubscription(user)) });
      }
      if (req.method === "POST" && u.pathname === "/api/account/topup") {
        const user = needUser(req); return json(res, 200, { id: await createTopup(user) });
      }
      if (req.method === "POST" && u.pathname === "/api/account/topup/capture") {
        const user = needUser(req); const { orderID } = await readJson(req); return json(res, 200, { user: meJson(await captureTopup(user, orderID)) });
      }
      if (u.pathname === "/api/account/admin") {
        const user = needUser(req); if (!acct.isAdmin(user)) return json(res, 403, { error: "Admins only." });
        if (req.method === "GET") return json(res, 200, { users: acct.adminList() });
        const { email, credits } = await readJson(req); return json(res, 200, { user: acct.adminGrant(email, credits) });
      }
    }
    if (req.method === "POST" && u.pathname === "/api/paypal/webhook") {
      if (!paypalEnabled()) return json(res, 404, { error: "Not found." });
      const event = await readJson(req, 200000);
      try { return json(res, 200, { result: await handleWebhook(req.headers, event) }); }
      catch (e) { console.warn("paypal webhook", e.message); return json(res, e.status || 500, { error: "Rejected." }); }
    }
    if (req.method === "GET" && u.pathname === "/api/health") {
      return json(res, 200, { ok: true, service: "reel-listing", import: true, provider: providerInfo() || "none", keyRequired: false, accounts: true, accountsSaved: acct.dbPersistent(), payments: paypalEnabled(), ai: aiEnabled(),
        clips: clipsEnabled(), clipModel: clipsEnabled() ? clipModel() : null, maxClips: MAX_CLIPS_PER_VIDEO, depth: fs.existsSync(DEPTH_MODEL) });
    }
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/api/clip-src/")) {      // the photo fal downloads; unguessable, expires in 30 min
      const tok = u.pathname.slice(14).replace(/\.(jpg|png|webp)$/, "");
      const e = /^[0-9a-f]{48}$/.test(tok) && clipSource(tok);
      if (!e) return json(res, 404, { error: "Not found." });
      res.writeHead(200, { "content-type": e.type, "content-length": e.buf.length, "cache-control": "private, max-age=1800" }); return res.end(e.buf);
    }
    if (u.pathname.startsWith("/api/clips")) {
      const user = needUser(req), owner = "u" + user.id;
      if (req.method === "POST" && u.pathname === "/api/clips") {
        if (!clipsEnabled()) return json(res, 404, { error: "AI motion isn't set up on this server." });
        const body = await readJson(req, 6e6);
        const charge = acct.spend(user.id, 1, "ai_clip", crypto.randomUUID());     // 1 credit per clip, refunded if the clip fails
        if (!acct.isAdmin(user) && !allow(owner, clipHits, CLIPS_PER_HOUR)) { acct.refund(user.id, charge, "clip_refund", "limit-" + crypto.randomUUID()); return json(res, 429, { error: `You've made ${CLIPS_PER_HOUR} AI clips this hour. Wait a bit, then try again.` }); }
        let id;
        const host = String(req.headers["x-forwarded-host"] || req.headers.host || "");
        const publicBase = process.env.PUBLIC_URL || (process.env.TRUST_PROXY === "1" && /^[\w.-]+(:\d+)?$/.test(host) ? `${String(req.headers["x-forwarded-proto"] || "http").split(",")[0]}://${host}` : "");
        try { id = startClip(body, owner, { publicBase, admin: acct.isAdmin(user), onFail: jid => acct.refund(user.id, charge, "clip_refund", jid) }); }
        catch (e) { acct.refund(user.id, charge, "clip_refund", "start-" + crypto.randomUUID()); throw e; }
        return json(res, 200, { id, credits: acct.publicUser(acct.getUser(user.id)).credits });
      }
      const m = u.pathname.match(/^\/api\/clips\/([0-9a-f-]{36})(\/video)?$/);
      if (req.method === "GET" && m) {
        if (m[2]) { const buf = clipVideo(m[1], owner); res.writeHead(200, { "content-type": "video/mp4", "content-length": buf.length, "cache-control": "no-store" }); return res.end(buf); }
        return json(res, 200, clipStatus(m[1], owner));
      }
    }
    if (req.method === "POST" && u.pathname === "/api/import") {
      const user = needUser(req);
      const { url } = await readJson(req);
      if (!url || typeof url !== "string") return json(res, 400, { error: "Paste a listing link first." });
      assertPublicUrl(url);
      const key = cacheKey(url), hit = cacheGet(key);
      if (!hit) {
        if (!allow(clientIp(req))) return json(res, 429, { error: `You've imported ${PER_HOUR} listings this hour. Wait a bit, then try again.` });
        if (running >= MAX_PARALLEL) return json(res, 503, { error: "The importer is busy with other listings. Try again in a few seconds." });
      }
      acct.countImport(user);
      let out = hit;
      if (!out) { running++; try { out = await importListing(url); cacheSet(key, out); } catch (e) { acct.uncountImport(user); throw e; } finally { running--; } }
      res.writeHead(200, { "content-type": "application/zip", "content-length": out.zip.length, "x-photo-count": out.count, "x-import-via": out.via, "cache-control": "no-store",
        "content-disposition": "attachment; filename=listing.zip" });
      return res.end(out.zip);
    }
    if (req.method === "POST" && u.pathname === "/api/ai") {
      needUser(req);
      if (!aiEnabled()) return json(res, 404, { error: "AI isn't set up on this server." });
      if (!allow(clientIp(req), aiHits, AI_PER_HOUR)) return json(res, 429, { error: `You've used the AI ${AI_PER_HOUR} times this hour. Wait a bit, then try again.` });
      const body = await readJson(req, 25e6);
      return json(res, 200, await runAI(body));
    }
    json(res, 404, { error: "Not found." });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !e.status) console.error(e);
    json(res, status, { error: e.status ? e.message : "Something failed on our side. Try again in a moment." });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  acct.openDb();
  if (!process.env.DB_PATH) console.warn("DB_PATH isn't set: accounts are stored inside the app and are lost on every redeploy. Attach a disk and set DB_PATH.");
  ensureSetup().then(s => s && console.log("PayPal ready:", JSON.stringify(s.plans))).catch(e => console.error("PayPal setup failed:", e.message));
  server.listen(PORT, () => console.log(`Reel Listing Studio on http://localhost:${PORT}  (page service: ${providerInfo() || "none — protected sites will ask for the Grabber"}; AI: ${aiEnabled() ? "on" : "off"}; AI motion: ${clipsEnabled() ? "on" : "off"}; 3D depth: ${fs.existsSync(DEPTH_MODEL) ? "on" : "off"})`));
}
