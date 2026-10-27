// AI motion clips: turns a listing photo into a few seconds of real moving footage
// through an image-to-video model on fal.ai. Jobs run in the background; the Studio polls.
import crypto from "node:crypto";
import { plainFetch, httpError } from "./safe-fetch.js";

const MODEL = process.env.FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
const QUEUE = process.env.FAL_QUEUE_BASE || "https://queue.fal.run";
const DURATION = process.env.CLIP_SECONDS || "5";

export const clipsEnabled = () => !!process.env.FAL_KEY;
// owner-only comparison: other image-to-video models on fal (newer Kling versions follow object-motion instructions better)
const ALT_MODELS = { kling26: "fal-ai/kling-video/v2.6/pro/image-to-video", kling3: "fal-ai/kling-video/v3/pro/image-to-video" };
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
  faucet: "A gentle stream of clear water runs from the faucet into the sink.",
  curtains: "The curtains move very slightly in a soft breeze.",
  trees: "The trees already in the scene sway gently in a light breeze, staying in their places.",
  sky: "Clouds drift slowly across the sky.",
};
// outdoors trees and sky may move; indoors they're never mentioned (the model invents branches in the room)
const OUTDOOR_ONLY = new Set(["trees", "sky"]);
const NEGATIVE_INDOOR = ", tree branches, leaves, foliage, vines or plants hanging into view";
const NEGATIVE = "zoom, zooming in, zooming out, people, person, pets, text, watermark, logo, warping, morphing, melting furniture, bending walls, distortion, frame flicker, strobing, blur, low quality, new objects, new plants, new trees, branches hanging into the frame from the edges, objects entering the frame, changing the room";

const jobs = new Map();       // id -> { status, error, video, createdAt, owner }
const JOB_TTL = 3600e3;
setInterval(() => { const now = Date.now(); for (const [k, j] of jobs) if (now - j.createdAt > JOB_TTL) jobs.delete(k); }, 300e3).unref();

// tolerate copy-paste extras around the key (spaces, quotes, line breaks, a leading "Key ")
const falKey = () => String(process.env.FAL_KEY || "").trim().replace(/^["']|["']$/g, "").replace(/^Key\s+/i, "").trim();
const falHeaders = () => ({ authorization: `Key ${falKey()}`, "content-type": "application/json" });
const okFalUrl = u => { try { const x = new URL(u); return x.protocol === "https:" || (process.env.ALLOW_LOCAL_FETCH === "1" && x.protocol === "http:"); } catch { return false; } };

export function startClip({ image, kind = "int", move, live, retry, movers, model, lockCam }, owner, { onFail, publicBase, admin } = {}) {
  const useModel = admin && ALT_MODELS[model] ? ALT_MODELS[model] : MODEL;
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
  run(job, imageUrl, PROMPTS[kind] ? kind : "int", MOVES[move] ? move : null, alive, outdoor, !!retry, cleanMovers(movers), useModel, !!lockCam).catch(e => { job.status = "failed"; try { onFail && onFail(id); } catch {} job.error = e.status ? e.message : "The AI video service had a problem. The photo will stay as a still shot."; if (!e.status) console.error("clip failed", e); });
  return id;
}

async function run(job, image, kind, move, alive = [], outdoor = false, retry = false, movers = "", model = MODEL, lockCam = false) {
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
  const backup = outdoor ? "Any trees sway gently in place and any water ripples softly." : "Any ceiling fan turns slowly, any fireplace flickers gently and any running faucet flows.";
  const lively = alive.length ? alive.map(k => LIVE[k]).join(" ") + " " + backup
    : outdoor ? "Only things that already exist in the photo move: any trees sway gently in place, clouds drift slowly, any pool or water ripples softly."
    : "Only things that already exist in the photo move: any ceiling fan turns slowly, any fireplace has gently flickering flames, any pool, hot tub or water ripples softly.";
  // a re-make after a clip came back nearly frozen: ask for clearly visible movement
  const stronger = !retry ? "" : lockCam ? " The fan blades must be clearly spinning, flames clearly flickering and water clearly moving from the first second to the last." : " The movement must be clearly visible from the first second to the last: the camera keeps moving steadily, and fan blades, flames and water are visibly in motion.";
  const prompt = `${lead}${base} ${lively}${stronger} Only things already in the photo move; nothing new appears.`;
  const payload = { prompt, image_url: image, duration: DURATION, negative_prompt: (outdoor ? NEGATIVE : NEGATIVE + NEGATIVE_INDOOR) + (lockCam ? ", camera movement, camera pan, camera shake" : ""), cfg_scale: lockCam ? 0.7 : 0.6 };
  if (model !== MODEL) payload.generate_audio = false;            // newer Kling versions can add sound; we don't use it
  const sub = await plainFetch(`${QUEUE}/${model}`, { method: "POST", headers: falHeaders(), timeout: 60000, body: JSON.stringify(payload) });
  const s = JSON.parse(sub.buf.toString("utf8") || "{}");
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
  const vid = await plainFetch(url, { timeout: 120000, maxBytes: 80e6 });
  if (vid.status >= 400 || vid.buf.length < 10000) throw httpError(502, "Couldn't download the finished AI clip. The photo will stay as a still shot.");
  job.video = vid.buf; job.status = "done";
}

export function clipStatus(id, owner) {
  const j = jobs.get(id);
  if (!j || (j.owner && owner && j.owner !== owner)) throw httpError(404, "That AI clip has expired. Run AI motion again.");
  return { status: j.status, error: j.error || null, position: j.position ?? null };
}
export function clipVideo(id, owner) {
  const j = jobs.get(id);
  if (!j || j.status !== "done" || (j.owner && owner && j.owner !== owner)) throw httpError(404, "That AI clip isn't ready.");
  return j.video;
}
export const clipModel = () => MODEL;
