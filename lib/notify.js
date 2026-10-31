// Lead alerts by email through Resend (resend.com). Off until RESEND_API_KEY is set in Render.
//   RESEND_API_KEY   the key from Resend (starts with re_)
//   LEAD_ALERT_FROM  sender on your verified domain, e.g. "Reel Listing Studio <leads@reellistingstudio.com>"
//   LEAD_ALERT_TO    who always gets every lead (comma-separated). Defaults to the owner emails (ADMIN_EMAILS).
const BASE = process.env.RESEND_BASE || "https://api.resend.com";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const list = s => String(s || "").split(/[\s,]+/).map(x => x.trim()).filter(x => /@/.test(x));
export const emailEnabled = () => !!process.env.RESEND_API_KEY;

async function send({ to, subject, html, text, replyTo, attachments }) {
  const r = await fetch(`${BASE}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${String(process.env.RESEND_API_KEY).trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.LEAD_ALERT_FROM || "Reel Listing Studio <onboarding@resend.dev>", to, subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}), ...(attachments ? { attachments } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// One email to the owner(s), one to the partner who referred the agent (if any). Never blocks or breaks the form.
export function leadAlert(lead, partner) {
  if (!emailEnabled()) return;
  const rows = [["Name", lead.name], ["Phone", lead.phone], ["Email", lead.email], ["Listing", lead.listing], ["Package", lead.package], ["Notes", lead.notes],
    ["Referred by", partner ? partner.name || partner.email : "Direct (no partner link)"], ["Ad campaign", [lead.utm_source, lead.utm_campaign].filter(Boolean).join(" / ")]].filter(r => r[1]);
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5"><h2 style="margin:0 0 12px">New listing video request</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>
<p style="color:#666">Reply to this email to answer the agent directly. Reach out within one business day, as the page promises.</p></div>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const subject = `New listing video request: ${lead.name}${lead.package ? ` (${lead.package})` : ""}`;
  const replyTo = lead.email || undefined;
  const owners = list(process.env.LEAD_ALERT_TO || process.env.ADMIN_EMAILS);
  const jobs = [];
  if (owners.length) jobs.push(send({ to: owners, subject, html, text, replyTo }));
  if (partner?.email && !owners.includes(partner.email.toLowerCase())) jobs.push(send({ to: [partner.email], subject: `Your referral just requested a video: ${lead.name}`, html, text, replyTo }));
  Promise.allSettled(jobs).then(rs => rs.forEach(r => r.status === "rejected" && console.error("lead alert email failed:", r.reason?.message)));
}

export async function sendPasswordLink(to, link) {
  if (!emailEnabled()) return;
  await send({ to: [to], subject: "Reset your Reel Listing Studio password",
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5"><p>Someone asked to reset the password for this Reel Listing Studio account.</p><p><a href="${esc(link)}" style="display:inline-block;background:#C97A0E;color:#13161B;padding:12px 20px;border-radius:999px;font-weight:bold;text-decoration:none">Choose a new password</a></p><p style="color:#666">The link works once and expires in 1 hour. If you didn't ask for this, ignore this email.</p></div>`,
    text: `Reset your Reel Listing Studio password (link works once, expires in 1 hour):\n${link}\n\nIf you didn't ask for this, ignore this email.` });
}

// Partner welcome email: a personal note with their password link, sign-in address, personal link and the Launch Plan PDF.
export function welcomeEmail({ name, setupLink, site, code, videos }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const link = code ? `${site}/${code}` : `${site}/agents`;
  const subject = `Welcome to Reel Listing Studio, ${first}: your partner account is ready`;
  const text = `Hi ${first},

Welcome aboard. I'm really glad you're partnering with us on Reel Listing Studio. Here's everything you need to get going:

1) Set your password (this link works once and expires in 14 days):
${setupLink}

2) Sign in anytime at:
${site}/studio

3) Your personal link to share with agents:
${link}
Anyone who requests a video or signs up through it is credited to you for 90 days. You can change it to a custom link in Agency tools > My link & leads.

Your account includes ${videos} videos so you can make demos and sample videos for the agents you're talking to.

I've attached your Partner Launch Plan: a 14-day, step-by-step guide to setting up, making your first video, and sharing your link with the scripts and videos in Agency tools. You'll always find it in Agency tools > Launch Plan too.

Any questions at all, call or text me at (715) 222-6776.

Let's go win some listings,
Ryan Allaire
Reel Listing Studio`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#13161B;max-width:600px">${esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#C97A0E;font-weight:bold">$1</a>').replace(/\n/g, "<br>")}</div>`;
  return { subject, text, html };
}
export async function sendWelcome(to, mail, pdf) {
  if (!emailEnabled()) throw new Error("Email isn't set up yet.");
  await send({ to: [to], subject: mail.subject, text: mail.text, html: mail.html, replyTo: list(process.env.LEAD_ALERT_TO || process.env.ADMIN_EMAILS)[0],
    attachments: pdf ? [{ filename: "Reel-Listing-Studio-Partner-Launch-Plan.pdf", content: pdf.toString("base64") }] : undefined });
}

// A partner asked for a VIP Reload: tell the owner(s)
export function vipAlert({ name, email, phone, videos, left, note }) {
  if (!emailEnabled()) return;
  const owners = list(process.env.LEAD_ALERT_TO || process.env.ADMIN_EMAILS); if (!owners.length) return;
  const text = `${name} asked for a VIP Reload of ${videos} videos.\nVideos left: ${left}\nEmail: ${email}${phone ? `\nPhone: ${phone}` : ""}${note ? `\nNote: ${note}` : ""}\n\nSend their invoice, then add the videos in Owner tools > Add partners (Videos each = ${videos}).`;
  send({ to: owners, subject: `VIP Reload request: ${name} (${videos} videos)`, text, html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${esc(text).replace(/\n/g, "<br>")}</div>`, replyTo: email })
    .catch(e => console.error("VIP reload email failed:", e.message));
}
