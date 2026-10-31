// Accounts, sessions and AI credits, stored in one SQLite file.
// On Render, attach a disk at /var/data and set DB_PATH=/var/data/reel.db so accounts survive redeploys.
import { createRequire } from "node:module";
// SQLite driver: better-sqlite3 when it installed, otherwise Node's built-in sqlite (Node 22.5+)
const require_ = createRequire(import.meta.url);
let Database = null;
try { Database = require_("better-sqlite3"); } catch (e) { console.warn("better-sqlite3 unavailable, using built-in sqlite:", e.message.split("\n")[0]); }
function builtin(file) {
  const { DatabaseSync } = require_("node:sqlite");
  const d = new DatabaseSync(file);
  return { exec: q => d.exec(q), pragma: q => d.exec(`PRAGMA ${q}`), prepare: q => d.prepare(q),
    transaction: fn => (...a) => { d.exec("BEGIN IMMEDIATE"); try { const r = fn(...a); d.exec("COMMIT"); return r; } catch (e) { try { d.exec("ROLLBACK"); } catch {} throw e; } } };
}
const openFile = file => Database ? new Database(file) : builtin(file);
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { httpError } from "./safe-fetch.js";

// 1 credit = 1 AI motion shot (about $0.35 to us on fal.ai)
export const TIERS = {
  free:    { label: "Free",    price: "0",      credits: 0,   imports: 2,  watermark: true },
  starter: { label: "Starter", price: "29.00",  credits: 25,  imports: 60, watermark: false },
  pro:     { label: "Pro",     price: "79.00",  credits: 70,  imports: 200, watermark: false },
  agency:  { label: "Agency",  price: "199.00", credits: 200, imports: 600, watermark: false },
};
export const TOPUP = { price: "25.00", credits: 20 };
export const PAID = ["starter", "pro", "agency"];

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "reel.db");
export const dbPersistent = () => !!process.env.DB_PATH && dbFile === DB_PATH;
let db;
let dbFile = null;
export function openDb(file = DB_PATH) {
  // never let a storage problem take the whole site down: fall back to a local file, then to memory
  for (const f of [file, path.join(process.cwd(), "data", "reel.db"), ":memory:"]) {
    try { if (f !== ":memory:") fs.mkdirSync(path.dirname(f), { recursive: true }); db = openFile(f); dbFile = f; break; }
    catch (e) { console.error(`Couldn't open the accounts database at ${f}: ${e.message}`); }
  }
  if (dbFile !== file) console.error(`ACCOUNTS ARE NOT BEING SAVED PERMANENTLY (using ${dbFile}). On Render, attach a disk at ${path.dirname(file)}.`);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created INTEGER NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free', monthly INTEGER NOT NULL DEFAULT 0, extra INTEGER NOT NULL DEFAULT 0,
      sub_id TEXT, sub_status TEXT, period_end INTEGER, usage_month TEXT, imports_used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT, at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ledger_ref ON ledger(reason, ref) WHERE ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS setup_tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS ref_aliases (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY, created INTEGER NOT NULL, partner_id INTEGER, name TEXT, email TEXT, phone TEXT,
      listing TEXT, package TEXT, notes TEXT);`);
  // added later: partner details (older databases get the columns on start-up)
  for (const col of ["name TEXT", "phone TEXT", "partner INTEGER NOT NULL DEFAULT 0", "ref_code TEXT", "referred_by INTEGER", "ref_custom INTEGER NOT NULL DEFAULT 0"]) { try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch {} }
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_ref ON users(ref_code) WHERE ref_code IS NOT NULL"); } catch {}
  // every partner gets a random link ID (never their name); earlier name-based IDs are replaced unless the partner chose it
  for (const u of db.prepare("SELECT id,ref_code FROM users WHERE partner=1 AND ref_custom=0").all())
    if (!u.ref_code || !/^[a-z2-9]{6}$/.test(u.ref_code)) assignRefCode(db, u);
  return db;
}
export const getDb = () => db || openDb();
export const setting = (k, v) => v === undefined
  ? getDb().prepare("SELECT v FROM settings WHERE k=?").get(k)?.v
  : getDb().prepare("INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

// ---------- passwords + sessions ----------
const scrypt = (pw, salt) => crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
const hashPw = pw => { const salt = crypto.randomBytes(16); return `s1$${salt.toString("hex")}$${scrypt(pw, salt).toString("hex")}`; };
const checkPw = (pw, stored) => { const [, s, h] = String(stored).split("$"); if (!s || !h) return false;
  const a = scrypt(pw, Buffer.from(s, "hex")), b = Buffer.from(h, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const sha = t => crypto.createHash("sha256").update(t).digest("hex");
const SESSION_DAYS = 30;
const admins = () => String(process.env.ADMIN_EMAILS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
export const isAdmin = u => !!u && admins().includes(u.email);

const cleanEmail = e => String(e || "").trim().toLowerCase();
function checkCreds(email, password) {
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw httpError(400, "Enter a valid email address.");
  if (typeof password !== "string" || password.length < 8) throw httpError(400, "Use a password with at least 8 characters.");
  if (password.length > 200) throw httpError(400, "That password is too long.");
}
export function signup({ email, password, invite }) {
  email = cleanEmail(email); checkCreds(email, password);
  const code = process.env.ACCESS_KEY;
  if (code && !admins().includes(email)) {
    const a = Buffer.from(String(invite || "")), b = Buffer.from(code);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(403, "Sign-up is invite-only right now. Enter the invite code you were given.");
  }
  try {
    const r = getDb().prepare("INSERT INTO users(email,pass,created) VALUES(?,?,?)").run(email, hashPw(password), Date.now());
    return newSession(r.lastInsertRowid);
  } catch (e) { if (/UNIQUE/.test(e.message)) throw httpError(409, "There's already an account with that email. Sign in instead."); throw e; }
}
export function login({ email, password }) {
  email = cleanEmail(email);
  const u = getDb().prepare("SELECT * FROM users WHERE email=?").get(email);
  // same work whether or not the email exists, so accounts can't be discovered by timing
  const ok = u ? checkPw(String(password || ""), u.pass) : (checkPw("x", "s1$00$00"), false);
  if (!ok) throw httpError(401, "That email and password don't match.");
  return newSession(u.id);
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  getDb().prepare("INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)").run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
  getDb().prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
  return token;
}
export function logout(token) { if (token) getDb().prepare("DELETE FROM sessions WHERE token=?").run(sha(token)); }
export function changePassword(user, { current, password }) {
  if (!checkPw(String(current || ""), user.pass)) throw httpError(401, "Your current password isn't right.");
  checkCreds(user.email, password);
  getDb().prepare("UPDATE users SET pass=? WHERE id=?").run(hashPw(password), user.id);
}

export const cookieName = "rls";
export function sessionCookie(token, secure) {
  const parts = [`${cookieName}=${token || ""}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
export function tokenFrom(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${cookieName}=([A-Za-z0-9_-]{20,})`));
  return m ? m[1] : null;
}
export function userFrom(req) {
  const t = tokenFrom(req); if (!t) return null;
  const u = getDb().prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?").get(sha(t), Date.now());
  return u ? refresh(u) : null;
}
const month = () => new Date().toISOString().slice(0, 7);
// lazy housekeeping: end cancelled plans after their paid period, reset monthly import counts
function refresh(u) {
  const db = getDb();
  if (u.tier !== "free" && u.sub_status && u.sub_status !== "ACTIVE" && u.period_end && u.period_end <= Date.now()) {
    db.prepare("UPDATE users SET tier='free', monthly=0, sub_id=NULL WHERE id=?").run(u.id);
    db.prepare("INSERT INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(u.id, -u.monthly, "plan_ended", null, Date.now());
    u = { ...u, tier: "free", monthly: 0, sub_id: null };
  }
  if (u.usage_month !== month()) { db.prepare("UPDATE users SET usage_month=?, imports_used=0 WHERE id=?").run(month(), u.id); u = { ...u, usage_month: month(), imports_used: 0 }; }
  return u;
}
export const getUser = id => { const u = getDb().prepare("SELECT * FROM users WHERE id=?").get(id); return u ? refresh(u) : null; };
export const userBySub = subId => getDb().prepare("SELECT * FROM users WHERE sub_id=?").get(subId);

export function publicUser(u) {
  if (!u) return null;
  const t = TIERS[u.tier] || TIERS.free;
  return { id: u.id, email: u.email, name: u.name || null, phone: u.phone || null, partner: !!u.partner, refCode: u.partner ? u.ref_code || null : null, tier: u.tier, tierLabel: u.partner ? `${t.label} Partner` : t.label, credits: u.monthly + u.extra, monthly: u.monthly, extra: u.extra,
    monthlyAllowance: t.credits, importsLeft: Math.max(0, t.imports - u.imports_used), watermark: t.watermark && !isAdmin(u),
    subStatus: u.sub_status || null, renews: u.sub_status === "ACTIVE" ? u.period_end : null, endsAt: u.sub_status && u.sub_status !== "ACTIVE" ? u.period_end : null,
    admin: isAdmin(u) };
}

// ---------- credits ----------
// Spend from the monthly allowance first, then from top-up credits (which never expire).
export function spend(userId, n, reason, ref) {
  const db = getDb();
  return db.transaction(() => {
    const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
    if (isAdmin(u)) return { charged: 0 };
    if (u.monthly + u.extra < n) throw httpError(402, u.monthly + u.extra ? `You have ${u.monthly + u.extra} AI credit${u.monthly + u.extra === 1 ? "" : "s"} left. Add credits or upgrade your plan.` : "You're out of AI credits. Add credits or upgrade your plan to use AI motion.");
    const fromM = Math.min(u.monthly, n), fromE = n - fromM;
    db.prepare("UPDATE users SET monthly=monthly-?, extra=extra-? WHERE id=?").run(fromM, fromE, userId);
    db.prepare("INSERT INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(userId, -n, reason, ref ? `${ref}|m${fromM}e${fromE}` : null, Date.now());
    return { charged: n, fromM, fromE };
  })();
}
export function refund(userId, charge, reason, ref) {
  if (!charge || !charge.charged) return;
  const db = getDb();
  db.transaction(() => {
    const r = db.prepare("INSERT OR IGNORE INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(userId, charge.charged, reason, ref, Date.now());
    if (r.changes) db.prepare("UPDATE users SET monthly=monthly+?, extra=extra+? WHERE id=?").run(charge.fromM, charge.fromE, userId);
  })();
}
// Returns false if this payment reference was already applied (webhooks and retries can repeat).
export function applyOnce(userId, reason, ref, fn) {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare("INSERT OR IGNORE INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(userId, 0, reason, ref, Date.now());
    if (!r.changes) return false;
    const delta = fn(db) || 0;
    db.prepare("UPDATE ledger SET delta=? WHERE reason=? AND ref=?").run(delta, reason, ref);
    return true;
  })();
}
export function setPlan(userId, tier, { subId, status, periodEnd, resetCredits }) {
  getDb().prepare(`UPDATE users SET tier=?, sub_id=?, sub_status=?, period_end=?${resetCredits ? ", monthly=?" : ""} WHERE id=?`)
    .run(...[tier, subId, status, periodEnd, ...(resetCredits ? [TIERS[tier].credits] : []), userId]);
}
export function setSubStatus(userId, status, periodEnd) {
  getDb().prepare("UPDATE users SET sub_status=?, period_end=COALESCE(?,period_end) WHERE id=?").run(status, periodEnd ?? null, userId);
}
export function countImport(u) {
  if (isAdmin(u)) return;
  const t = TIERS[u.tier] || TIERS.free;
  if (u.imports_used >= t.imports) throw httpError(402, u.tier === "free"
    ? `Free accounts include ${t.imports} link imports a month. Upgrade to import more, or upload the photos yourself.`
    : `You've used this month's ${t.imports} link imports. Upload the photos yourself, or upgrade your plan.`);
  getDb().prepare("UPDATE users SET imports_used=imports_used+1 WHERE id=?").run(u.id);
}
export function uncountImport(u) { getDb().prepare("UPDATE users SET imports_used=MAX(0,imports_used-1) WHERE id=?").run(u.id); }
export function adminGrant(email, credits) {
  const u = getDb().prepare("SELECT * FROM users WHERE email=?").get(cleanEmail(email)); if (!u) throw httpError(404, "No account with that email.");
  const n = Math.max(-u.extra, Math.min(10000, Math.trunc(+credits || 0)));
  getDb().prepare("UPDATE users SET extra=extra+? WHERE id=?").run(n, u.id);
  getDb().prepare("INSERT INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(u.id, n, "admin_grant", null, Date.now());
  return publicUser(getUser(u.id));
}
export function adminList() {
  return getDb().prepare("SELECT id,email,name,phone,partner,tier,monthly,extra,sub_status,period_end,created,imports_used FROM users ORDER BY id DESC LIMIT 500").all();
}

// ---------- partner accounts (created by the owner) ----------
// Each AI video uses up to 10 AI shots plus automatic re-makes, so one "video" is budgeted as 12 credits.
export const CREDITS_PER_VIDEO = 12;
const SETUP_DAYS = 14;
const cleanPhone = p => String(p || "").replace(/[^\d+]/g, "").slice(0, 20);
// Creates the account (or upgrades an existing one), gives it the plan and videos, and returns a one-time link
// the partner opens to choose their own password. The owner never sees or sets the partner's password.
export function adminCreatePartner({ name, email, phone, tier = "agency", videos = 25 }) {
  email = cleanEmail(email);
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw httpError(400, `"${String(email).slice(0, 80)}" isn't a valid email address.`);
  if (!TIERS[tier] || tier === "free") throw httpError(400, "Pick a paid plan for partners.");
  const credits = Math.max(0, Math.min(5000, Math.trunc(+videos || 0))) * CREDITS_PER_VIDEO;
  const db = getDb();
  return db.transaction(() => {
    let u = db.prepare("SELECT * FROM users WHERE email=?").get(email), created = false;
    if (!u) {   // unusable random password until the partner sets their own
      const r = db.prepare("INSERT INTO users(email,pass,created) VALUES(?,?,?)").run(email, "setup$" + crypto.randomBytes(24).toString("hex"), Date.now());
      u = db.prepare("SELECT * FROM users WHERE id=?").get(r.lastInsertRowid); created = true;
    }
    // a complimentary plan: no PayPal subscription, never expires on its own
    db.prepare("UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone), partner=1, tier=?, sub_id=NULL, sub_status='COMP', period_end=NULL, extra=extra+? WHERE id=?")
      .run(String(name || "").trim().slice(0, 80) || null, cleanPhone(phone) || null, tier, credits, u.id);
    db.prepare("INSERT INTO ledger(user_id,delta,reason,ref,at) VALUES(?,?,?,?,?)").run(u.id, credits, "partner_grant", null, Date.now());
    if (!u.ref_code) assignRefCode(db, db.prepare("SELECT id,name,email FROM users WHERE id=?").get(u.id));
    const token = crypto.randomBytes(24).toString("hex");
    db.prepare("DELETE FROM setup_tokens WHERE user_id=?").run(u.id);
    db.prepare("INSERT INTO setup_tokens(token,user_id,expires) VALUES(?,?,?)").run(sha(token), u.id, Date.now() + SETUP_DAYS * 864e5);
    return { created, token, user: publicUser(getUser(u.id)), videos: credits / CREDITS_PER_VIDEO };
  })();
}
export function setupInfo(token) {
  const r = getDb().prepare("SELECT u.email,u.name FROM setup_tokens t JOIN users u ON u.id=t.user_id WHERE t.token=? AND t.expires>?").get(sha(String(token || "")), Date.now());
  if (!r) throw httpError(404, "This setup link has expired or was already used. Ask for a new one, or sign in.");
  return { email: r.email, name: r.name };
}
export function setupPassword({ token, password }) {
  const db = getDb(), t = db.prepare("SELECT * FROM setup_tokens WHERE token=? AND expires>?").get(sha(String(token || "")), Date.now());
  if (!t) throw httpError(404, "This setup link has expired or was already used. Ask for a new one, or sign in.");
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(t.user_id); checkCreds(u.email, password);
  db.prepare("UPDATE users SET pass=? WHERE id=?").run(hashPw(password), u.id);
  db.prepare("DELETE FROM setup_tokens WHERE user_id=?").run(u.id);
  return newSession(u.id);
}

// ---------- referral links + leads ----------
// Each partner gets a short code (e.g. "ken-george"); /r/ken-george tags the visitor for 90 days.
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";   // no look-alike characters (0/o, 1/l/i)
function assignRefCode(db, u) {
  for (let i = 0; i < 100; i++) {
    const code = Array.from(crypto.randomBytes(6), b => ID_CHARS[b % ID_CHARS.length]).join("");
    if (RESERVED.has(code) || db.prepare("SELECT 1 FROM ref_aliases WHERE code=?").get(code)) continue;
    try { db.prepare("UPDATE users SET ref_code=? WHERE id=?").run(code, u.id); return code; } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
  }
}
export const cleanRef = c => String(c || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
export function partnerByRef(code) {
  code = cleanRef(code); if (!code) return null;
  const db = getDb();
  let u = db.prepare("SELECT id,name,email,phone,ref_code FROM users WHERE ref_code=? AND partner=1").get(code);
  if (!u) { const a = db.prepare("SELECT user_id FROM ref_aliases WHERE code=?").get(code);   // an older link of theirs
    if (a) u = db.prepare("SELECT id,name,email,phone,ref_code FROM users WHERE id=? AND partner=1").get(a.user_id); }
  return u ? { id: u.id, name: u.name || "", email: u.email, phone: u.phone || "", code: u.ref_code } : null;
}
export function setReferredBy(userId, code) {
  const p = partnerByRef(code); if (!p || p.id === userId) return;
  getDb().prepare("UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL").run(p.id, userId);
}
const clip = (x, n) => String(x ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
export function addLead(body, code) {
  const name = clip(body.name, 80), email = cleanEmail(body.email).slice(0, 200), phone = clip(body.phone, 30);
  if (!name) throw httpError(400, "Add your name so we know who to contact.");
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email) && phone.replace(/\D/g, "").length < 7) throw httpError(400, "Add an email or phone number so we can reach you.");
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw httpError(400, "That email address doesn't look right.");
  const p = partnerByRef(code);
  getDb().prepare("INSERT INTO leads(created,partner_id,name,email,phone,listing,package,notes) VALUES(?,?,?,?,?,?,?,?)")
    .run(Date.now(), p ? p.id : null, name, email, phone, clip(body.listing, 500), clip(body.package, 40), clip(body.notes, 1000));
  return { partner: p ? { name: p.name, phone: p.phone, email: p.email } : null };
}
export function partnerLeads(partnerId) {
  const db = getDb();
  return {
    leads: db.prepare("SELECT id,created,name,email,phone,listing,package,notes FROM leads WHERE partner_id=? ORDER BY id DESC LIMIT 500").all(partnerId),
    signups: db.prepare("SELECT email,created,tier FROM users WHERE referred_by=? ORDER BY id DESC LIMIT 500").all(partnerId),
  };
}
export function allLeads() {
  const db = getDb();
  return {
    leads: db.prepare("SELECT l.id,l.created,l.name,l.email,l.phone,l.listing,l.package,l.notes,p.name AS partner,p.email AS partner_email FROM leads l LEFT JOIN users p ON p.id=l.partner_id ORDER BY l.id DESC LIMIT 1000").all(),
    signups: db.prepare("SELECT u.email,u.created,u.tier,p.name AS partner FROM users u JOIN users p ON p.id=u.referred_by ORDER BY u.id DESC LIMIT 1000").all(),
  };
}

// Partners can pick their own link: /r/<code>. Old codes keep working (they become aliases).
const RESERVED = new Set(["admin", "api", "agents", "media", "vendor", "models", "r", "www", "help", "support", "login", "signup", "reel", "reellistingstudio", "official", "team"]);
export function setRefCode(user, wanted) {
  const code = String(wanted || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(code)) throw httpError(400, "Use 3 to 30 letters, numbers or dashes (no spaces), starting and ending with a letter or number.");
  if (RESERVED.has(code)) throw httpError(409, "That link is reserved. Try another.");
  const db = getDb(), u = db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
  if (!u.partner) throw httpError(403, "Partner accounts only.");
  if (u.ref_code === code) return code;
  const taken = db.prepare("SELECT id FROM users WHERE ref_code=?").get(code) || db.prepare("SELECT user_id AS id FROM ref_aliases WHERE code=?").get(code);
  if (taken && taken.id !== u.id) throw httpError(409, "Someone already has that link. Try another.");
  db.transaction(() => {
    if (u.ref_code) db.prepare("INSERT OR IGNORE INTO ref_aliases(code,user_id) VALUES(?,?)").run(u.ref_code, u.id);
    db.prepare("DELETE FROM ref_aliases WHERE code=? AND user_id=?").run(code, u.id);
    db.prepare("UPDATE users SET ref_code=?, ref_custom=1 WHERE id=?").run(code, u.id);
  })();
  return code;
}
export const findUserByEmail = email => getDb().prepare("SELECT * FROM users WHERE email=?").get(cleanEmail(email));
