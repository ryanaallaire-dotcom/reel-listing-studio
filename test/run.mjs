// End-to-end tests: a fake listing site + a fake page service + the real server.
//   node test/run.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(DIR, "fixtures");
const results = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? `  (${String(detail).slice(0, 160)})` : ""}`); };
// every page's own JavaScript must parse: one stray character stops the whole Studio from working
{
  const vm = await import("node:vm");
  for (const f of fs.readdirSync(path.join(DIR, "..", "public")).filter(f => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(DIR, "..", "public", f), "utf8");
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)].filter(m => !/type=["']?(module|application\/(ld\+)?json)/.test(m[1]));
    let err = "";
    for (const m of scripts) { try { new vm.Script(m[2], { filename: f }); } catch (e) { err = `${e.message} near: ${String(e.stack).split("\n")[1] || ""}`.slice(0, 200); break; } }
    check(`Page script parses: ${f}`, !err, err || `${scripts.length} script(s)`);
  }
}

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
    if (/YnJva2U/.test(j.image_url)) return send({ detail: "User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." }, 403);
    return send({ request_id: "r1", status_url: `http://127.0.0.1:${FALM}/st/r1`, response_url: `http://127.0.0.1:${FALM}/res/r1` }); }
  if (req.url === "/st/r1") { falPolls++; return send({ status: falPolls < 2 ? "IN_PROGRESS" : "COMPLETED" }); }
  if (req.url === "/res/r1") return send({ video: { url: `http://127.0.0.1:${FALM}/v.mp4` } });
  if (req.url === "/v.mp4") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.alloc(50000, 7)); }
  res.writeHead(404); res.end();
});
const ADMIN = "owner@test.com";
function startServer(port, env, { keep = false } = {}) {
  const db = path.join(os.tmpdir(), `rls-test-${port}-${process.pid}.db`); if (!keep) for (const x of ["", "-wal", "-shm"]) fs.rmSync(db + x, { force: true });
  const p = spawn(process.execPath, ["server.js"], { cwd: path.join(DIR, ".."), env: { ...process.env, PORT: String(port), DB_PATH: db, ADMIN_EMAILS: ADMIN, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => { p.stdout.on("data", d => { if (String(d).includes("Reel Listing Studio on")) res(p); }); p.stderr.on("data", d => process.stderr.write(d)); p.on("exit", c => rej(new Error("server exited " + c))); });
}
// signed-in sessions per server (cookie jar keyed by port)
const jar = {};
async function api(port, p, body, { method = body === undefined ? "GET" : "POST", as = "default", headers = {} } = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(jar[`${port}:${as}`] ? { cookie: jar[`${port}:${as}`] } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) jar[`${port}:${as}`] = sc.split(";")[0];
  return r;
}
const signIn = (port, email = ADMIN, as = "default", extra = {}) => api(port, "/api/account/signup", { email, password: "correct-horse-1", ...extra }, { as });
const post = (port, body, headers = {}) => api(port, "/api/import", body, { headers });
const postAs = (port, as, p, body) => api(port, p, body, { as });

await new Promise(r => fixture.listen(FX, "127.0.0.1", r));
await new Promise(r => mock.listen(MOCK, "127.0.0.1", r));
await new Promise(r => aimock.listen(AIM, "127.0.0.1", r));
await new Promise(r => falmock.listen(FALM, "127.0.0.1", r));
const RESM = 18906; const mails = [];
const resmock = http.createServer(async (req, res) => { let b = ""; for await (const c of req) b += c; mails.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(b || "{}") }); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1"}'); });
await new Promise(r => resmock.listen(RESM, "127.0.0.1", r));

// ===== server A: test mode (may fetch the local fixture), no page service =====
const A = 18911; const sa = await startServer(A, { ALLOW_LOCAL_FETCH: "1", IMPORTS_PER_HOUR: "6" });
{
  const anon = await post(A, { url: `http://127.0.0.1:${FX}/listing/889123` });
  check("Accounts: import needs a sign-in", anon.status === 401 && /Sign in/.test((await anon.json()).error));
  await signIn(A);
  const h = await (await fetch(`http://127.0.0.1:${A}/api/health`)).json();
  check("Health says import is available", h.ok && h.service === "reel-listing" && h.import, JSON.stringify(h));
  const page = await (await fetch(`http://127.0.0.1:${A}/studio`)).text();
  check("Serves the Studio page at /studio", page.includes("Reel Listing Studio") && page.includes("importBtn"));
  const home = await (await fetch(`http://127.0.0.1:${A}/`)).text();
  const oldSetup = await fetch(`http://127.0.0.1:${A}/?setup=abc`, { redirect: "manual" });
  check("The home page is the agent sales page; old password links go to the Studio", /Your listing photos, filmed/.test(home) && !home.includes("importBtn") && oldSetup.status === 302 && oldSetup.headers.get("location") === "/studio?setup=abc");

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
  check("Rate limit: the owner isn't stopped at a visitor's cap (live demos never stall)", last.status !== 429, (await last.json()).error);
}
sa.kill();

// ===== server B: production mode (no local fetching), no page service =====
const B = 18912; const sb = await startServer(B, {});
{
  await signIn(B);
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
  await signIn(C); mockCalls = [];
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
  const me = await (await api(Dp, "/api/me")).json();
  const r1 = await signIn(Dp, "agent@test.com", "a"); const j1 = await r1.json();
  const r2 = await signIn(Dp, "agent@test.com", "a", { invite: "beta-123" });
  check("Invite code: sign-up page knows a code is needed", me.inviteRequired === true && me.user === null);
  check("Invite code: refused without it, with a clear message", r1.status === 403 && /invite/.test(j1.error), j1.error);
  check("Invite code: works with it", r2.status === 200);
  // free tier: 2 link imports a month, then a clear upgrade message
  const i1 = await postAs(Dp, "a", "/api/import", { url: `http://127.0.0.1:${FX}/listing/889123` });
  const i2 = await postAs(Dp, "a", "/api/import", { url: `http://127.0.0.1:${FX}/listing/889123` });
  const i3 = await postAs(Dp, "a", "/api/import", { url: `http://127.0.0.1:${FX}/listing/889123` }); const j3 = await i3.json();
  check("Free plan: 2 imports a month, then points to done-for-you (no self-serve upsell)", i1.status === 200 && i2.status === 200 && i3.status === 402 && /have us make your video/.test(j3.error) && !/upgrade/i.test(j3.error), j3.error);
  const failed = await postAs(Dp, "a", "/api/import", { url: `http://127.0.0.1:${FX}/nophotos` });
  check("Free plan: blocked import isn't counted twice", failed.status === 402);
  // accounts
  const dup = await signIn(Dp, "agent@test.com", "b", { invite: "beta-123" });
  check("Accounts: duplicate email is refused", dup.status === 409);
  const bad = await api(Dp, "/api/account/login", { email: "agent@test.com", password: "wrong-password" }, { as: "c" });
  const good = await api(Dp, "/api/account/login", { email: "Agent@Test.com ", password: "correct-horse-1" }, { as: "c" });
  check("Accounts: wrong password refused, right one works (email not case-sensitive)", bad.status === 401 && good.status === 200);
  const meC = await (await api(Dp, "/api/me", undefined, { as: "c" })).json();
  check("Accounts: free plan shows 0 credits and a watermark", meC.user.tier === "free" && meC.user.credits === 0 && meC.user.watermark === true, JSON.stringify(meC.user));
  const cookie = good.headers.get("set-cookie") || "";
  check("Accounts: session cookie is HttpOnly and SameSite", /HttpOnly/.test(cookie) && /SameSite=Lax/.test(cookie));
  const form = await fetch(`http://127.0.0.1:${Dp}/api/account/logout`, { method: "POST", headers: { "content-type": "text/plain", cookie: jar[`${Dp}:c`] }, body: "{}" });
  check("Security: cross-site form posts are refused", form.status === 415);
  await api(Dp, "/api/account/logout", {}, { as: "c" });
  const after = await (await api(Dp, "/api/me", undefined, { as: "c" })).json();
  check("Accounts: sign out ends the session", after.user === null);
  const short = await api(Dp, "/api/account/signup", { email: "x@test.com", password: "short", invite: "beta-123" }, { as: "d" });
  check("Accounts: short passwords refused", short.status === 400);
}
sd.kill();

// ===== server E: AI on =====
const E = 18915; const se = await startServer(E, { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE: `http://127.0.0.1:${AIM}`, AI_PER_HOUR: "3" });
{
  await signIn(E);
  const h = await (await fetch(`http://127.0.0.1:${E}/api/health`)).json();
  check("AI: health reports AI is on", h.ai === true);
  const px = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const r = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: jar[`${E}:default`] }, body: JSON.stringify({ prompt: "Label these photos", tier: "quick", images: [px] }) });
  const j = await r.json(); const c = aiCalls.at(-1);
  check("AI: answers through your Anthropic key", r.status === 200 && /Sunny Living Room/.test(j.text) && c.key === "sk-test" && c.ver === "2023-06-01", j.text);
  check("AI: quick tasks use Haiku, photos are passed along", c.body.model === "claude-haiku-5-5" && c.body.messages[0].content[0].type === "image" && /Reel Listing Studio/.test(c.body.system), c.body.model);
  const bad = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: jar[`${E}:default`] }, body: JSON.stringify({ prompt: "x", images: ["data:text/html;base64,PGI+"] }) });
  check("AI: rejects non-image uploads", bad.status === 400, (await bad.json()).error);
  const lim = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: jar[`${E}:default`] }, body: JSON.stringify({ prompt: "x" }) });
  const lim2 = await fetch(`http://127.0.0.1:${E}/api/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: jar[`${E}:default`] }, body: JSON.stringify({ prompt: "x" }) });
  check("AI: the owner isn't stopped at a visitor's hourly cap", lim2.status !== 429, (await lim2.json()).error);
}
se.kill();
// AI off when no key
const F = 18916; const sf = await startServer(F, {});
{
  await signIn(F);
  const h = await (await fetch(`http://127.0.0.1:${F}/api/health`)).json();
  const r = await fetch(`http://127.0.0.1:${F}/api/ai`, { method: "POST", headers: { "content-type": "application/json", cookie: jar[`${F}:default`] }, body: JSON.stringify({ prompt: "x" }) });
  check("AI: off without a key, and says so", h.ai === false && r.status === 404);
}
sf.kill();

