// Client orders: the path from a closed sale to a delivered video.
//   1. The sales agent (partner) or the owner creates the order in Agency tools and sends the client a private link.
//   2. The client accepts the Client Video Agreement on that link (typed name + checkbox).
//   3. The client uploads photos (and a logo) or pastes the MLS / listing link, and checks the photo-rights box.
//   4. Whoever makes the video (our team or the partner) marks it in production, then delivered with the video link.
//   5. The client approves it or asks for changes. No answer in 7 days counts as approved (section 8.1).
// Every step is written to order_events and never deleted: that log is the record of who accepted what, and when.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { getDb, isAdmin } from "./accounts.js";
import { agreement, AGREEMENT_VERSION, rightsStatement, RIGHTS_VERSION, sha256 } from "./agreement.js";
import { httpError } from "./safe-fetch.js";

export const BRANDS = { rls: "Reel Listing Studio", rbs: "Reel Business Studio" };
export const STATUS = {
  sent: "Link sent: waiting for the client to accept the agreement",
  agreed: "Agreement accepted: waiting for photos or the listing link",
  submitted: "Photos in: ready to make",
  production: "In production",
  delivered: "Delivered: waiting for the client's review",
  changes: "Client asked for changes",
  approved: "Approved",
  cancelled: "Cancelled",
};
export const MAX_PHOTOS = 40;
const MAX_FILE = 12e6;            // after the page shrinks photos to 2400 px they're usually under 2 MB
const MAX_ORDER_BYTES = 250e6;
const REVIEW_DAYS = 7;

let ready = null;
function db() {
  const d = getDb();
  if (ready === d) return d;
  d.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      partner_id INTEGER, created_by INTEGER, brand TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent',
      client_name TEXT NOT NULL, client_email TEXT, client_phone TEXT, business TEXT, package TEXT, price TEXT,
      maker TEXT NOT NULL DEFAULT 'team', paid INTEGER NOT NULL DEFAULT 0, lead_id INTEGER,
      agreed_at INTEGER, agreed_name TEXT, agreement_version TEXT, agreement_hash TEXT,
      listing_url TEXT, details TEXT, notes TEXT, portfolio_ok INTEGER NOT NULL DEFAULT 0,
      rights_at INTEGER, rights_version TEXT, rights_hash TEXT, submitted_at INTEGER,
      delivery_url TEXT, delivered_at INTEGER, review_note TEXT, approved_at INTEGER);
    CREATE TABLE IF NOT EXISTS order_files (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT,
      file TEXT NOT NULL, type TEXT, size INTEGER, sha256 TEXT, at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS order_events (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
      actor TEXT NOT NULL, user_id INTEGER, ip TEXT, ua TEXT, detail TEXT);
    CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id);
    CREATE INDEX IF NOT EXISTS order_files_order ON order_files(order_id);
    CREATE TABLE IF NOT EXISTS rights_acks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
      source TEXT, version TEXT, hash TEXT, ip TEXT, ua TEXT);
    CREATE TABLE IF NOT EXISTS terms_acks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL, version TEXT, hash TEXT, ip TEXT, ua TEXT);`);
  ready = d; return d;
}

// photos live next to the accounts database (the Render disk), one folder per order
let FILES = null;
function filesDir() {
  if (FILES) return FILES;
  const want = process.env.ORDER_DIR || path.join(path.dirname(process.env.DB_PATH || path.join(process.cwd(), "data", "reel.db")), "orders");
  try { fs.mkdirSync(want, { recursive: true }); FILES = want; }
  catch (e) { FILES = path.join(os.tmpdir(), "rls-orders"); fs.mkdirSync(FILES, { recursive: true }); console.error(`Client photos can't be saved at ${want} (${e.message}); using ${FILES}, which is lost on redeploy.`); }
  return FILES;
}

