// AI motion clips: turns a listing photo into a few seconds of real moving footage
// through an image-to-video model on fal.ai. Jobs run in the background; the Studio polls.
import crypto from "node:crypto";
import { plainFetch, httpError } from "./safe-fetch.js";

const MODEL = process.env.FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
const QUEUE = process.env.FAL_QUEUE_BASE || "https://queue.fal.run";
const DURATION = process.env.CLIP_SECONDS || "5";

export const clipsEnabled = () => !!process.env.FAL_KEY;

// The Studio only says what kind of shot it is; the wording sent to the model is decided here.
const PROMPTS = {
  ext: "Smooth, slow cinematic camera glide toward the home, like a stabilized drone or gimbal shot. Architecture stays perfectly straight and stable. Gentle natural light, subtle movement in trees and sky. Real estate listing video.",
  int: "Smooth, slow forward dolly through the room on a steady gimbal, like a professional real estate walkthrough. Walls and vertical lines stay perfectly straight. Furniture, windows and decor stay exactly as they are. Bright, natural light.",
  detail: "Slow, gentle push-in toward the detail on a steady gimbal with soft natural light. Everything stays exactly as it is. Real estate listing video.",
};
const NEGATIVE = "people, person, pets, text, watermark, logo, warping, morphing, melting furniture, bending walls, distortion, flicker, blur, low quality, new objects, changing the room";

const jobs = new Map();       // id -> { status, error, video, createdAt, owner }
const JOB_TTL = 3600e3;
setInterval(() => { const now = Date.now(); for (const [k, j] of jobs) if (now - j.createdAt > JOB_TTL) jobs.delete(k); }, 300e3).unref();

const falHeaders = () => ({ authorization: `Key ${process.env.FAL_KEY}`, "content-type": "application/json" });
const okFalUrl = u => { try { const x = new URL(u); return x.protocol === "https:" || (process.env.ALLOW_LOCAL_FETCH === "1" && x.protocol === "http:"); } catch { return false; } };

export function startClip({ image, kind = "int" }, owner, { onFail } = {}) {
  if (!clipsEnabled()) throw httpError(404, "AI motion isn't set up on this server.");
  const m = String(image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw httpError(400, "Send the photo as a JPG, PNG or WebP.");
  if (m[2].length > 4_000_000) throw httpError(413, "That photo is too large to animate. It should be under 3 MB.");
  const id = crypto.randomUUID();
  const job = { status: "queued", createdAt: Date.now(), owner };
  jobs.set(id, job);
  run(job, image, PROMPTS[kind] ? kind : "int").catch(e => { job.status = "failed"; try { onFail && onFail(id); } catch {} job.error = e.status ? e.message : "The AI video service had a problem. The photo will stay as a still shot."; if (!e.status) console.error("clip failed", e); });
  return id;
}

async function run(job, image, kind) {
  const sub = await plainFetch(`${QUEUE}/${MODEL}`, { method: "POST", headers: falHeaders(), timeout: 60000,
    body: JSON.stringify({ prompt: PROMPTS[kind], image_url: image, duration: DURATION, negative_prompt: NEGATIVE, cfg_scale: 0.5 }) });
  const s = JSON.parse(sub.buf.toString("utf8") || "{}");
  if (sub.status === 401 || sub.status === 403) throw httpError(502, "The AI video service rejected the server's key. Check FAL_KEY in your settings.");
  if (sub.status === 402 || /balance|credit/i.test(s.detail || "")) throw httpError(502, "The AI video account is out of credit. Add credit at fal.ai, then try again.");
  if (sub.status >= 400 || !s.request_id) throw httpError(502, "The AI video service couldn't take that photo. It will stay as a still shot.");
  const statusUrl = s.status_url || `${QUEUE}/${MODEL}/requests/${s.request_id}/status`;
  const resultUrl = s.response_url || `${QUEUE}/${MODEL}/requests/${s.request_id}`;
  job.status = "working";
  const deadline = Date.now() + 10 * 60e3;
  for (;;) {
    if (Date.now() > deadline) throw httpError(504, "The AI clip took too long. The photo will stay as a still shot.");
    await new Promise(r => setTimeout(r, +process.env.CLIP_POLL_MS || 4000));
    const st = await plainFetch(statusUrl, { headers: falHeaders(), timeout: 30000 });
    const sj = JSON.parse(st.buf.toString("utf8") || "{}");
    if (sj.status === "COMPLETED") break;
    if (sj.status && !["IN_QUEUE", "IN_PROGRESS"].includes(sj.status)) throw httpError(502, "The AI video service couldn't finish that clip. The photo will stay as a still shot.");
    if (typeof sj.queue_position === "number") job.position = sj.queue_position;
  }
  const res = await plainFetch(resultUrl, { headers: falHeaders(), timeout: 60000 });
  const rj = JSON.parse(res.buf.toString("utf8") || "{}");
  const url = rj?.video?.url;
  if (res.status >= 400 || !url || !okFalUrl(url)) throw httpError(502, "The AI clip came back empty. The photo will stay as a still shot.");
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