// ===== server G: AI motion clips + 3D depth files =====
const Gp = 18917; const sg = await startServer(Gp, { RESEND_API_KEY: "re_test", RESEND_BASE: `http://127.0.0.1:${RESM}`, LEAD_ALERT_FROM: "Reel Listing Studio <leads@reellistingstudio.com>", TRUST_PROXY: "1", CLIP_IMAGE_MODE: "url", FAL_KEY: "fal-test", FAL_QUEUE_BASE: `http://127.0.0.1:${FALM}`, CLIP_POLL_MS: "100", ALLOW_LOCAL_FETCH: "1", CLIPS_PER_HOUR: "3" });
{
  const h = await (await fetch(`http://127.0.0.1:${Gp}/api/health`)).json();
  check("Clips: health reports AI motion and 3D depth", h.clips === true && h.depth === true && /kling/.test(h.clipModel), JSON.stringify(h));
  const jpg = "data:image/jpeg;base64," + fs.readFileSync(path.join(FIX, "photo1.jpg")).toString("base64");
  await signIn(Gp); await signIn(Gp, "agent@test.com", "u");
  const none = await postAs(Gp, "u", "/api/clips", { image: jpg, kind: "int" });
  check("Credits: AI motion needs credits, with a clear message", none.status === 402 && /out of AI credits/.test((await none.json()).error));
  const g = await postAs(Gp, "default", "/api/account/admin", { email: "agent@test.com", credits: 2 });
  check("Credits: owner can grant credits", g.status === 200 && (await g.json()).user.credits === 2);
  const nonAdmin = await postAs(Gp, "u", "/api/account/admin", { email: "agent@test.com", credits: 500 });
  // partner accounts: owner creates them; partners set their own password from a one-time link
  await signIn(Gp, "existing@test.com", "ex");
  const pr = await postAs(Gp, "default", "/api/account/admin/partners", { tier: "agency", videos: 25, partners: [
    { name: "Gary Test", email: "Gary.Partner@Test.com", phone: "(704) 555-0100" }, { name: "Bad", email: "not-an-email" }, { name: "Existing", email: "existing@test.com" }] });
  const prj = await pr.json(); const gary = prj.results?.[0] || {}, tok = (gary.link || "").split("setup=")[1] || "";
  check("Partners: owner creates accounts with 25 videos (300 AI credits) and a setup link; bad emails are reported", pr.status === 200 && gary.ok && gary.created && gary.credits === 300 && gary.videos === 25
    && /\/studio\?setup=[0-9a-f]{48}$/.test(gary.link) && prj.results[1].ok === false && /valid email/.test(prj.results[1].error) && prj.results[2].ok && prj.results[2].created === false, JSON.stringify(prj).slice(0, 300));
  const prNo = await postAs(Gp, "u", "/api/account/admin/partners", { partners: [{ email: "x@test.com" }] });
  check("Partners: customers can't create partner accounts", prNo.status === 403);
  const noLogin = await api(Gp, "/api/account/login", { email: "gary.partner@test.com", password: "anything-at-all" }, { as: "gary" });
  const info = await (await api(Gp, `/api/account/setup?token=${tok}`, undefined, { as: "gary" })).json();
  check("Partners: nobody can sign in before the partner sets a password; the link shows who it's for", noLogin.status !== 200 && info.email === "gary.partner@test.com" && info.name === "Gary Test", JSON.stringify(info));
  const set = await api(Gp, "/api/account/setup", { token: tok, password: "gary-secret-99" }, { as: "gary" });
  const gme = (await (await api(Gp, "/api/me", undefined, { as: "gary" })).json()).user;
  check("Partners: setting a password signs them in on a VIP partner plan (Agency features), no watermark, 300 credits", set.status === 200 && gme?.tier === "agency" && gme.partner && gme.tierLabel === "VIP Partner" && gme.watermark === false && gme.credits === 300, JSON.stringify(gme));
  const again = await api(Gp, "/api/account/setup", { token: tok, password: "another-pass-1" }, { as: "gary2" });
  const relog = await api(Gp, "/api/account/login", { email: "gary.partner@test.com", password: "gary-secret-99" }, { as: "gary3" });
  check("Partners: the setup link works once; the chosen password signs in", again.status === 404 && relog.status === 200);
  // referral links + leads
  const gid = gme.refCode;
  check("Referrals: partners get a random link ID, never their name", /^[a-z2-9]{6}$/.test(gid || "") && !/gary/.test(gid), gid);
  const land = await fetch(`http://127.0.0.1:${Gp}/r/${gid}`); const landHtml = await land.text(); const rc = (land.headers.get("set-cookie") || "").split(";")[0];
  check("Referrals: /r/<code> shows the sales page with the partner's details and sets a 90-day cookie", land.status === 200 && /Your listing photos, filmed/.test(landHtml) && /"name":"Gary Test"/.test(landHtml) && rc === `rls_ref=${gid}` && /Max-Age=7776000/.test(land.headers.get("set-cookie")), rc);
  const unk = await fetch(`http://127.0.0.1:${Gp}/r/nobody-here`); const oh = await unk.text();
  check("Referrals: an unknown code still shows the page, without a partner", unk.status === 200 && /const REF=null/.test(oh) && !unk.headers.get("set-cookie"));
  const lead = await fetch(`http://127.0.0.1:${Gp}/api/leads`, { method: "POST", headers: { "content-type": "application/json", cookie: rc }, body: JSON.stringify({ name: "Agent Amy", email: "amy@realty.test", phone: "555-201-3344", listing: "https://zillow.test/1", package: "Signature ($399)" }) });
  const lj = await lead.json();
  check("Leads: a request from a referred agent is credited to the partner", lead.status === 200 && lj.partner?.name === "Gary Test", JSON.stringify(lj));
  await new Promise(r => setTimeout(r, 300));
  const toOwner = mails.find(m => m.body.to?.includes(ADMIN)), toPartner = mails.find(m => m.body.to?.includes("gary.partner@test.com"));
  check("Lead alerts: the owner and the referring partner each get an email, reply goes to the agent", mails.length === 2 && toOwner?.auth === "Bearer re_test" && /Agent Amy/.test(toOwner.body.subject)
    && /Gary Test/.test(toOwner.body.text) && toPartner && toOwner.body.reply_to === "amy@realty.test" && toOwner.body.from === "Reel Listing Studio <leads@reellistingstudio.com>", JSON.stringify(mails.map(m => m.body.to)));
  mails.length = 0;
  const fg = await api(Gp, "/api/account/forgot", { email: "gary.partner@test.com" }, { as: "anon-f" });
  const fgNone = await api(Gp, "/api/account/forgot", { email: "nobody-here@test.com" }, { as: "anon-f" });
  await new Promise(r => setTimeout(r, 300));
  const resetLink = (mails[0]?.body.text || "").match(/setup=([0-9a-f]{48})/)?.[1];
  const rs = resetLink && await api(Gp, "/api/account/setup", { token: resetLink, password: "brand-new-pass-1" }, { as: "gary-r" });
  const relogin = await api(Gp, "/api/account/login", { email: "gary.partner@test.com", password: "brand-new-pass-1" }, { as: "gary-r2" });
  check("Forgot password: emails a one-time reset link (same answer for unknown emails); the new password works", fg.status === 200 && fgNone.status === 200 && mails.length === 1
    && mails[0].body.to[0] === "gary.partner@test.com" && rs?.status === 200 && relogin.status === 200, JSON.stringify(mails.map(m => m.body.to)));
  await api(Gp, "/api/account/setup", { token: (await (async () => { mails.length = 0; await api(Gp, "/api/account/forgot", { email: "gary.partner@test.com" }, { as: "anon-f" }); await new Promise(r => setTimeout(r, 300)); return (mails[0]?.body.text || "").match(/setup=([0-9a-f]{48})/)?.[1]; })()), password: "gary-secret-99" }, { as: "gary-r3" });
  const wl = prj.results?.[0]?.welcome;
  check("Welcome email: built for each new partner with their password link, sign-in address and personal link", !!wl && /Welcome to Reel Listing Studio, Gary/.test(wl.subject) && wl.text.includes(gary.link) && /\/[a-z2-9]{6}\b/.test(wl.text) && /25 videos/.test(wl.text), wl?.subject);
  mails.length = 0;
  const ws = await postAs(Gp, "default", "/api/account/admin/welcome", { email: "gary.partner@test.com", ...wl });
  const wsNo = await postAs(Gp, "u", "/api/account/admin/welcome", { email: "x@test.com", subject: "x", text: "x" });
  await new Promise(r => setTimeout(r, 200));
  check("Welcome email: owner can send it with the Launch Plan PDF attached; customers can't", ws.status === 200 && wsNo.status === 403 && mails[0]?.body.attachments?.[0]?.filename === "Reel-Listing-Studio-Partner-Launch-Plan.pdf"
    && Buffer.from(mails[0].body.attachments[0].content, "base64").subarray(0, 4).toString() === "%PDF", JSON.stringify(mails[0]?.body.to));
  const gpdf = await api(Gp, "/api/partner/guide.pdf", undefined, { as: "gary3" });
  const upd = await api(Gp, "/api/partner/guide.pdf", undefined, { as: "u" });
  const anon = await fetch(`http://127.0.0.1:${Gp}/api/partner/guide.pdf`);
  check("Launch Plan: partners can open the PDF; customers and visitors can't", gpdf.status === 200 && gpdf.headers.get("content-type") === "application/pdf" && upd.status === 403 && anon.status === 401, `${gpdf.status} ${upd.status} ${anon.status}`);
  mails.length = 0;
  const meP = await (await api(Gp, "/api/me", undefined, { as: "gary3" })).json();
  const meO = await (await api(Gp, "/api/me")).json();
  mails.length = 0;
  const vr = await api(Gp, "/api/partner/reload", { videos: 50, note: "by Friday" }, { as: "gary3" });
  const vrNo = await api(Gp, "/api/partner/reload", { videos: 50 }, { as: "u" });
  await new Promise(r => setTimeout(r, 300));
  check("VIP Reload: partners don't get public plan prices; they can request a VIP Reload (owner emailed); customers can't", !meP.tiers && !meP.topup && !!meP.vip && !!meO.tiers
    && vr.status === 200 && vrNo.status === 403 && /VIP Reload request: Gary Test \(50 videos\)/.test(mails[0]?.body.subject || ""), mails[0]?.body.subject);
  mails.length = 0;
  const badLead = await fetch(`http://127.0.0.1:${Gp}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No Contact" }) });
  check("Leads: a request needs an email or phone", badLead.status === 400);
  const setc = await api(Gp, "/api/partner/link", { code: "gary" }, { as: "gary3" });
  const taken = await api(Gp, "/api/partner/link", { code: "agents" }, { as: "gary3" });
  const oldLink = await fetch(`http://127.0.0.1:${Gp}/r/${gid}`); const ol = await oldLink.text();
  check("Referrals: partners choose their own link; reserved names are refused; the old link still credits them", setc.status === 200 && (await setc.json()).code === "gary" && taken.status === 409 && /"code":"gary"/.test(ol));
  const ownerSet = await postAs(Gp, "default", "/api/account/admin/partner-link", { email: "gary.partner@test.com", code: "aimptr" });
  const notOwner = await postAs(Gp, "u", "/api/account/admin/partner-link", { email: "gary.partner@test.com", code: "zzz-top" });
  const short = await fetch(`http://127.0.0.1:${Gp}/aimptr`); const sh = await short.text();
  const notCode = await fetch(`http://127.0.0.1:${Gp}/no-such-code`);
  check("Referrals: the owner can set a partner's link; /aimptr opens their page with credit; unknown short paths stay 404", ownerSet.status === 200 && notOwner.status === 403
    && short.status === 200 && /"code":"aimptr"/.test(sh) && /rls_ref=aimptr/.test(short.headers.get("set-cookie") || "") && notCode.status === 404, `${ownerSet.status} ${short.status} ${notCode.status}`);
  await postAs(Gp, "default", "/api/account/admin/partner-link", { email: "gary.partner@test.com", code: "gary" });
  const lead2 = await fetch(`http://127.0.0.1:${Gp}/api/leads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent Bo", phone: "5552019999", ref: "gary" }) });
  const mine = await (await api(Gp, "/api/partner/leads", undefined, { as: "gary3" })).json();
  check("Leads: partners see their own requests", lead2.status === 200 && mine.leads?.length === 2 && mine.leads.some(l => l.email === "amy@realty.test"), JSON.stringify(mine).slice(0, 200));
  const notPartner = await api(Gp, "/api/partner/leads", undefined, { as: "u" });
  const all = await (await api(Gp, "/api/account/admin/leads")).json();
  check("Leads: customers can't see leads; the owner sees all with the partner's name", notPartner.status === 403 && all.leads?.filter(l => !/^VIP Reload/.test(l.name)).length === 2 && all.leads.filter(l => !/^VIP Reload/.test(l.name))[0].partner === "Gary Test");
  const ref2 = await fetch(`http://127.0.0.1:${Gp}/api/account/signup`, { method: "POST", headers: { "content-type": "application/json", cookie: "rls_ref=gary" }, body: JSON.stringify({ email: "newagent@test.com", password: "correct-horse-1" }) });
  const mine2 = await (await api(Gp, "/api/partner/leads", undefined, { as: "gary3" })).json();
  check("Referrals: an agent who signs up through the link is credited to the partner", ref2.status === 200 && mine2.signups?.some(x => x.email === "newagent@test.com"), JSON.stringify(mine2.signups));
  check("Credits: customers can't grant themselves credits", nonAdmin.status === 403);
  const r = await postAs(Gp, "u", "/api/clips", { image: jpg, kind: "int" });
  const { id, credits: left } = await r.json();
  check("Credits: each clip uses 1 credit", left === 1, left);
  let st; for (let k = 0; k < 40; k++) { await new Promise(r => setTimeout(r, 100)); st = await (await api(Gp, `/api/clips/${id}`, undefined, { as: "u" })).json(); if (st.status === "done" || st.status === "failed") break; }
  const c = falCalls[0] || {};
  check("Clips: sends the photo to the video model with your key", c.auth === "Key fal-test" && /kling-video/.test(c.path) && c.body.image_url.startsWith("data:image/jpeg") && /dolly/.test(c.body.prompt) && /people/.test(c.body.negative_prompt), c.path);
  check("Clips: a room with no fan or fire seen never gets one invented (only forbidden, never named in the prompt)", !/ceiling fan|fireplace|flames/i.test(c.body.prompt) && /ceiling fan, fan blades/.test(c.body.negative_prompt) && /fire, flames, fireplace/.test(c.body.negative_prompt) && /never change color/.test(c.body.prompt), c.body.prompt?.slice(0, 200));
  check("Clips: finishes and the video downloads", st.status === "done", JSON.stringify(st));
  falCalls.length = 0; await postAs(Gp, "default", "/api/clips", { image: jpg, kind: "int", move: "truck" });
  await new Promise(r => setTimeout(r, 200));
  check("Clips: the planned camera move goes to the model, never a zoom", /sideways/.test(falCalls[0]?.body.prompt || "") && !/dolly/.test(falCalls[0]?.body.prompt || "") && /zoom/.test(falCalls[0]?.body.negative_prompt || ""), falCalls[0]?.body.prompt);
  falCalls.length = 0; await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rtilt", live: ["ceiling_fan", "fireplace", "rocket"] }, { headers: {} });
  await new Promise(r => setTimeout(r, 200));
  const lp = falCalls[0]?.body.prompt || "";
  check("Clips: fans spin and fires flicker when the photo has them (unknown items ignored)", /fan blades turn/.test(lp) && /flames flicker/.test(lp) && /nothing new appears/.test(lp) && !/rocket/.test(lp) && !/(^|, )flicker,/.test(falCalls[0]?.body.negative_prompt || ""), lp.slice(-200));
  falCalls.length = 0;
  await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan", movers: "The two white ceiling fans on the ceiling spin steadily.<script>", model: "kling26" }, { headers: {} });
  await signIn(Gp, "viewer@test.com", "v"); await postAs(Gp, "default", "/api/account/admin", { email: "viewer@test.com", credits: 1 });
  await postAs(Gp, "v", "/api/clips", { image: jpg, kind: "int", move: "rpan", model: "kling26" });
  await new Promise(r => setTimeout(r, 250));
  const mp = falCalls[0]?.body.prompt || "";
  check("Clips: the photo's own 'what moves' sentence leads the prompt (cleaned), camera stays gentle", mp.startsWith("The two white ceiling fans on the ceiling spin steadily") && !/script|[<>]/.test(mp) && /moves only a little/.test(mp), mp.slice(0, 120));
  check("Clips: only the owner can switch models", /v2\.6\/pro/.test(falCalls[0]?.path || "") && falCalls[0]?.body.generate_audio === false && /v2\.5-turbo/.test(falCalls[1]?.path || ""), `${falCalls[0]?.path} | ${falCalls[1]?.path}`);
  falCalls.length = 0; await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan", retry: true }, { headers: {} });
  await new Promise(r => setTimeout(r, 200));
  check("Clips: a re-make asks for clearly visible movement", /camera keeps moving steadily from the first second/.test(falCalls[0]?.body.prompt || "") && !/fan blades|flames/.test(falCalls[0]?.body.prompt || ""));
  falCalls.length = 0;
  await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan", live: ["ceiling_fan"], movers: "The ceiling fan spins.", lockCam: true }, { headers: {} });
  await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan", live: ["ceiling_fan"], lockCam: true, retry: true }, { headers: {} });
  await new Promise(r => setTimeout(r, 250));
  const lk = falCalls[0]?.body || {}, lk2 = falCalls[1]?.body || {};
  check("Clips: fan shots lock the AI camera so it only animates the fan (our engine adds the pan)", /locked off on a tripod/.test(lk.prompt || "") && !/sideways/.test(lk.prompt || "") && /camera pan/.test(lk.negative_prompt || "") && /fan blades turn/.test(lk.prompt || ""), (lk.prompt || "").slice(0, 160));
  check("Clips: a locked-camera re-make insists the fan visibly spins, on a second model (Kling 2.6)", /the fan blades are clearly spinning/.test(lk2.prompt || "") && !/flames are clearly/.test(lk2.prompt || "") && !/camera keeps moving/.test(lk2.prompt || "") && /v2\.6\/pro/.test(falCalls[1]?.path || "") && /v2\.5-turbo/.test(falCalls[0]?.path || ""), `${falCalls[0]?.path} | ${falCalls[1]?.path}`);
  falCalls.length = 0;
  await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan", live: ["trees", "sky", "ceiling_fan"] }, { headers: {} });
  await api(Gp, "/api/clips", { image: jpg, kind: "ext", move: "rpan", live: ["trees", "sky", "pool"] }, { headers: {} });
  await new Promise(r => setTimeout(r, 250));
  const inP = falCalls[0]?.body || {}, exP = falCalls[1]?.body || {};
  check("Clips: trees and sky move outdoors, never in rooms", !/trees|Clouds/.test(inP.prompt || "") && /fan blades/.test(inP.prompt || "") && /hanging into view/.test(inP.negative_prompt || "")
    && /trees already in the scene sway/.test(exP.prompt || "") && /Clouds drift/.test(exP.prompt || "") && !/foliage/.test(exP.negative_prompt || ""), (inP.prompt || "").slice(0, 80));
  falCalls.length = 0; await api(Gp, "/api/clips", { image: jpg, kind: "int", move: "rpan" }, { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "reel.example.com" } });
  await new Promise(r => setTimeout(r, 200));
  const iu = falCalls[0]?.body.image_url || ""; const srcPath = iu.replace("https://reel.example.com", "");
  const src = await fetch(`http://127.0.0.1:${Gp}${srcPath}`);
  check("Clips: photo goes to fal as a short-lived web link that serves the JPG", /^https:\/\/reel\.example\.com\/api\/clip-src\/[0-9a-f]{48}\.jpg$/.test(iu) && src.status === 200 && src.headers.get("content-type") === "image/jpeg" && /pans slowly/.test(falCalls[0]?.body.prompt || ""), iu);
  const guess = await fetch(`http://127.0.0.1:${Gp}/api/clip-src/${"0".repeat(48)}.jpg`); check("Clips: unknown photo links return nothing", guess.status === 404);
  const other = await api(Gp, `/api/clips/${id}/video`);
  check("Clips: other accounts can't download your clip", other.status === 404);
  const v = await api(Gp, `/api/clips/${id}/video`, undefined, { as: "u" });
  check("Clips: video served as MP4", v.status === 200 && v.headers.get("content-type") === "video/mp4" && (await v.arrayBuffer()).byteLength === 50000);
  const bad = await postAs(Gp, "u", "/api/clips", { image: "data:text/html;base64,PGI+" });
  const afterBad = (await (await api(Gp, "/api/me", undefined, { as: "u" })).json()).user.credits;
  check("Clips: rejects non-photos and gives the credit back", bad.status === 400 && afterBad === 1, `${bad.status} credits=${afterBad}`);
  const f = await postAs(Gp, "u", "/api/clips", { image: "data:image/jpeg;base64,ZmFpbC1tZQ==" });
  const fid = (await f.json()).id; let fs2; for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); fs2 = await (await api(Gp, `/api/clips/${fid}`, undefined, { as: "u" })).json(); if (fs2.status === "failed") break; }
  const afterFail = (await (await api(Gp, "/api/me", undefined, { as: "u" })).json()).user.credits;
  check("Clips: a failed clip explains itself and refunds the credit", fs2.status === "failed" && /still/.test(fs2.error) && afterFail === 1, `${fs2.error} credits=${afterFail}`);
  const ob = await api(Gp, "/api/clips", { image: "data:image/jpeg;base64,YnJva2U=" }, { headers: {} });
  const obid = (await ob.json()).id; let obs; for (let k = 0; k < 20; k++) { await new Promise(r => setTimeout(r, 100)); obs = await (await api(Gp, `/api/clips/${obid}`)).json(); if (obs.status === "failed") break; }
  check("Clips: an empty fal balance says 'add funds', not 'make a new key'", obs.status === "failed" && /out of money/.test(obs.error) && /no new key needed/.test(obs.error), obs.error);
  const lim = await postAs(Gp, "u", "/api/clips", { image: jpg });
  check("Clips: hourly limit per account", lim.status === 429, (await lim.json()).error);
  const gone = await api(Gp, `/api/clips/00000000-0000-0000-0000-000000000000`, undefined, { as: "u" });
  check("Clips: unknown clip says it expired", gone.status === 404);
  const m = await fetch(`http://127.0.0.1:${Gp}/models/depth_q8.onnx`, { method: "HEAD" }).catch(() => null);
  const m2 = await fetch(`http://127.0.0.1:${Gp}/models/depth_q8.onnx`);
  check("Depth model served with caching", m2.status === 200 && /immutable/.test(m2.headers.get("cache-control")) && +m2.headers.get("content-length") > 20e6); await m2.body?.cancel();
  const w = await fetch(`http://127.0.0.1:${Gp}/vendor/ort-wasm-simd-threaded.wasm`); check("Depth engine served as WebAssembly", w.status === 200 && w.headers.get("content-type") === "application/wasm"); await w.body?.cancel();
  const trav = await fetch(`http://127.0.0.1:${Gp}/vendor/..%2F..%2Fserver.js`); check("Static files can't escape their folder", trav.status === 404);
}
sg.kill();
const Hp = 18918; const sh = await startServer(Hp, {});
{ await signIn(Hp); const h = await (await fetch(`http://127.0.0.1:${Hp}/api/health`)).json(); const r = await api(Hp, "/api/clips", {});
  check("Clips: off without a fal.ai key, and says so", h.clips === false && r.status === 404); }