const clip = (x, n) => String(x ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
const cleanEmail = e => String(e || "").trim().toLowerCase().slice(0, 200);
const okEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e);
function httpsUrl(u, max = 500) {
  const s = String(u || "").trim(); if (!s) return "";
  let x; try { x = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s); } catch { return null; }
  if (!/^https?:$/.test(x.protocol) || !/\./.test(x.hostname) || x.href.length > max || x.username || x.password) return null;
  return x.href;
}
const meta = m => ({ ip: clip(m?.ip, 64) || null, ua: clip(m?.ua, 300) || null });
function event(orderId, kind, actor, detail, m, userId = null) {
  const { ip, ua } = meta(m);
  db().prepare("INSERT INTO order_events(order_id,at,kind,actor,user_id,ip,ua,detail) VALUES(?,?,?,?,?,?,?,?)")
    .run(orderId, Date.now(), kind, actor, userId, ip, ua, detail ? JSON.stringify(detail) : null);
}
const touch = (id, sets, vals) => db().prepare(`UPDATE orders SET ${sets}, updated=? WHERE id=?`).run(...vals, Date.now(), id);

// a delivered video with no answer for 7 days counts as approved (Agreement 8.1)
function settle(o) {
  if (o && o.status === "delivered" && o.delivered_at && Date.now() - o.delivered_at > REVIEW_DAYS * 864e5) {
    touch(o.id, "status='approved', approved_at=?", [Date.now()]);
    event(o.id, "auto_approved", "system", { reason: `No changes asked for within ${REVIEW_DAYS} days of delivery` });
    return db().prepare("SELECT * FROM orders WHERE id=?").get(o.id);
  }
  return o;
}
const byToken = token => /^[A-Za-z0-9_-]{24,64}$/.test(String(token || "")) ? settle(db().prepare("SELECT * FROM orders WHERE token=?").get(String(token))) : null;
const byId = id => settle(db().prepare("SELECT * FROM orders WHERE id=?").get(+id || 0));
function mustToken(token) { const o = byToken(token); if (!o) throw httpError(404, "This link isn't valid. Ask your rep for a new one."); return o; }
const files = (orderId, kind) => db().prepare(`SELECT id,kind,name,type,size,sha256,at FROM order_files WHERE order_id=? AND removed=0${kind ? " AND kind=?" : ""} ORDER BY id`).all(...(kind ? [orderId, kind] : [orderId]));
const details = o => { try { return JSON.parse(o.details || "null") || {}; } catch { return {}; } };
function rep(o) {
  const p = o.partner_id && db().prepare("SELECT name,email,phone FROM users WHERE id=?").get(o.partner_id);
  if (p) return { name: p.name || "", email: p.email || "", phone: p.phone || "" };
  return { name: process.env.OWNER_NAME || "Ryan Allaire", email: process.env.SUPPORT_EMAIL || "support@advancemarketinggroup.net", phone: process.env.OWNER_PHONE || "" };
}

// ---------- what the client sees on their link ----------
export function clientView(token, m) {
  const o = mustToken(token);
  if (!db().prepare("SELECT 1 FROM order_events WHERE order_id=? AND kind='opened'").get(o.id)) event(o.id, "opened", "client", null, m);
  const a = agreement(), r = rightsStatement(o.brand);
  return {
    brand: o.brand, brandName: BRANDS[o.brand], status: o.status, first: o.client_name.split(/\s+/)[0], name: o.client_name, business: o.business || "",
    package: o.package || "", rep: rep(o),
    agreement: { version: a.version, hash: a.hash, html: a.html, accepted: !!o.agreed_at, acceptedAt: o.agreed_at, acceptedName: o.agreed_name, acceptedVersion: o.agreement_version },
    rights: { version: r.version, text: r.text, confirmedAt: o.rights_at },
    files: files(o.id).map(f => ({ id: f.id, kind: f.kind, name: f.name, size: f.size })), maxPhotos: MAX_PHOTOS,
    listing: o.listing_url || "", details: details(o), notes: o.notes || "", portfolio: !!o.portfolio_ok, submittedAt: o.submitted_at,
    delivery: o.delivery_url || "", deliveredAt: o.delivered_at, reviewBy: o.delivered_at ? o.delivered_at + REVIEW_DAYS * 864e5 : null,
    reviewNote: o.review_note || "", approvedAt: o.approved_at,
  };
}

