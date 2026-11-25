// The client agreement and the photo-rights promises clients check, with a version and a fingerprint (SHA-256)
// of the exact words shown, so every acceptance record says precisely what was agreed to.
// The text lives in private/client-agreement.md. Change it there, then bump AGREEMENT_VERSION.
//   COMPANY_LEGAL_NAME  the legal name of the business that sells the videos (default "Advance Marketing Group")
//   LEGAL_STATE         governing law (default "Wisconsin")
//   LEGAL_COUNTY        where lawsuits go (default "St. Croix County")
//   SUPPORT_EMAIL       where clients send notices (default support@advancemarketinggroup.net)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "private", "client-agreement.md");
export const AGREEMENT_VERSION = "v1-2026-11-25";
export const sha256 = s => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const tokens = () => ({
  COMPANY: process.env.COMPANY_LEGAL_NAME || "Advance Marketing Group",
  STATE: process.env.LEGAL_STATE || "Wisconsin",
  COUNTY: process.env.LEGAL_COUNTY || "St. Croix County",
  EMAIL: process.env.SUPPORT_EMAIL || "support@advancemarketinggroup.net",
});

// headings (#, ##), paragraphs, "- " lists and **bold**: all the agreement uses
export function mdToHtml(md) {
  const out = []; let para = [], list = [];
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join("")}</ul>`); list = []; }
  };
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flush(); const n = m[1].length; out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
    if ((m = /^-\s+(.*)$/.exec(line))) { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } list.push(m[1]); continue; }
    if (list.length) flush();
    para.push(line);
  }
  flush();
  return out.join("\n");
}

let cached = null;
export function agreement() {
  const t = tokens(), key = JSON.stringify(t);
  if (cached && cached.key === key) return cached.value;
  const md = fs.readFileSync(FILE, "utf8").replace(/\{\{(\w+)\}\}/g, (all, k) => t[k] ?? all);
  const value = { version: AGREEMENT_VERSION, title: "Client Video Agreement", company: t.COMPANY, email: t.EMAIL, markdown: md, html: mdToHtml(md), hash: sha256(md) };
  cached = { key, value };
  return value;
}

// The box a client checks before sending photos or a listing link. Plain words, the key promise of section 4.
export const RIGHTS_VERSION = "v1-2026-11-25";
const RIGHTS_TEXT = {
  rls: "I'm the listing agent for this property, or I have written permission from the listing agent and brokerage, and the photographer's license lets these photos be used in videos and ads. None of them are stock, royalty-free or someone else's photos. If anyone claims a right to them, I'm responsible, as my agreement says.",
  rbs: "These photos, clips and logo belong to me or my business, or I have written permission to use them in videos and ads. None of them are stock, royalty-free or copied from the internet, and everyone shown agreed to be in them. If anyone claims a right to them, I'm responsible, as my agreement says.",
  studio: "I own these photos, or I have written permission to use them in this video (for a listing: I'm the listing agent, or I have the listing agent's and the photographer's permission). None are stock, royalty-free or someone else's photos without a license.",
};
export function rightsStatement(kind) {
  const text = RIGHTS_TEXT[kind] || RIGHTS_TEXT.rls;
  return { kind: RIGHTS_TEXT[kind] ? kind : "rls", version: RIGHTS_VERSION, text, hash: sha256(text) };
}
export const allRights = () => Object.fromEntries(Object.keys(RIGHTS_TEXT).map(k => [k, rightsStatement(k)]));

// /terms: the agreement as its own page, for sign-ups and anyone who wants to read it first
export function termsPage() {
  const a = agreement();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} | Reel Listing Studio and Reel Business Studio</title><meta name="robots" content="noindex">
<style>body{margin:0;background:#F3F0E9;color:#121211;font:16px/1.6 Georgia,"Times New Roman",serif}main{max-width:760px;margin:0 auto;padding:40px 22px 80px}
h1{font-size:34px;line-height:1.15;margin:0 0 6px}h2{font:600 15px/1.3 system-ui,-apple-system,Segoe UI,Arial,sans-serif;letter-spacing:.06em;text-transform:uppercase;margin:34px 0 8px;border-top:1px solid #d8d2c4;padding-top:18px}
p,li{margin:0 0 12px}ul{padding-left:20px}.meta{font:13px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#5d584d;margin-top:30px}@media (prefers-color-scheme:dark){body{background:#121211;color:#F3F0E9}h2{border-color:#3a3833}.meta{color:#aaa498}}</style>
</head><body><main>${a.html}<p class="meta">Version ${esc(a.version)}. Fingerprint ${esc(a.hash.slice(0, 16))}. Questions: ${esc(a.email)}</p></main></body></html>`;
}
