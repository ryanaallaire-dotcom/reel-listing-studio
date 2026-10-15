// Reel Listing Studio server: hosts the Studio page and adds "paste a listing link".
//   GET  /               the Studio
//   GET  /api/health     lets the Studio know link import is available
//   POST /api/import     { url } → ZIP of photos + listing.json (same format as the Chrome Grabber)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importListing } from "./lib/import.js";
import { providerInfo } from "./lib/providers.js";
import { assertPublicUrl } from "./lib/safe-fetch.js";
import { runAI, aiEnabled } from "./lib/ai.js";
import { startClip, clipStatus, clipVideo, clipsEnabled, clipModel } from "./lib/clips.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8787;
const ACCESS_KEY = process.env.ACCESS_KEY || "";            // optional: require a key while in private beta
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
const hits = new Map(), aiHits = new Map(), clipHits = new Map();
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
    if (req.method === "GET" && u.pathname === "/api/health") {
      return json(res, 200, { ok: true, service: "reel-listing", import: true, provider: providerInfo() || "none", keyRequired: !!ACCESS_KEY, ai: aiEnabled(),
        clips: clipsEnabled(), clipModel: clipsEnabled() ? clipModel() : null, maxClips: MAX_CLIPS_PER_VIDEO, depth: fs.existsSync(DEPTH_MODEL) });
    }
    if (u.pathname.startsWith("/api/clips")) {
      if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return json(res, 401, { error: "Enter your access key next to the listing link, then try again." });
      const owner = clientIp(req);
      if (req.method === "POST" && u.pathname === "/api/clips") {
        if (!clipsEnabled()) return json(res, 404, { error: "AI motion isn't set up on this server." });
        const body = await readJson(req, 6e6);
        if (!allow(owner, clipHits, CLIPS_PER_HOUR)) return json(res, 429, { error: `You've made ${CLIPS_PER_HOUR} AI clips this hour. Wait a bit, then try again.` });
        return json(res, 200, { id: startClip(body, owner) });
      }
      const m = u.pathname.match(/^\/api\/clips\/([0-9a-f-]{36})(\/video)?$/);
      if (req.method === "GET" && m) {
        if (m[2]) { const buf = clipVideo(m[1], owner); res.writeHead(200, { "content-type": "video/mp4", "content-length": buf.length, "cache-control": "no-store" }); return res.end(buf); }
        return json(res, 200, clipStatus(m[1], owner));
      }
    }
    if (req.method === "POST" && u.pathname === "/api/import") {
      if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return json(res, 401, { error: "This studio needs an access key for link import. Enter the key you were given, then try again." });
      const { url } = await readJson(req);
      if (!url || typeof url !== "string") return json(res, 400, { error: "Paste a listing link first." });
      assertPublicUrl(url);
      const key = cacheKey(url), hit = cacheGet(key);
      if (!hit) {
        if (!allow(clientIp(req))) return json(res, 429, { error: `You've imported ${PER_HOUR} listings this hour. Wait a bit, then try again.` });
        if (running >= MAX_PARALLEL) return json(res, 503, { error: "The importer is busy with other listings. Try again in a few seconds." });
      }
      let out = hit;
      if (!out) { running++; try { out = await importListing(url); cacheSet(key, out); } finally { running--; } }
      res.writeHead(200, { "content-type": "application/zip", "content-length": out.zip.length, "x-photo-count": out.count, "x-import-via": out.via, "cache-control": "no-store",
        "content-disposition": "attachment; filename=listing.zip" });
      return res.end(out.zip);
    }
    if (req.method === "POST" && u.pathname === "/api/ai") {
      if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return json(res, 401, { error: "Enter your access key next to the listing link, then try again." });
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
  server.listen(PORT, () => console.log(`Reel Listing Studio on http://localhost:${PORT}  (page service: ${providerInfo() || "none — protected sites will ask for the Grabber"}; AI: ${aiEnabled() ? "on" : "off"}; AI motion: ${clipsEnabled() ? "on" : "off"}; 3D depth: ${fs.existsSync(DEPTH_MODEL) ? "on" : "off"})`));
}