export function acceptAgreement(token, body, m) {
  const o = mustToken(token);
  if (o.agreed_at) return clientView(token, m);
  if (o.status === "cancelled") throw httpError(409, "This order was cancelled. Contact your rep.");
  const a = agreement(), name = clip(body.name, 100);
  if (body.version !== a.version || body.hash !== a.hash) throw httpError(409, "The agreement was just updated. Reload the page to read the new version.");
  if (body.agree !== true) throw httpError(400, "Check the box to accept the agreement.");
  if (name.replace(/[^\p{L}]/gu, "").length < 2 || !/\s/.test(name)) throw httpError(400, "Type your full name (first and last) to sign.");
  touch(o.id, "status='agreed', agreed_at=?, agreed_name=?, agreement_version=?, agreement_hash=?", [Date.now(), name, a.version, a.hash]);
  event(o.id, "agreement_accepted", "client", { typedName: name, orderName: o.client_name, email: o.client_email || "", version: a.version, hash: a.hash,
    statement: "I've read and agree to the Client Video Agreement, and I'm authorized to accept it for my business." }, m);
  return clientView(token, m);
}

const SNIFF = [[/^ffd8ff/, "jpg", "image/jpeg"], [/^89504e47/, "png", "image/png"], [/^52494646.{8}57454250/, "webp", "image/webp"]];
export function addFile(token, body, m) {
  const o = mustToken(token);
  if (!o.agreed_at) throw httpError(409, "Accept the agreement first.");
  if (o.status !== "agreed") throw httpError(409, "Your photos are already in. To add more, contact your rep.");
  const kind = body.kind === "logo" ? "logo" : "photo";
  const b64 = String(body.data || "").replace(/^data:[^,]*,/, "");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length || buf.length > MAX_FILE) throw httpError(413, "That photo is too large. Try a smaller copy.");
  const hex = buf.subarray(0, 12).toString("hex"), t = SNIFF.find(([re]) => re.test(hex));
  if (!t) throw httpError(415, "Send photos as JPG, PNG or WebP.");
  const live = files(o.id);
  if (kind === "photo" && live.filter(f => f.kind === "photo").length >= MAX_PHOTOS) throw httpError(409, `That's the most photos one order takes (${MAX_PHOTOS}).`);
  if (live.reduce((s, f) => s + (f.size || 0), 0) + buf.length > MAX_ORDER_BYTES) throw httpError(413, "This order has all the photos it can hold.");
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  if (live.some(f => f.sha256 === hash && f.kind === kind)) return clientView(token, m);     // the same photo twice
  if (kind === "logo") for (const f of live.filter(f => f.kind === "logo")) removeFileRow(o, f.id, m, "replaced");
  const dir = path.join(filesDir(), String(o.id)); fs.mkdirSync(dir, { recursive: true });
  const file = `${kind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${t[1]}`;
  fs.writeFileSync(path.join(dir, file), buf);
  const name = clip(body.name, 120).replace(/[\\/]/g, "_") || `${kind}.${t[1]}`;
  const r = db().prepare("INSERT INTO order_files(order_id,kind,name,file,type,size,sha256,at) VALUES(?,?,?,?,?,?,?,?)").run(o.id, kind, name, file, t[2], buf.length, hash, Date.now());
  touch(o.id, "status=status", []);
  event(o.id, "file_added", "client", { fileId: Number(r.lastInsertRowid), kind, name, size: buf.length, sha256: hash }, m);
  return clientView(token, m);
}
function removeFileRow(o, fileId, m, why = "removed") {
  const f = db().prepare("SELECT * FROM order_files WHERE id=? AND order_id=? AND removed=0").get(+fileId || 0, o.id); if (!f) return;
  db().prepare("UPDATE order_files SET removed=1 WHERE id=?").run(f.id);
  fs.rmSync(path.join(filesDir(), String(o.id), f.file), { force: true });
  event(o.id, "file_removed", "client", { fileId: f.id, name: f.name, sha256: f.sha256, why }, m);
}
export function removeFile(token, fileId, m) {
  const o = mustToken(token);
  if (o.status !== "agreed") throw httpError(409, "Your photos are already in. To change them, contact your rep.");
  removeFileRow(o, fileId, m); return clientView(token, m);
}

