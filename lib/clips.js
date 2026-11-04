// AI motion clips: turns a listing photo into a few seconds of real moving footage
// through an image-to-video model on fal.ai. Jobs run in the background; the Studio polls.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plainFetch, httpError, fetchToFile } from "./safe-fetch.js";

const MODEL = process.env.FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
const QUEUE = process.env.FAL_QUEUE_BASE || "https://queue.fal.run";
const DURATION = process.env.CLIP_SECONDS || "5";

export const clipsEnabled = () => !!process.env.FAL_KEY;
// owner-only comparison: other image-to-video models on fal (newer Kling versions follow object-motion instructions better)
const ALT_MODELS = { kling26: "fal-ai/kling-video/v2.6/pro/image-to-video", kling3: "fal-ai/kling-video/v3/pro/image-to-video" };
// Premium motion: Higgsfield's API (Kling 3.0). Needs HIGGSFIELD_KEY in Render as "KEY_ID:KEY_SECRET"
// (or HIGGSFIELD_KEY = the ID and HIGGSFIELD_SECRET = the secret).
const HF_BASE = process.env.HIGGSFIELD_BASE || "https://api.higgsfield.ai";
const HF_MODELS = { hf3: process.env.HIGGSFIELD_MODEL || "kling-video/v3.0/std/image-to-video" };
const unq = v => String(v || "").trim().replace(/^["']|["']$/g, "").replace(/^(Key|Bearer)\s+/i, "").replace(/\s+/g, "");
const hfKey = () => { const k = unq(process.env.HIGGSFIELD_KEY), sec = unq(process.env.HIGGSFIELD_SECRET); return sec && !k.includes(":") ? `${k}:${sec}` : k; };
export const premiumEnabled = () => !!unq(process.env.HIGGSFIELD_KEY);
const cleanMovers = x => typeof x === "string" ? x.replace(/<[^>]*>?/g, " ").replace(/[^\p{L}\p{N}\s,.'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 160) : "";

// The Studio only says what kind of shot it is; the wording sent to the model is decided here.
const PROMPTS = {
  ext: "Smooth, slow cinematic camera glide toward the home, like a stabilized drone or gimbal shot. Architecture stays perfectly straight and stable. Gentle natural light, subtle movement in trees and sky. Real estate listing video.",
  int: "Smooth, slow forward dolly through the room on a steady gimbal, like a professional real estate walkthrough. Walls and vertical lines stay perfectly straight. Furniture, windows and decor stay exactly as they are. Bright, natural light.",
  detail: "Slow, gentle push-in toward the detail on a steady gimbal with soft natural light. Everything stays exactly as it is. Real estate listing video.",
};
// the camera move the Studio planned for this shot (a real operator varies them; always pushing in looks fake)
const MOVES = {
  truck: "The camera glides smoothly sideways at a steady walking pace, like a stabilized gimbal trucking shot. No zoom.",
  arc: "The camera moves in a slow, smooth arc around the room at a steady pace, like a gimbal orbit. No zoom.",
  tilt: "The camera rises slowly and smoothly at a steady pace, like a gimbal pedestal shot. No zoom.",
  glide: "The camera walks slowly forward into the space at a steady pace on a gimbal, with natural parallax. No zoom.",
  macro: "The camera glides slowly sideways past the details at a steady pace, close and shallow. No zoom.",
  rpan: "The camera stays in place and pans slowly and smoothly across the room on a tripod head, at a steady pace. No zoom, no forward movement.",
  rtilt: "The camera stays in place and tilts slowly upward toward the ceiling on a tripod head, at a steady pace. No zoom, no forward movement.",
  rdiag: "The camera stays in place and slowly pans and tilts up across the room on a tripod head, at a steady pace. No zoom, no forward movement.",
};
// Photos are handed to fal as a short-lived web link served by this server (more reliable than inline data)
const sources = new Map();   // token -> { buf, type, exp }
export function clipSource(token) {
  const e = sources.get(token); if (!e || e.exp < Date.now()) throw httpError(404, "Not found."); return e;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of sources) if (e.exp < now) sources.delete(k); }, 300e3).unref();
// fal explains failures in "detail" (a string or a list of {msg}); pass the gist on
const falWhy = j => { const d = j && (j.detail ?? j.error ?? j.message); if (!d) return "";
  const t = Array.isArray(d) ? d.map(x => x.msg || x.message || JSON.stringify(x)).join("; ") : typeof d === "string" ? d : JSON.stringify(d);
  return t.replace(/\s+/g, " ").slice(0, 160); };
// things the photo already shows that move in real life; only these come alive, nothing new is added
const LIVE = {
  ceiling_fan: "The ceiling fan blades turn slowly and steadily.",
  fireplace: "Warm flames flicker gently in the fireplace, casting a soft glow.",
  pool: "The pool water ripples gently and sparkles in the light.",
  water: "The water in the distance shimmers softly.",
  hot_tub: "The hot tub water bubbles and steams gently.",
  curtains: "The curtains move very slightly in a soft breeze.",
  trees: "The trees already in the scene sway gently in a light breeze, staying in their places.",
  sky: "Clouds drift slowly across the sky.",
};
// outdoors trees and sky may move; indoors they're never mentioned (the model invents branches in the room)
const OUTDOOR_ONLY = new Set(["trees", "sky", "water"]);
const NEGATIVE_INDOOR = ", water on the counter, wet countertop, puddles, wet floor, spilled water, tree branches, leaves, foliage, vines or plants hanging into view, running water, water stream, water pouring, liquid flowing, dripping, leak, faucet turning on";
const NEGATIVE = "zoom, zooming in, zooming out, people, person, pets, text, watermark, logo, warping, morphing, melting furniture, bending walls, distortion, frame flicker, strobing, blur, low quality, new objects, new plants, new trees, branches hanging into the frame from the edges, objects entering the frame, changing the room";

const jobs = new Map();       // id -> { status, error, video, createdAt, owner }
const JOB_TTL = 3600e3;
// Finished clips go to a temp file, not memory, so a busy workshop can't run the server out of RAM.
// Each file is removed 10 minutes after it's been downloaded, or after an hour either way.
const CLIP_DIR = process.env.CLIP_DIR || path.join(os.tmpdir(), "rls-clips");
try { fs.mkdirSync(CLIP_DIR, { recursive: true }); } catch {}
let active = 0; const waiting = [];
const slot = () => active < 6 ? (active++, Promise.resolve()) : new Promise(r => waiting.push(r));
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
const dropJob = (k, j) => { if (j.file) fs.rm(j.file, { force: true }, () => {}); jobs.delete(k); };
setInterval(() => { const now = Date.now(); for (const [k, j] of jobs) if (now - j.createdAt > JOB_TTL || (j.servedAt && now - j.servedAt > 10 * 60e3)) dropJob(k, j); }, 60e3).unref();

// tolerate copy-paste extras around the key (spaces, quotes, line breaks, a leading "Key ")
const falKey = () => String(process.env.FAL_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/^Key\s+/i, "").trim();
const falHeaders = () => ({ authorization: `Key ${falKey()}`, "content-type": "application/json" });
const okFalUrl = u => { try { const x = new URL(u); return x.protocol === "https:" || (process.env.ALLOW_LOCAL_FETCH === "1" && x.protocol === "http:"); } catch { return false; } };

export function startClip({ image, kind = "int", move, live, retry, movers, model, lockCam }, owner, { onFail, publicBase, admin } = {}) {
  const hf = admin && HF_MODELS[model] ? HF_MODELS[model] : null;
  const useModel = admin && ALT_MODELS[model] ? ALT_MODELS[model] : retry && lockCam ? ALT_MODELS.kling26 : MODEL;
  if (hf && !premiumEnabled()) throw httpError(400, "Premium motion isn't set up yet: add HIGGSFIELD_KEY in Render, Environment.");
  if (!clipsEnabled()) throw httpError(404, "AI motion isn't set up on this server.");
  const m = String(image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError(400, "Send the photo as a JPG, PNG or WebP.");
  if (m[2].length > 4_000_000) throw httpError(413, "That photo is too large to animate. It should be under 3 MB.");
  const id = crypto.randomUUID();
  let imageUrl = image;
  // default: send the photo inside the request (fal accepts data URIs); CLIP_IMAGE_MODE=url serves it as a link instead
  if (process.env.CLIP_IMAGE_MODE === "url" && publicBase && /^https:\/\//.test(publicBase)) {
    const token = crypto.randomBytes(24).toString("hex");
    sources.set(token, { buf: Buffer.from(m[2], "base64"), type: `image/${m[1]}`, exp: Date.now() + 30 * 60e3 });
    imageUrl = `${publicBase.replace(/\/$/, "")}/api/clip-src/${token}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  }
  const job = { status: "queued", createdAt: Date.now(), owner };
  jobs.set(id, job);
  const outdoor = kind === "ext";
  const alive = Array.isArray(live) ? [...new Set(live.filter(k => LIVE[k] && (outdoor || !OUTDOOR_ONLY.has(k))))].slice(0, 4) : [];
  const safeMovers = cleanMovers(movers).split(/(?<=\.)\s*/).filter(x => !/faucet|tap\b|sink|running water|pour|drip|stream/i.test(x)).join(" ").trim();
  let link = null;
  if (hf && publicBase && /^https:\/\//.test(publicBase)) {
    const token = crypto.randomBytes(24).toString("hex");
    sources.set(token, { buf: Buffer.from(m[2], "base64"), type: `image/${m[1]}`, exp: Date.now() + 30 * 60e3 });
    link = `${publicBase.replace(/\/$/, "")}/api/clip-src/${token}.${m[1] === "jpeg" ? "jpg" : m[1]}`;
  }
  const photo = hf ? { type: `image/${m[1]}`, b64: m[2], link } : null;
  run(job, imageUrl, PROMPTS[kind] ? kind : "int", MOVES[move] ? move : null, alive, outdoor, !!retry, safeMovers, useModel, !!lockCam, hf, photo).catch(e => { job.status = "failed"; try { onFail && onFail(id); } catch {} job.error = e.message === "OUT_OF_HF_BALANCE"
      ? (admin ? "The Higgsfield API balance is empty. Top it up in the Higgsfield console (API balance, not website credits), then press Re-make." : "AI motion is paused for a moment on our side. Your credits were not used; please try again later.")
      : e.message === "OUT_OF_FAL_BALANCE"
      ? (admin ? "The fal.ai account is out of money. Add funds at fal.ai/dashboard/billing (your key is fine, no new key needed), then press Re-make." : "AI motion is paused for a moment on our side. Your credits were not used; please try again later.")
      : e.status ? e.message : "The AI video service had a problem. The photo will stay as a still shot."; if (!e.status) console.error("clip failed", e); });
  return id;
}

async function run(job, image, kind, move, alive = [], outdoor = false, retry = false, movers = "", model = MODEL, lockCam = false, hf = null, photo = null) {
  // What moves in THIS photo goes first: video models follow the start of the prompt most closely.
  const spinning = alive.some(k => ["ceiling_fan", "fireplace", "faucet"].includes(k)) || /fan|flame|fire|faucet|water|pool|tub/i.test(movers);
  const lead = movers ? `${movers.replace(/\.?$/, ".")} This motion is clearly visible the entire time. ` : alive.includes("ceiling_fan") ? "The ceiling fan blades spin steadily and visibly the entire time. " : "";
  // when something in the room moves, keep the camera gentle so that motion is easy to see
  const cam = move ? (spinning ? MOVES[move].replace(/slowly|steady walking pace|steady pace/, "very slowly") + " The camera moves only a little." : MOVES[move]) : "";
  // locked camera: the AI's only job is the moving things; the Studio adds the camera move itself
  const LOCKED = "The camera is locked off on a tripod and does not move at all: no pan, no zoom, no dolly. Only the moving things in the room move.";
  const base = lockCam ? `${LOCKED} ${PROMPTS[kind].replace(/^[^.]*\.\s*/, "")}` : move ? `${cam} ${PROMPTS[kind].replace(/^[^.]*\.\s*/, "")}` : PROMPTS[kind];
  // when we know what's in the photo, name it; otherwise ask for natural movement of whatever is there
  // name what we spotted, and always cover the usual movers too (the photo check can miss a small fan or faucet)
  // only what was actually seen in this photo is named; nothing else may be added (naming "any fan / any fireplace" made the model invent them)
  const has = k => alive.includes(k) || (k === "ceiling_fan" ? /\bfans?\b/i.test(movers) : k === "fireplace" ? /fire|flame/i.test(movers) : false);
  const backup = outdoor ? "" : "No water runs or pours anywhere; countertops, sinks and floors stay completely dry.";
  const COLORS = "Every color stays exactly as in the photo: walls, fabrics, sofas, bedding and furniture never change color, and no object appears, disappears or changes shape.";
  const lively = (alive.length ? alive.map(k => LIVE[k]).join(" ") + " " + backup
    : outdoor ? "Only things that already exist in the photo move: leaves stir gently in place and clouds drift slowly."
    : "The room itself stays still; only the light shifts very subtly. " + backup) + " " + COLORS;   // not-seen things go only in the "avoid" list: naming them in the prompt can make the model draw them
  // a re-make after a clip came back nearly frozen: ask for clearly visible movement
  const real = [has("ceiling_fan") && "the fan blades are clearly spinning", has("fireplace") && "the flames are clearly flickering", (alive.includes("pool") || alive.includes("water") || alive.includes("hot_tub")) && "the water is clearly rippling"].filter(Boolean);
  const stronger = !retry ? "" : real.length ? ` From the first second to the last, ${real.join(" and ")}.` : lockCam ? "" : " The camera keeps moving steadily from the first second to the last.";
  const prompt = `${lead}${base} ${lively}${stronger} Only things already in the photo move; nothing new appears.`;
  const notSeen = outdoor ? "" : (has("ceiling_fan") ? "" : ", ceiling fan, fan blades, spinning fan") + (has("fireplace") ? "" : ", fire, flames, fireplace, burning, candle flames");
  const payload = { prompt, image_url: image, duration: DURATION, negative_prompt: (outdoor ? NEGATIVE : NEGATIVE + NEGATIVE_INDOOR) + notSeen + ", color change, changing colors, recolored furniture, objects appearing" + (lockCam ? ", camera movement, camera pan, camera shake" : ""), cfg_scale: lockCam ? 0.7 : 0.6 };
  if (model !== MODEL) payload.generate_audio = false;            // newer Kling versions can add sound; we don't use it
  if (hf) return runHiggsfield(job, hf, photo, payload);
  const sub = await plainFetch(`${QUEUE}/${model}`, { method: "POST", headers: falHeaders(), timeout: 60000, body: JSON.stringify(payload) });
  image = null; payload.image_url = null;   // the photo is no longer needed in memory while the clip renders
  const s = JSON.parse(sub.buf.toString("utf8") || "{}");
  // out of money shows up as a "locked" key on fal: say so plainly, a new key won't help
  if (sub.status === 402 || /balance|exhausted|billing|credit/i.test((s.detail || "") + " " + (falWhy(s) || ""))) {
    console.error("fal out of balance", sub.status, sub.buf.toString("utf8").slice(0, 300));
    throw httpError(502, "OUT_OF_FAL_BALANCE");
  }
  if (sub.status === 401 || sub.status === 403) {
    const k = falKey(); console.error("fal rejected key", sub.status, sub.buf.toString("utf8").slice(0, 300));
    throw httpError(502, !k.includes(":") ? "fal.ai rejected the key: FAL_KEY looks incomplete. A fal key has two parts joined by a colon (id:secret); paste the whole thing into Render."
      : `fal.ai rejected the key (${falWhy(s) || "code " + sub.status}). Make a new key on fal.ai and paste the whole thing into FAL_KEY in Render.`);
  }
  if (sub.status === 402 || /balance|credit/i.test(s.detail || "")) throw httpError(502, "The AI video account is out of credit. Add credit at fal.ai, then try again.");
  if (sub.status >= 400 || !s.request_id) { console.error("fal submit", sub.status, sub.buf.toString("utf8").slice(0, 500));
    throw httpError(502, `The AI video service couldn't take that photo${falWhy(s) ? ` (${falWhy(s)})` : ""}. It will stay as a still shot.`); }
  const statusUrl = s.status_url || `${QUEUE}/${model}/requests/${s.request_id}/status`;
  const resultUrl = s.response_url || `${QUEUE}/${model}/requests/${s.request_id}`;
  job.status = "working";
  const deadline = Date.now() + 10 * 60e3;
  for (;;) {
    if (Date.now() > deadline) throw httpError(504, "The AI clip took too long. The photo will stay as a still shot.");
    await new Promise(r => setTimeout(r, +process.env.CLIP_POLL_MS || 4000));
    const st = await plainFetch(statusUrl, { headers: falHeaders(), timeout: 30000 });
    const sj = JSON.parse(st.buf.toString("utf8") || "{}");
    if (sj.status === "COMPLETED") { if (sj.error) { console.error("fal finished with error", JSON.stringify(sj).slice(0, 500)); throw httpError(502, `The AI video service couldn't make that clip (${falWhy(sj)}). It will stay as a still shot.`); } break; }
    if (sj.status && !["IN_QUEUE", "IN_PROGRESS"].includes(sj.status)) throw httpError(502, "The AI video service couldn't finish that clip. The photo will stay as a still shot.");
    if (typeof sj.queue_position === "number") job.position = sj.queue_position;
  }
  let res = await plainFetch(resultUrl, { headers: falHeaders(), timeout: 60000 });
  let rj = {}; try { rj = JSON.parse(res.buf.toString("utf8") || "{}"); } catch {}
  if ((res.status === 404 || res.status === 405) && resultUrl !== `${QUEUE}/${model}/requests/${s.request_id}`) {   // fall back to the model's own path
    res = await plainFetch(`${QUEUE}/${model}/requests/${s.request_id}`, { headers: falHeaders(), timeout: 60000 });
    try { rj = JSON.parse(res.buf.toString("utf8") || "{}"); } catch { rj = {}; }
  }
  const url = rj?.video?.url || rj?.data?.video?.url;
  if (res.status >= 400 || !url || !okFalUrl(url)) {
    console.error("fal result", res.status, res.buf.toString("utf8").slice(0, 500));
    const why = falWhy(rj);
    throw httpError(502, why ? `The AI video service didn't return a clip: ${why}. The photo will stay as a still shot.` : `The AI video service didn't return a clip (code ${res.status}). The photo will stay as a still shot.`);
  }
  // a few downloads at a time, streamed to disk: a room full of finished clips can't run the server out of memory
  await slot();
  const file = path.join(CLIP_DIR, `${crypto.randomUUID()}.mp4`);
  let vid; try { vid = await fetchToFile(url, file, { timeout: 120000, maxBytes: 80e6 }); } finally { release(); }
  if (vid.status >= 400 || vid.size < 10000) { fs.rm(file, { force: true }, () => {}); throw httpError(502, "Couldn't download the finished AI clip. The photo will stay as a still shot."); }
  job.file = file; job.size = vid.size; job.status = "done";
}

// Higgsfield: upload the photo, submit, poll, then download like any other clip
// Higgsfield's docs use "Key ID:SECRET"; newer consoles hand out a single key, so try the other common forms once and remember what works
let hfScheme = 0, hfKnown = false;    // hfKnown: a form has actually worked, so stick with it
const HF_AUTH = [k => `Key ${k}`, k => `Bearer ${k}`, k => `Basic ${Buffer.from(k).toString("base64")}`];
const hfHeaders = () => ({ authorization: HF_AUTH[hfScheme](hfKey()), "content-type": "application/json", accept: "application/json", "user-agent": "ReelListingStudio/1.0 (+https://www.reellistingstudio.com)" });
const hfWhy = j => { const d = j && (j.error ?? j.detail ?? j.message ?? j._raw); if (!d) return ""; return (typeof d === "string" ? d : JSON.stringify(d)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160); };
const hfJson = r => { const t = r.buf.toString("utf8"); try { return JSON.parse(t || "{}"); } catch { return { _raw: /cloudflare|attention required|access denied/i.test(t) ? "blocked by Higgsfield's firewall" : t.slice(0, 300) }; } };
function hfFail(r, j, what) {
  console.error("higgsfield", what, r.status, r.buf.toString("utf8").slice(0, 400));
  if (r.status === 403) return httpError(502, `Higgsfield recognised the key but refused the request${hfWhy(j) ? ` (${hfWhy(j)})` : ""}. This usually means the API balance is empty or the account isn't fully set up: in the Higgsfield console add funds to the API balance (and verify the email / add a card if it asks).`);
  if (r.status === 401) return httpError(502, `Higgsfield rejected the key (${hfWhy(j) || "code " + r.status}). In the Higgsfield console press Copy API key, paste it into HIGGSFIELD_KEY in Render with nothing else, and save.`);
  if (r.status === 402 || /balance|insufficient|credit|funds/i.test(hfWhy(j))) return httpError(502, "OUT_OF_HF_BALANCE");
  return httpError(502, `Premium motion couldn't ${what}${hfWhy(j) ? ` (${hfWhy(j)})` : ` (code ${r.status})`}. The photo will stay as a still shot.`);
}
async function runHiggsfield(job, model, photo, payload) {
  const parts = payload.negative_prompt.split(",").map(x => x.trim()).filter(Boolean);
  const key = parts.filter(x => /fan|fire|flame|color|appearing|water|wet|puddle|spill|faucet|drip|leak|pour|branch|foliage|camera|warp|morph|people|person|text|new objects|zoom/i.test(x));
  const top = parts.filter(x => /fan|fire|flame|burning|color|appearing|water on|wet|puddle/i.test(x));   // invented fans, fire, color shifts and wet counters first
  const avoid = " Avoid: " + [...new Set([...top, ...key, ...parts])].slice(0, 30).join(", ") + ".";
  const body = { prompt: (payload.prompt + avoid).slice(0, 2400), duration: +DURATION || 5, sound: "off", cfg_scale: payload.cfg_scale };
  // 1) the photo goes to Higgsfield's own storage first
  // the documented "Key ..." form first; only if it's refused, the other forms. Report the documented form's answer.
  let up, first;
  const order = hfKnown ? [hfScheme] : [0, 1, 2];
  for (const sc of order) {
    hfScheme = sc;
    up = await plainFetch(`${HF_BASE}/files/generate-upload-url`, { method: "POST", headers: hfHeaders(), timeout: 30000, body: JSON.stringify({ content_type: photo.type }) });
    if (up.status !== 401 && up.status !== 403) { if (up.status < 400) hfKnown = true; break; }
    console.error("higgsfield auth form", sc, "refused", up.status, up.buf.toString("utf8").slice(0, 300));
    first = first || up;
  }
  if (first && (up.status === 401 || up.status === 403)) { up = first; hfScheme = 0; }
  const uj = hfJson(up);
  let imageUrl;
  if (up.status < 400 && uj.upload_url && uj.public_url) {
    const put = await plainFetch(uj.upload_url, { method: "PUT", headers: { ...(uj.upload_headers || {}), "content-type": photo.type }, timeout: 60000, body: Buffer.from(photo.b64, "base64") });
    if (put.status < 400) imageUrl = uj.public_url; else console.error("higgsfield upload PUT", put.status, put.buf.toString("utf8").slice(0, 200));
  } else console.error("higgsfield upload-url", up.status, up.buf.toString("utf8").slice(0, 300));
  if (!imageUrl && photo.link) imageUrl = photo.link;          // our own short-lived link to the photo
  photo.b64 = null;
  if (!imageUrl) throw hfFail(up, uj, "start the upload");
  // 2) submit
  const sub = await plainFetch(`${HF_BASE}/${model}`, { method: "POST", headers: { ...hfHeaders(), "idempotency-key": crypto.randomUUID() }, timeout: 60000, body: JSON.stringify({ ...body, image_url: imageUrl }) });
  const s = hfJson(sub);
  if (sub.status >= 400 || !s.request_id) throw hfFail(sub, s, "take that photo");
  const statusUrl = s.status_url && String(s.status_url).startsWith(HF_BASE + "/") ? s.status_url : `${HF_BASE}/requests/${encodeURIComponent(s.request_id)}/status`;
  job.status = "working";
  const deadline = Date.now() + 12 * 60e3; let url;
  for (;;) {
    if (Date.now() > deadline) throw httpError(504, "The premium AI clip took too long. The photo will stay as a still shot.");
    await new Promise(r => setTimeout(r, +process.env.CLIP_POLL_MS || 4000));
    const st = await plainFetch(statusUrl, { headers: hfHeaders(), timeout: 30000 });
    const sj = hfJson(st);
    if (sj.status === "completed") { url = sj.video?.url; break; }
    if (sj.status === "nsfw") throw httpError(502, "Higgsfield's content filter declined that photo. It will stay as a still shot.");
    if (["failed", "canceled"].includes(sj.status)) throw hfFail(st, sj, "finish that clip");
    if (st.status >= 400 && st.status !== 404) throw hfFail(st, sj, "report on that clip");
  }
  if (!url || !okFalUrl(url)) throw httpError(502, "Higgsfield didn't return a clip. The photo will stay as a still shot.");
  await slot();
  const file = path.join(CLIP_DIR, `${crypto.randomUUID()}.mp4`);
  let vid; try { vid = await fetchToFile(url, file, { timeout: 120000, maxBytes: 80e6 }); } finally { release(); }
  if (vid.status >= 400 || vid.size < 10000) { fs.rm(file, { force: true }, () => {}); throw httpError(502, "Couldn't download the finished premium clip. The photo will stay as a still shot."); }
  job.file = file; job.size = vid.size; job.status = "done";
}

export function clipStatus(id, owner) {
  const j = jobs.get(id);
  if (!j || (j.owner && owner && j.owner !== owner)) throw httpError(404, "That AI clip has expired. Run AI motion again.");
  return { status: j.status, error: j.error || null, position: j.position ?? null };
}
export function clipVideo(id, owner) {
  const j = jobs.get(id);
  if (!j || j.status !== "done" || (j.owner && owner && j.owner !== owner)) throw httpError(404, "That AI clip isn't ready.");
  if (!j.file || !fs.existsSync(j.file)) throw httpError(404, "That AI clip has expired. Run AI motion again.");
  j.servedAt = j.servedAt || Date.now();
  return { file: j.file, size: j.size };
}
export const clipModel = () => MODEL;
