// AI for the Studio when it runs on your own domain: listing auto-fill, photo labels and captions.
// (Inside claude.ai the Studio uses the viewer's own Claude account instead.)
// Uses your Anthropic API key. Locked to listing-marketing work so it can't be used as a free chatbot.
import { plainFetch, httpError } from "./safe-fetch.js";

const BASE = process.env.ANTHROPIC_BASE || "https://api.anthropic.com";
const MODELS = {
  quick: process.env.AI_MODEL_QUICK || "claude-haiku-5-5",
  default: process.env.AI_MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.AI_MODEL_DEFAULT || "claude-sonnet-5-5",
};
const SYSTEM = "You are the writing and photo assistant inside Reel Listing Studio, a tool that makes real estate and vacation-rental listing videos. Only help with that: reading listing details, labeling and ordering listing photos, and writing listing captions. Follow US Fair Housing advertising rules: describe the property, never who should live there. If asked for anything unrelated, reply with an empty JSON object {}.";

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;

export async function runAI({ prompt, images = [], tier = "default" }) {
  if (!aiEnabled()) throw httpError(404, "AI isn't set up on this server.");
  if (typeof prompt !== "string" || !prompt.trim()) throw httpError(400, "Nothing to send to the AI.");
  if (prompt.length > 40000) throw httpError(413, "That's too much text for one AI request. Shorten the description and try again.");
  if (!Array.isArray(images) || images.length > 8) throw httpError(400, "Send at most 8 photos at a time.");
  const content = [];
  for (const im of images) {
    const m = String(im).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw httpError(400, "One of the photos isn't a JPG, PNG or WebP.");
    if (m[2].length > 3_000_000) throw httpError(413, "One of the photos is too large to send to the AI.");
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({ type: "text", text: prompt });
  const model = MODELS[tier] || MODELS.default;
  const r = await plainFetch(`${BASE}/v1/messages`, {
    method: "POST", timeout: 120000,
    headers: { "x-api-key": String(process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
  let j = {}; try { j = JSON.parse(r.buf.toString("utf8")); } catch {}
  if (r.status === 429) throw httpError(429, "The AI is busy right now. Wait a minute, then try again.");
  if (r.status >= 400) {
    const msg = String(j?.error?.message || ""); console.error("AI error", r.status, model, msg);
    if (r.status === 401 || r.status === 403) throw httpError(502, "The server's Anthropic API key was rejected. Check ANTHROPIC_API_KEY in Render's Environment settings.");
    if (/credit|balance|billing/i.test(msg)) throw httpError(502, "The Anthropic account is out of credit. Add credit at console.anthropic.com (Plans & Billing), then try again.");
    if (r.status === 404 || /model/i.test(msg)) throw httpError(502, `The AI model "${model}" isn't available to this API key. Set AI_MODEL_DEFAULT and AI_MODEL_QUICK in Render to a model your key can use.`);
    if (r.status === 529 || r.status >= 500) throw httpError(502, "Anthropic's AI service is overloaded right now. Try again in a minute.");
    throw httpError(502, `The AI couldn't handle that request: ${msg.slice(0, 160) || "code " + r.status}.`);
  }
  const text = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  if (!text) throw httpError(502, "The AI came back empty. Try again.");
  return { text, truncated: j.stop_reason === "max_tokens", model };
}