export function submit(token, body, m) {
  const o = mustToken(token);
  if (!o.agreed_at) throw httpError(409, "Accept the agreement first.");
  if (o.status !== "agreed") throw httpError(409, "Your photos are already in.");
  const r = rightsStatement(o.brand);
  if (body.rights !== true) throw httpError(400, "Check the photo rights box to send your photos.");
  if (body.rightsVersion !== r.version) throw httpError(409, "The photo rights wording was just updated. Reload the page and check the box again.");
  const listing = httpsUrl(body.listing);
  if (listing === null) throw httpError(400, "That link doesn't look right. Copy it from your browser's address bar.");
  const photos = files(o.id, "photo");
  if (!photos.length && !listing) throw httpError(400, o.brand === "rls" ? "Add the listing photos or paste the MLS or listing link." : "Add at least one photo.");
  const d = body.details && typeof body.details === "object" ? body.details : {};
  const det = {}; for (const k of ["business", "offer", "cta", "hours", "phone", "website", "address", "price", "agent", "brokerage"]) if (d[k]) det[k] = clip(d[k], 200);
  const now = Date.now(), portfolio = body.portfolio === true;
  touch(o.id, "status='submitted', listing_url=?, details=?, notes=?, portfolio_ok=?, rights_at=?, rights_version=?, rights_hash=?, submitted_at=?",
    [listing || null, JSON.stringify(det), clip(body.notes, 2000) || null, portfolio ? 1 : 0, now, r.version, r.hash, now]);
  event(o.id, "rights_confirmed", "client", { statement: r.text, version: r.version, hash: r.hash, listing: listing || "",
    files: files(o.id).map(f => ({ id: f.id, kind: f.kind, name: f.name, sha256: f.sha256 })) }, m);
  event(o.id, "submitted", "client", { portfolioOk: portfolio, details: det, notes: clip(body.notes, 2000) }, m);
  return clientView(token, m);
}

export function review(token, body, m) {
  const o = mustToken(token);
  if (o.status !== "delivered") throw httpError(409, o.status === "approved" ? "You've already approved this video." : "Your video isn't ready to review yet.");
  if (body.approve === true) {
    touch(o.id, "status='approved', approved_at=?", [Date.now()]); event(o.id, "approved", "client", null, m);
  } else {
    const note = clip(body.changes, 2000);
    if (note.length < 3) throw httpError(400, "Tell us what you'd like changed.");
    touch(o.id, "status='changes', review_note=?", [note]); event(o.id, "changes_requested", "client", { note }, m);
  }
  return clientView(token, m);
}

export function clientFile(token, fileId) {
  const o = mustToken(token);
  const f = db().prepare("SELECT * FROM order_files WHERE id=? AND order_id=? AND removed=0").get(+fileId || 0, o.id);
  if (!f) throw httpError(404, "Not found.");
  return { path: path.join(filesDir(), String(o.id), f.file), type: f.type };
}

