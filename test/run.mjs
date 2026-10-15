// End-to-end tests: a fake listing site + a fake page service + the real server.
//   node test/run.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, "fixtures");
const results = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  (${String(detail).slice(0, 160)})` : ""}`); };

// ---------- fake listing site ----------
const FX = 18901, MOCK = 18902;
const img = n => `http://127.0.0.1:${FX}/img/${n}`;
const listingPage = (photos) => `<!doctype html><html><head><title>1420 Birch Hollow Rd, Hudson, WI 54016 | MLS #889123</title>
<meta property="og:title" content="1420 Birch Hollow Rd, Hudson, WI 54016">
<meta property="og:description" content="4 bed, 3 bath, 2,850 sq ft lake home with a chef's kitchen and screened porch.">
<meta property="og:image" content="${img("photo1.jpg")}">
<script type="application/ld+json">{"@type":"SingleFamilyResidence","address":{"streetAddress":"1420 Birch Hollow Rd","addressLocality":"Hudson","addressRegion":"WI"}}</script>
</head><body><img src="${img("logo.png")}"><main><h1>1420 Birch Hollow Rd</h1><p>$649,900 · 4 beds · 3 baths · 2,850 sqft</p>
${photos.map(p => `<img src="${img(p.replace(".jpg", "_thumb.jpg"))}" srcset="${img(p.replace(".jpg", "_thumb.jpg"))} 300w, ${img(p)} 1600w">`).join("\n")}
<script>window.__DATA__={"price":649900,"bedrooms":4,"bathrooms":3,"livingArea":2850,"photos":[${photos.map(p => `{"url":"${img(p).replace(/\//g, "\\/")}"}`).join(",")}]}</script>
</main></body></html>`;
const all8 = Array.from({ length: 8 }, (_, i) => `photo${i + 1}.jpg`);
const fixture = http.createServer((req, res) => {
  if (req.url.startsWith("/img/")) { const f = path.join(FIX, path.basename(req.url)); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": req.url.endsWith(".png") ? "image/png" : "image/jpeg" }); return res.end(fs.readFileSync(f)); }
  if (req.url.split("?")[0] === "/listing/889123") { res.writeHead(200, { "content-type": "text/html" }); return res.end(listingPage(all8)); }
  if (req.url === "/redirect") { res.writeHead(302, { location: "/listing/889123" }); return res.end(); }
  if (req.url === "/nophotos") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><title>Empty</title><body>Nothing here</body></html>"); }
  if (req.url === "/blocked") { res.writeHead(403, { "content-type": "text/html" }); return res.end("<html>Access to this page has been denied. Are you a robot?</html>"); }
  res.writeHead(404); res.end();
});
// ---------- fake page service (stands in for ScraperAPI) ----------
let mockCalls = [];
const mock = http.createServer((req, res) => {
  const q = new URL(req.url, "http://x").searchParams; mockCalls.push(Object.fromEntries(q));
  res.writeHead(200, { "content-type": "text/html" });
  // tier 1 comes back thin (1 photo), tier 2 (ultra premium + render) has the full gallery
  res.end(q.get("ultra_premium") ? listingPage(all8) : listingPage(["photo1.jpg"]));
});

// ---------- fake Claude API ----------
const AIM = 18903; let aiCalls = [];
const aimock = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; const j = JSON.parse(b); aiCalls.push({ key: req.headers["x-api-key"], ver: req.headers["anthropic-version"], body: j });
  const text = '{"labels":["Sunny Living Room"],"order":[1]}';
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn" }));
});
// ---------- fake fal.ai (AI video) ----------
const FALM = 18904; let falCalls = [], falPolls = 0;
const falmock = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c;
  const send = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "POST") { const j = JSON.parse(b); falCalls.push({ path: req.url, auth: req.headers.authorization, body: j });
    if (/ZmFpbC1tZQ/.test(j.image_url)) return send({ detail: "bad" }, 422);
    return send({ request_id: "r1", status_url: `http://127.0.0.1:${FALM}/st/r1`, response_url: `http://127.0.0.1:${FALM}/res/r1` }); }
  if (req.url === "/st/r1") { falPolls++; return send({ status: falPolls < 2 ? "IN_PROGRESS" : "COMPLETED" }); }
  if (req.url === "/res/r1") return send({ video: { url: `http://127.0.0.1:${FALM}/v.mp4` } });
  if (req.url === "/v.mp4") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(50000, 7)); }
  res.writeHead(404); res.end();
});
function startServer(port, env) {
  const p = spawn(process.execPath, ["server.js"], { cwd: path.join(DIR, ".."), env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => { p.stdout.on("data", d => { if (String(d).includes("Reel Listing Studio on")) res(p); }); p.stderr.on("data", d => process.stderr.write(d)); p.on("exit", c => rej(new Error("server exited " + c))); });
}
const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/import`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

await new Promise(r => fixture.listen(FX, "127.0.0.1", r));
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));
await new Promise(r => aimock.listen(AIM, "127.0.0.1", r));
await new Promise(r => falmock.listen(FALM, "127.0.0.1", r));

// ===== server A: test mode (may fetch the local fixture), no page service =====
const A = 18911; const sa = await startServer(A, { ALLOW_LOCAL_FETCH: "1", IMPORTS_PER_HOUR: "6" });
{
  const h = await (await fetch(`http://127.0.0.1:${A}/api/health`)).json();
  check("Health says import is available", h.ok && h.service === "reel-listing" && h.import, JSON.stringify(h));
  const page = await (await fetch(`http://127.0.0.1:${A}/`)).text();
  check("Serves the Studio page", page.includes("Reel Listing Studio") && page.includes("importBtn"));

  const r = await post(A, { url: `http://127.0.0.1:${FX}/listing/889123?utm_source=fb` });
  const buf = new Uint8Array(await r.arrayBuffer()); let files = {};
  try { files = unzipSync(buf); } catch (e) {}
  const names = Object.keys(files).sort(); const photos = names.filter(n => /\.(jpg|png|webp)$/.test(n));
  check("Imports a listing link into a ZIP", r.status === 200 && r.headers.get("content-type") === "application/zip", `${r.status} ${names.join(",")}`);
  check("Keeps the 8 full-size photos; drops thumbnails, logo and duplicates", photos.length === 8, photos.join(","));
  const L = files["listing.json"] ? JSON.parse(new TextDecoder().decode(files["listing.json"])) : {};
  check("listing.json has title, description and facts", /Birch Hollow/.test(L.title) && /4 bed/.test(L.description) && /bedrooms: 4/.test(L.text) && /livingArea: 2850/.test(L.text), (L.text || "").slice(0, 120));
  check("Photos come back at full size", files["01.jpg"] && files["01.jpg"].length > 50000, files["01.jpg"]?.length);

  const r2 = await post(A, { url: `http://127.0.0.1:${FX}/listing/889123` });
  check("Same listing again is served from cache", r2.status === 200);
  const rr = await post(A, { url: `http://127.0.0.1:${FX}/redirect` });
  check("Follows redirects", rr.status === 200, rr.status);
  const rn = await post(A, { url: `http://127.0.0.1:${FX}/nophotos` }); const jn = await rn.json();
  check("Page with no photos explains itself", rn.status === 422 && /couldn't find any photos/.test(jn.error), jn.error);
  const rb = await post(A, { url: `http://127.0.0.1:${FX}/blocked` }); const jb = await rb.json();
  check("Blocked page explains itself", rb.status === 422 && /Grabber/.test(jb.error), jb.error);
  const re = await post(A, { url: "" }); const je = await re.json();
  check("Empty link explains itself", re.status === 400 && /Paste a listing link/.test(je.error), je.error);
  const rw = await post(A, { url: "not a link" }); const jw = await rw.json();
  check("Garbage link explains itself", rw.status === 400 && /full listing link/.test(jw.error), jw.error);
  const rf = await post(A, { url: "file:///etc/passwd" }); const jf = await rf.json();
  check("Refuses file:// links", rf.status === 400, jf.error);
  // rate limit: 6/hour, 4 uncached calls used so far (listing, redirect, nophotos, blocked) + a couple more
  let last; for (let k = 0; k < 4; k++) last = await post(A, { url: `http://127.0.0.1:${FX}/nophotos?x=${k}` });
  check("Rate limit kicks in with a clear message", last.status === 429, (await last.json()).error);
}
sa.kill();

// ===== server B: production mode (no local fetching), no page service =====
const B = 18912; const sb = await startServer(B, {});
{
  for (const u of ["http://127.0.0.1:18901/listing/889123", "http://localhost/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/"]) {
    const r = await post(B, { url: u }); const j = await r.json();
    check(`Blocks private address ${u}`, r.status === 400 && /private network|unusual port/.test(j.error), `${r.status} ${j.error}`);
  }
  const r = await post(B, { url: "https://www.zillow.com/homedetails/123_zpid/" }); const j = await r.json();
  check("Zillow without a page-service key says what to do", r.status === 422 && /page-service key|Grabber/.test(j.error), j.error);
}
sb.kill();

// ===== server C: test mode + fake page service, Zillow-style protected link =====
const C = 18913; const sc = await startServer(C, { ALLOW_LOCAL_FETCH: "1", SCRAPER_PROVIDER: "scraperapi", SCRAPER_KEY: "test-key", SCRAPERAPI_BASE: `http://127.0.0.1:${MOCK}/` });
{
  mockCalls = [];
  const r = await post(C, { url: "https://www.zillow.com/homedetails/1420-Birch-Hollow-Rd-Hudson-WI-54016/889123_zpid/" });
  let n = 0; try { n = Object.keys(unzipSync(new Uint8Array(await r.arrayBuffer()))).filter(f => f.endsWith(".jpg")).length; } catch {}
  check("Protected site goes through the page service", r.status === 200 && mockCalls.length >= 1 && mockCalls[0].api_key === "test-key", `${r.status} calls=${mockCalls.length}`);
  check("Tries the cheap tier first, then the full tier when photos are missing", mockCalls.length === 2 && mockCalls[0].premium === "true" && mockCalls[1].ultra_premium === "true" && r.headers.get("x-import-via") === "scraperapi:2", JSON.stringify(mockCalls.map(c => Object.keys(c).join("+"))));
  check("Full gallery imported through the page service", n === 8, n);
}
sc.kill();

// ===== server D: access key required =====
const Dp = 18914; const sd = await startServer(Dp, { ALLOW_LOCAL_FETCH: "1", ACCESS_KEY: "beta-123" });
{
  const h = await (await fetch(`http://127.0.0.1:${Dp}/api/health`)).json();
  const r1 = await post(Dp, { url: `http://127.0.0.1:${FX}/listing/889123` }); const j1 = await r1.json();
  const r2 = await post(Dp, { url: `http://127.0.0.1:${FX}/listing/889123` }, { "x-access-key": "beta-123" });
  check("Access key: health tells the Studio a key is needed", h.keyRequired === true);
  check("Access key: refused without it, with a clear message", r1.status === 401 && /access key/.test(j1.error), j1.error);
  check("Access key: works with it", r2.status === 200);
}
sd.kill();

// ===== server E: AI on =====
const E = 18915; const se = await startServer(E, { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE: `http://127.0.0.1:${AIM}`, AI_PER_HOUR: "3" });
{
  const h = await (await fetch(`http://127.0.0.1:${E}/api/health`)).json();
  check("AI: health reports AI is on", h.ai === true);
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const r = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Label these photos", tier: "quick", images: [px] }) });
  const j = await r.json(); const c = aiCalls.at(-1);
  check("AI: answers through your Anthropic key", r.status === 200 && /Sunny Living Room/.test(j.text) && c.key === "sk-test" && c.ver === "2023-06-01", j.text);
  check("AI: quick tasks use Haiku, photos are passed along", c.body.model === "claude-haiku-5-5" && c.body.messages[0].content[0].type === "image" && /Reel Listing Studio/.test(c.body.system), c.body.model);
  const bad = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", images: ["data:text/html;base64,PGI+"] }) });
  check("AI: rejects non-image uploads", bad.status === 400, (await bad.json()).error);
  const lim = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
  const lim2 = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
  check("AI: hourly limit per visitor", lim2.status === 429, (await lim2.json()).error);
}
se.kill();
// AI off when no key
const F = 18916; const sf = await startServer(F, {});
{
  const h = await (await fetch(`http://127.0.0.1:${F}/api/health`)).json();
  const r = await fetch(`http://127.0.0.1:${F}/api/ai`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x" }) });
  check("AI: off without a key, and says so", h.ai === false && r.status === 404);
}
sf.kill();

// ===== server G: AI motion clips + 3D depth files =====
const Gp = 18917; const sg = await startServer(Gp, { FAL_KEY: "fal-test", FAL_QUEUE_BASE: `http://127.0.0.1:${FALM}`, CLIP_POLL_MS: "100", ALLOW_LOCAL_FETCH: "1", CLIPS_PER_HOUR: "3" });
{
  const h = await (await fetch(`http://127.0.0.1:${Gp}/api/health`)).json();
  check("Clips: health reports AI motion and 3D depth", h.clips === true && h.depth === true && /kling/.test(h.clipModel), JSON.stringify(h));
  const jpg = "data:image/jpeg;base64," + fs.readFileSync(path.join(FIX, "photo1.jpg")).toString("base64");
  const r = await fetch(`http://127.0.0.1:${Gp}/api/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: jpg, kind: "int" }) });
  const { id } = await r.json();
  let st; for (let k = 0; k < 40; k++) { await new Promise(r => setTimeout(r, 100)); st = await (await fetch(`http://127.0.0.1:${Gp}/api/clips/${id}`)).json(); if (st.status === "done" || st.status === "failed") break; }
  const c = falCalls[0] || {};
  check("Clips: sends the photo to the video model with your key", c.auth === "Key fal-test" && /kling-video/.test(c.path) && c.body.image_url.startsWith("data:image/jpeg") && /dolly/.test(c.body.prompt) && /people/.test(c.body.negative_prompt), c.path);
  check("Clips: finishes and the video downloads", st.status === "done", JSON.stringify(st));
  const v = await fetch(`http://127.0.0.1:${Gp}/api/clips/${id}/video`);
  check("Clips: video served as MP4", v.status === 200 && v.headers.get("content-type") === "video/mp4" && (await v.arrayBuffer()).byteLength === 50000);
  const bad = await fetch(`http://127.0.0.1:${Gp}/api/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: "data:text/html;base64,PGI+" }) });
  check("Clips: rejects non-photos", bad.status === 400, (await bad.json()).error);
  const f = await fetch(`http://127.0.0.1:${Gp}/api/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: "data:image/jpeg;base64,ZmFpbC1tZQ==" }) });
  const fid = (await f.json()).id; let fs2; for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); fs2 = await (await fetch(`http://127.0.0.1:${Gp}/api/clips/${fid}`)).json(); if (fs2.status === "failed") break; }
  check("Clips: a failed clip explains itself", fs2.status === "failed" && /still/.test(fs2.error), fs2.error);
  const lim = await fetch(`http://127.0.0.1:${Gp}/api/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: jpg }) });
  check("Clips: hourly limit per visitor", lim.status === 429, (await lim.json()).error);
  const gone = await fetch(`http://127.0.0.1:${Gp}/api/clips/00000000-0000-0000-0000-000000000000`);
  check("Clips: unknown clip says it expired", gone.status === 404);
  const m = await fetch(`http://127.0.0.1:${Gp}/models/depth_q8.onnx`, { method: "HEAD" }).catch(() => null);
  const m2 = await fetch(`http://127.0.0.1:${Gp}/models/depth_q8.onnx`);
  check("Depth model served with caching", m2.status === 200 && /immutable/.test(m2.headers.get("cache-control")) && +m2.headers.get("content-length") > 20e6); await m2.body?.cancel();
  const w = await fetch(`http://127.0.0.1:${Gp}/vendor/ort-wasm-simd-threaded.wasm`); check("Depth engine served as WebAssembly", w.status === 200 && w.headers.get("content-type") === "application/wasm"); await w.body?.cancel();
  const trav = await fetch(`http://127.0.0.1:${Gp}/vendor/..%2F..%2Fserver.js`); check("Static files can't escape their folder", trav.status === 404);
}
sg.kill();
const Hp = 18918; const sh = await startServer(Hp, {});
{ const h = await (await fetch(`http://127.0.0.1:${Hp}/api/health`)).json(); const r = await fetch(`http://127.0.0.1:${Hp}/api/clips`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("Clips: off without a fal.ai key, and says so", h.clips === false && r.status === 404); }
sh.kill();

fixture.close(); mock.close(); aimock.close(); falmock.close();
console.log(results.join("\n"));
console.log(`\n${results.filter(r => r.startsWith("PASS")).length}/${results.length} passed`);
process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