sh.kill();

// ===== server P: PayPal billing against a fake PayPal =====
const PPM = 18905; const pp = { plans: {}, subs: {}, orders: {}, cancelled: [], products: 0, webhooks: 0, captures: 0 };
const ppmock = http.createServer(async (req, res) => {
  let b = ""; for await (const c of req) b += c; const j = b && req.headers["content-type"] === "application/json" ? JSON.parse(b) : {};
  const send = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const u = req.url;
  if (u === "/v1/oauth2/token") return req.headers.authorization === "Basic " + Buffer.from("cid:secret").toString("base64") ? send({ access_token: "tok", expires_in: 3600 }) : send({}, 401);
  if (req.headers.authorization !== "Bearer tok") return send({}, 401);
  if (u === "/v1/catalogs/products") { pp.products++; return send({ id: "PROD-1" }); }
  if (u === "/v1/billing/plans") { const tier = j.name.split(" ").pop().toLowerCase(); pp.plans[tier] = { id: "P-" + tier.toUpperCase(), price: j.billing_cycles[0].pricing_scheme.fixed_price.value }; return send({ id: pp.plans[tier].id }); }
  if (u === "/v1/notifications/webhooks") { pp.webhooks++; pp.webhookUrl = j.url; return send({ id: "WH-1" }); }
  if (u === "/v1/notifications/verify-webhook-signature") return send({ verification_status: j.transmission_sig === "good" && j.webhook_id === "WH-1" ? "SUCCESS" : "FAILURE" });
  let m;
  if ((m = u.match(/^\/v1\/billing\/subscriptions\/([\w-]+)\/cancel$/))) { pp.cancelled.push(m[1]); res.writeHead(204); return res.end(); }
  if ((m = u.match(/^\/v1\/billing\/subscriptions\/([\w-]+)$/))) { const s = pp.subs[m[1]]; return s ? send({ id: m[1], ...s, billing_info: { next_billing_time: "2030-01-01T00:00:00Z" } }) : send({}, 404); }
  if (u === "/v2/checkout/orders") { const id = "ORDER" + (100000 + Object.keys(pp.orders).length); pp.orders[id] = { pu: j.purchase_units[0], captured: false }; return send({ id }); }
  if ((m = u.match(/^\/v2\/checkout\/orders\/(\w+)(\/capture)?$/))) {
    const o = pp.orders[m[1]]; if (!o) return send({}, 404);
    if (m[2]) { if (o.captured) return send({ name: "UNPROCESSABLE_ENTITY" }, 422); o.captured = true; pp.captures++; }
    return send({ id: m[1], status: o.captured ? "COMPLETED" : "APPROVED", purchase_units: [{ custom_id: o.pu.custom_id, payments: { captures: o.captured ? [{ status: "COMPLETED", amount: o.amount || o.pu.amount }] : [] } }] });
  }
  send({}, 404);
});
await new Promise(r => ppmock.listen(PPM, "127.0.0.1", r));
const Pp = 18919;
const ppEnv = { PAYPAL_CLIENT_ID: "cid", PAYPAL_CLIENT_SECRET: "secret", PAYPAL_API_BASE: `http://127.0.0.1:${PPM}`, PUBLIC_URL: "https://reel.test", FAL_KEY: "fal-test", FAL_QUEUE_BASE: `http://127.0.0.1:${FALM}`, CLIP_POLL_MS: "100" };
let sp = await startServer(Pp, ppEnv, { keep: true });
{
  await new Promise(r => setTimeout(r, 300));
  const me0 = await (await api(Pp, "/api/me")).json();
  check("PayPal: creates the product, 3 plans and the webhook by itself", pp.products === 1 && Object.keys(pp.plans).sort().join() === "agency,pro,starter" && pp.plans.pro.price === "79.00" && pp.webhookUrl === "https://reel.test/api/paypal/webhook", JSON.stringify(pp.plans));
  check("Customers never receive self-serve plan prices or PayPal plan IDs (and never the secret)", !me0.paypal && !me0.tiers && !me0.topup && !JSON.stringify(me0).includes("secret"));
  await signIn(Pp, "agent@test.com", "u");          // user id 1
  await signIn(Pp, "other@test.com", "o");          // user id 2
  pp.subs["I-STARTER0001"] = { status: "ACTIVE", custom_id: "1", plan_id: "P-STARTER" };
  pp.subs["I-OTHERUSER01"] = { status: "ACTIVE", custom_id: "2", plan_id: "P-PRO" };
  const steal = await postAs(Pp, "u", "/api/account/subscribe", { subscriptionID: "I-OTHERUSER01" });
  check("PayPal: can't claim someone else's subscription", steal.status === 403);
  const s1 = await (await postAs(Pp, "u", "/api/account/subscribe", { subscriptionID: "I-STARTER0001" })).json();
  check("PayPal: Starter subscription gives 25 credits, no watermark", s1.user?.tier === "starter" && s1.user.credits === 25 && s1.user.watermark === false, JSON.stringify(s1));
  const again = await (await postAs(Pp, "u", "/api/account/subscribe", { subscriptionID: "I-STARTER0001" })).json();
  check("PayPal: confirming twice doesn't double the credits", again.user.credits === 25);
  const jpg = "data:image/jpeg;base64," + fs.readFileSync(path.join(FIX, "photo1.jpg")).toString("base64");
  await postAs(Pp, "u", "/api/clips", { image: jpg }); await postAs(Pp, "u", "/api/clips", { image: jpg });
  // top-up
  const o = await (await postAs(Pp, "u", "/api/account/topup", {})).json();
  check("PayPal: top-up order is for $25.00 and tied to the account", pp.orders[o.id]?.pu.amount.value === "25.00" && pp.orders[o.id].pu.custom_id === "1");
  const t1 = await (await postAs(Pp, "u", "/api/account/topup/capture", { orderID: o.id })).json();
  const t2 = await (await postAs(Pp, "u", "/api/account/topup/capture", { orderID: o.id })).json();
  check("PayPal: top-up adds 20 credits once (repeat confirm is ignored)", t1.user?.extra === 20 && t1.user.monthly === 23 && t2.user?.extra === 20, `${JSON.stringify(t1.user)} ${JSON.stringify(t2)}`);
  const o2 = await (await postAs(Pp, "o", "/api/account/topup", {})).json(); pp.orders[o2.id].captured = true; pp.orders[o2.id].amount = { value: "1.00", currency_code: "USD" };
  const cheap = await postAs(Pp, "o", "/api/account/topup/capture", { orderID: o2.id });
  check("PayPal: a payment for the wrong amount adds nothing", cheap.status === 400);
  const steal2 = await postAs(Pp, "o", "/api/account/topup/capture", { orderID: o.id });
  check("PayPal: can't claim someone else's top-up", steal2.status === 403);
  // monthly renewal through the webhook resets the monthly credits, keeps top-ups
  const hook = (event, sig = "good") => fetch(`http://127.0.0.1:${Pp}/api/paypal/webhook`, { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": sig, "paypal-transmission-id": "t", "paypal-transmission-time": "t", "paypal-cert-url": "https://api.paypal.com/cert", "paypal-auth-algo": "SHA256withRSA" }, body: JSON.stringify(event) });
  const forged = await hook({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-1", billing_agreement_id: "I-STARTER0001" } }, "forged");
  check("PayPal: forged webhooks are rejected", forged.status === 400);
  const rn = await hook({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-2", billing_agreement_id: "I-STARTER0001" } });
  await hook({ event_type: "PAYMENT.SALE.COMPLETED", resource: { id: "SALE-2", billing_agreement_id: "I-STARTER0001" } });
  const meR = (await (await api(Pp, "/api/me", undefined, { as: "u" })).json()).user;
  check("PayPal: monthly renewal refills to 25 and keeps the 20 top-up credits", rn.status === 200 && meR.monthly === 25 && meR.extra === 20, JSON.stringify(meR));
  // upgrade: new plan, old subscription cancelled
  pp.subs["I-PROPLAN0001"] = { status: "ACTIVE", custom_id: "1", plan_id: "P-PRO" };
  const up = await (await postAs(Pp, "u", "/api/account/subscribe", { subscriptionID: "I-PROPLAN0001" })).json();
  check("PayPal: upgrading to Pro gives 70 credits and stops billing the old plan", up.user?.tier === "pro" && up.user.monthly === 70 && pp.cancelled.includes("I-STARTER0001"), JSON.stringify(up.user));
  // cancel keeps the plan until the paid month ends
  const c = await (await postAs(Pp, "u", "/api/account/cancel", {})).json();
  check("PayPal: cancelling keeps the plan until the paid month ends", c.user?.tier === "pro" && c.user.subStatus === "CANCELLED" && c.user.endsAt > Date.now() && pp.cancelled.includes("I-PROPLAN0001"));
  await hook({ event_type: "BILLING.SUBSCRIPTION.EXPIRED", resource: { id: "I-PROPLAN0001" } });
  const meE = (await (await api(Pp, "/api/me", undefined, { as: "u" })).json()).user;
  check("PayPal: when the plan ends you drop to Free but keep top-up credits", meE.tier === "free" && meE.monthly === 0 && meE.extra === 20, JSON.stringify(meE));
}
sp.kill();
// restart: accounts and PayPal setup are remembered (same database file)
sp = await startServer(Pp, ppEnv, { keep: true });
{
  await new Promise(r => setTimeout(r, 300));
  const relog = await api(Pp, "/api/account/login", { email: "agent@test.com", password: "correct-horse-1" }, { as: "r" });
  const me = (await (await api(Pp, "/api/me", undefined, { as: "r" })).json()).user;
  check("Accounts survive a restart; PayPal plans aren't created twice", relog.status === 200 && me.extra === 20 && pp.products === 1 && pp.webhooks === 1, `${relog.status} products=${pp.products}`);
}
sp.kill(); ppmock.close();

fixture.close(); mock.close(); aimock.close(); falmock.close();
console.log(results.join("\n"));
console.log(`\n${results.filter(r => r.startsWith("PASS")).length}/${results.length} passed`);
resmock.close(); process.exit(results.some(r => r.startsWith("FAIL")) ? 1 : 0);