// ---------- the sales agent's and the owner's side (Agency tools > Clients) ----------
const canSee = (user, o) => !!(user && o && (isAdmin(user) || (user.partner && o.partner_id === user.id)));
function mustSee(user, id) { const o = byId(id); if (!canSee(user, o)) throw httpError(404, "No order with that number."); return o; }
function staffView(o) {
  const fl = files(o.id), p = o.partner_id ? db().prepare("SELECT name,email FROM users WHERE id=?").get(o.partner_id) : null;
  return {
    id: o.id, token: o.token, link: `/start/${o.token}`, created: o.created, updated: o.updated, brand: o.brand, brandName: BRANDS[o.brand],
    status: o.status, statusLabel: STATUS[o.status] || o.status, client: { name: o.client_name, email: o.client_email || "", phone: o.client_phone || "", business: o.business || "" },
    package: o.package || "", price: o.price || "", maker: o.maker, paid: !!o.paid, partner: p ? (p.name || p.email) : "", agreedAt: o.agreed_at, agreedName: o.agreed_name || "",
    rightsAt: o.rights_at, submittedAt: o.submitted_at, photos: fl.filter(f => f.kind === "photo").length, logo: fl.find(f => f.kind === "logo")?.id || null,
    listing: o.listing_url || "", details: details(o), notes: o.notes || "", portfolio: !!o.portfolio_ok, delivery: o.delivery_url || "", deliveredAt: o.delivered_at,
    reviewNote: o.review_note || "", approvedAt: o.approved_at,
  };
}
export function createOrder(user, body, m) {
  if (!user || !(user.partner || isAdmin(user))) throw httpError(403, "Partner accounts only.");
  const brand = BRANDS[body.brand] ? body.brand : "rls";
  const name = clip(body.name, 80), email = cleanEmail(body.email), phone = clip(body.phone, 30);
  if (!name) throw httpError(400, "Add the client's name.");
  if (email && !okEmail(email)) throw httpError(400, "That email address doesn't look right.");
  if (!email && phone.replace(/\D/g, "").length < 7) throw httpError(400, "Add the client's email or phone, so they can be reached.");
  const maker = isAdmin(user) && !user.partner ? "team" : body.maker === "partner" ? "partner" : "team";
  let leadId = +body.leadId || null;
  if (leadId && !db().prepare(`SELECT 1 FROM leads WHERE id=?${isAdmin(user) ? "" : " AND partner_id=?"}`).get(...(isAdmin(user) ? [leadId] : [leadId, user.id]))) leadId = null;
  const token = crypto.randomBytes(18).toString("base64url"), now = Date.now();
  const r = db().prepare("INSERT INTO orders(token,created,updated,partner_id,created_by,brand,client_name,client_email,client_phone,business,package,price,maker,paid,lead_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(token, now, now, user.partner ? user.id : null, user.id, brand, name, email || null, phone || null, clip(body.business, 120) || null, clip(body.package, 60) || null, clip(body.price, 40) || null, maker, body.paid === true ? 1 : 0, leadId);
  const id = Number(r.lastInsertRowid);
  event(id, "created", user.partner ? "partner" : "owner", { by: user.email, brand, package: clip(body.package, 60), price: clip(body.price, 40), maker, paid: body.paid === true }, m, user.id);
  return staffView(byId(id));
}
export function listOrders(user) {
  if (!user || !(user.partner || isAdmin(user))) throw httpError(403, "Partner accounts only.");
  const rows = isAdmin(user) ? db().prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 500").all() : db().prepare("SELECT * FROM orders WHERE partner_id=? ORDER BY id DESC LIMIT 500").all(user.id);
  return { orders: rows.map(o => staffView(settle(o))), statuses: STATUS };
}
export function updateOrder(user, id, body, m) {
  const o = mustSee(user, id), actor = isAdmin(user) ? "owner" : "partner", act = String(body.action || "");
  if (act === "paid") { touch(o.id, "paid=?", [body.paid === false ? 0 : 1]); event(o.id, body.paid === false ? "marked_unpaid" : "marked_paid", actor, null, m, user.id); }
  else if (act === "production") {
    if (!["submitted", "changes"].includes(o.status)) throw httpError(409, "Production starts once the client has sent their photos or link.");
    if (!o.paid) throw httpError(409, "Mark the order paid first. Production starts after payment (Agreement 8.2).");
    touch(o.id, "status='production'", []); event(o.id, "production_started", actor, o.status === "changes" ? { revision: true } : null, m, user.id);
  } else if (act === "delivered") {
    const url = httpsUrl(body.url, 1000);
    if (!url) throw httpError(400, "Paste the link to the finished video (Google Drive, Dropbox, YouTube or similar).");
    if (!["submitted", "production", "changes", "delivered"].includes(o.status)) throw httpError(409, "Deliver once the client has sent their photos or link.");
    if (!o.paid) throw httpError(409, "Mark the order paid before delivering it.");
    touch(o.id, "status='delivered', delivery_url=?, delivered_at=?", [url, Date.now()]); event(o.id, "delivered", actor, { url }, m, user.id);
  } else if (act === "reopen") {
    if (o.status !== "submitted") throw httpError(409, "Only an order that's waiting to be made can be reopened for more photos.");
    touch(o.id, "status='agreed'", []); event(o.id, "reopened_for_photos", actor, null, m, user.id);
  } else if (act === "cancel") {
    if (o.status === "cancelled") return staffView(o);
    touch(o.id, "status='cancelled'", []); event(o.id, "cancelled", actor, { reason: clip(body.reason, 300) }, m, user.id);
  } else throw httpError(400, "Unknown action.");
  return staffView(byId(o.id));
}
// the photos as one ZIP in the Chrome Grabber's format, so it drops straight into the Studio
export function orderZip(user, id) {
  const o = mustSee(user, id), dir = path.join(filesDir(), String(o.id)), out = {};
  files(o.id, "photo").forEach((f, k) => { const p = path.join(dir, db().prepare("SELECT file FROM order_files WHERE id=?").get(f.id).file);
    if (fs.existsSync(p)) out[`${String(k + 1).padStart(2, "0")}.${p.split(".").pop()}`] = [new Uint8Array(fs.readFileSync(p)), { level: 0 }]; });
  const d = details(o);
  out["listing.json"] = [new TextEncoder().encode(JSON.stringify({ source: "Reel Listing Client Order", version: 1, grabbedAt: new Date().toISOString(),
    url: o.listing_url || "", title: d.business || o.business || o.client_name, description: o.notes || "", text: [d.offer, d.cta, d.hours, d.phone, d.website].filter(Boolean).join("\n") }, null, 2))];
  const name = `${BRANDS[o.brand].replace(/\s+/g, "-")}-order-${o.id}-${o.client_name.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "")}.zip`;
  return { zip: Buffer.from(zipSync(out)), name };
}
export function staffFile(user, id, fileId) {
  const o = mustSee(user, id), f = db().prepare("SELECT * FROM order_files WHERE id=? AND order_id=? AND removed=0").get(+fileId || 0, o.id);
  if (!f) throw httpError(404, "Not found.");
  return { path: path.join(filesDir(), String(o.id), f.file), type: f.type, name: f.name };
}
// the acceptance record: the order, the exact agreement and rights wording, every file's fingerprint and every event
export function orderRecord(user, id) {
  const o = mustSee(user, id), a = agreement();
  const evs = db().prepare("SELECT at,kind,actor,ip,ua,detail FROM order_events WHERE order_id=? ORDER BY id").all(o.id).map(e => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null }));
  const all = db().prepare("SELECT id,kind,name,size,sha256,at,removed FROM order_files WHERE order_id=? ORDER BY id").all(o.id);
  return { order: staffView(o), agreement: { version: o.agreement_version, hash: o.agreement_hash, currentVersion: a.version, currentHash: a.hash, sameAsCurrent: o.agreement_hash === a.hash },
    rights: o.rights_at ? { version: o.rights_version, hash: o.rights_hash, text: rightsStatement(o.brand).hash === o.rights_hash ? rightsStatement(o.brand).text : "(older wording: see the rights_confirmed event)" } : null,
    files: all, events: evs };
}
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ts = t => t ? new Date(t).toLocaleString("en-US", { timeZone: process.env.RECORD_TZ || "America/Chicago", dateStyle: "medium", timeStyle: "long" }) : "";
export function recordPage(user, id) {
  const r = orderRecord(user, id), o = r.order, a = agreement();
  const row = (k, v) => v ? `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>` : "";
  const evRows = r.events.map(e => `<tr><td>${esc(ts(e.at))}</td><td>${esc(e.kind.replace(/_/g, " "))}</td><td>${esc(e.actor)}</td><td>${esc(e.ip || "")}</td><td><code>${esc(e.detail ? JSON.stringify(e.detail) : "")}</code><div class="ua">${esc(e.ua || "")}</div></td></tr>`).join("");
  const fileRows = r.files.map(f => `<tr><td>${f.id}</td><td>${esc(f.kind)}</td><td>${esc(f.name)}</td><td>${f.size}</td><td><code>${esc(f.sha256)}</code></td><td>${f.removed ? "removed" : ""}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Order ${o.id} record: ${esc(o.client.name)}</title><style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#121211;max-width:1000px;margin:0 auto;padding:28px 18px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid #eee}
th{width:220px;color:#555;font-weight:600}code{font-size:12px;word-break:break-all}.ua{color:#888;font-size:11px}.agr{border:1px solid #ddd;padding:6px 18px;max-height:none}@media print{.noprint{display:none}}</style></head><body>
<p class="noprint"><button onclick="print()">Print or save as PDF</button></p>
<h1>Acceptance record: order ${o.id}</h1><p>${esc(o.brandName)} · ${esc(o.client.name)}${o.client.business ? " · " + esc(o.client.business) : ""}</p>
<h2>Order</h2><table>${row("Status", o.statusLabel)}${row("Client email", o.client.email)}${row("Client phone", o.client.phone)}${row("Package", o.package)}${row("Price", o.price)}${row("Sales agent", o.partner || "Direct (owner)")}${row("Made by", o.maker === "partner" ? "Sales agent" : "Our team")}${row("Paid", o.paid ? "Yes" : "No")}${row("Created", ts(o.created))}</table>
<h2>Agreement accepted</h2><table>${row("Accepted at", ts(o.agreedAt) || "Not yet")}${row("Typed name (signature)", o.agreedName)}${row("Agreement version", r.agreement.version)}${row("Agreement fingerprint (SHA-256)", r.agreement.hash)}${row("Same text as today's version", o.agreedAt ? (r.agreement.sameAsCurrent ? "Yes (shown below)" : "No: the text was updated later; the fingerprint identifies the version accepted") : "")}</table>
<h2>Photo rights confirmed</h2><table>${row("Confirmed at", ts(o.rightsAt) || "Not yet")}${r.rights ? row("Statement checked", r.rights.text) + row("Statement version", r.rights.version) + row("Statement fingerprint (SHA-256)", r.rights.hash) : ""}${row("Listing or source link", o.listing)}${row("OK to show as an example", o.submittedAt ? (o.portfolio ? "Yes" : "No") : "")}</table>
<h2>Files (fingerprints)</h2><table><tr><th>#</th><th>Kind</th><th>Name</th><th>Bytes</th><th>SHA-256</th><th></th></tr>${fileRows || "<tr><td colspan=6>None</td></tr>"}</table>
<h2>Every step (${esc(process.env.RECORD_TZ || "America/Chicago")} time)</h2><table><tr><th>When</th><th>What</th><th>Who</th><th>IP</th><th>Details</th></tr>${evRows}</table>
${o.agreedAt && r.agreement.sameAsCurrent ? `<h2>The agreement as accepted (version ${esc(a.version)})</h2><div class="agr">${a.html}</div>` : ""}
</body></html>`;
}

// ---------- sign-up terms and studio photo-rights checks (self-serve) ----------
export function recordTerms(userId, m) {
  const a = agreement(), { ip, ua } = meta(m);
  db().prepare("INSERT INTO terms_acks(user_id,at,version,hash,ip,ua) VALUES(?,?,?,?,?,?)").run(userId, Date.now(), a.version, a.hash, ip, ua);
}
export function recordRights(userId, kind, source, m) {
  const r = rightsStatement("studio"), { ip, ua } = meta(m);
  db().prepare("INSERT INTO rights_acks(user_id,at,kind,source,version,hash,ip,ua) VALUES(?,?,?,?,?,?,?,?)").run(userId, Date.now(), clip(kind, 20), clip(source, 500) || null, r.version, r.hash, ip, ua);
}
export { AGREEMENT_VERSION, RIGHTS_VERSION, sha256 };

// who to tell when a client moves an order along (owner always; the sales agent on their own orders)
export function alertInfo(token) {
  const o = byToken(token); if (!o) return null;
  const p = o.partner_id ? db().prepare("SELECT name,email FROM users WHERE id=?").get(o.partner_id) : null;
  return { id: o.id, brandName: BRANDS[o.brand], client: o.client_name, clientEmail: o.client_email || "", business: o.business || "", package: o.package || "",
    status: o.status, photos: files(o.id, "photo").length, listing: o.listing_url || "", note: o.review_note || "", maker: o.maker,
    partner: p ? { name: p.name || "", email: p.email } : null, rep: rep(o) };
}
