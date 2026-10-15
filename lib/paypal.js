// PayPal billing: monthly plans (Subscriptions API) and one-time credit top-ups (Orders API).
// The product, the three plans and the webhook are created automatically the first time the server
// starts with PayPal keys, so there's nothing to set up by hand inside PayPal.
import { plainFetch, httpError } from "./safe-fetch.js";
import { TIERS, TOPUP, PAID, setting, getUser, userBySub, setPlan, setSubStatus, applyOnce } from "./accounts.js";

const ENV = () => (process.env.PAYPAL_ENV || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
const BASE = () => process.env.PAYPAL_API_BASE || (ENV() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
export const paypalEnabled = () => !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

let tok = null;
async function token() {
  if (tok && tok.exp > Date.now() + 60e3) return tok.v;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await plainFetch(`${BASE()}/v1/oauth2/token`, { method: "POST", timeout: 30000,
    headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const j = JSON.parse(r.buf.toString("utf8") || "{}");
  if (r.status >= 400 || !j.access_token) throw httpError(502, "PayPal rejected the server's keys. Check PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_ENV.");
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
  return tok.v;
}
async function pp(method, p, body, extraHeaders = {}) {
  const r = await plainFetch(`${BASE()}${p}`, { method, timeout: 30000,
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json", ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = JSON.parse(r.buf.toString("utf8") || "{}"); } catch {}
  return { status: r.status, j };
}

// ---------- one-time setup ----------
const key = k => `paypal:${ENV()}:${k}`;
let ready = null;
export function ensureSetup() { if (!paypalEnabled()) return Promise.resolve(null); return ready ||= setup().catch(e => { ready = null; throw e; }); }
async function setup() {
  let product = setting(key("product"));
  if (!product) {
    const r = await pp("POST", "/v1/catalogs/products", { name: "Reel Listing Studio", type: "SERVICE", category: "SOFTWARE",
      description: "Cinematic listing videos with AI motion credits" }, { "paypal-request-id": `rls-product-${ENV()}` });
    if (!r.j.id) throw httpError(502, "Couldn't create the PayPal product.");
    product = r.j.id; setting(key("product"), product);
  }
  const plans = {};
  for (const tier of PAID) {
    const k = key(`plan:${tier}:${TIERS[tier].price}`); let id = setting(k);   // a price change creates a new plan
    if (!id) {
      const r = await pp("POST", "/v1/billing/plans", {
        product_id: product, name: `Reel Listing Studio ${TIERS[tier].label}`, status: "ACTIVE",
        description: `${TIERS[tier].credits} AI motion credits every month`,
        billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
          pricing_scheme: { fixed_price: { value: TIERS[tier].price, currency_code: "USD" } } }],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 2 },
      }, { "paypal-request-id": `rls-plan-${ENV()}-${tier}-${TIERS[tier].price}` });
      if (!r.j.id) throw httpError(502, `Couldn't create the PayPal ${tier} plan.`);
      id = r.j.id; setting(k, id);
    }
    plans[tier] = id;
  }
  await ensureWebhook();
  return { plans };
}
const EVENTS = ["PAYMENT.SALE.COMPLETED", "BILLING.SUBSCRIPTION.ACTIVATED", "BILLING.SUBSCRIPTION.CANCELLED", "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED", "BILLING.SUBSCRIPTION.PAYMENT.FAILED", "BILLING.SUBSCRIPTION.RE-ACTIVATED"];
async function ensureWebhook() {
  const url = process.env.PUBLIC_URL && `${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/paypal/webhook`;
  if (!url || !/^https:\/\//.test(url)) return;               // PayPal only calls https addresses
  if (process.env.PAYPAL_WEBHOOK_ID || setting(key(`webhook:${url}`))) return;
  let r = await pp("POST", "/v1/notifications/webhooks", { url, event_types: EVENTS.map(name => ({ name })) });
  let id = r.j.id;
  if (!id) { const l = await pp("GET", "/v1/notifications/webhooks"); id = (l.j.webhooks || []).find(w => w.url === url)?.id; }
  if (id) setting(key(`webhook:${url}`), id); else console.warn("PayPal webhook couldn't be registered; renewals won't refresh credits until it is.");
}
const webhookId = () => process.env.PAYPAL_WEBHOOK_ID || (process.env.PUBLIC_URL && setting(key(`webhook:${process.env.PUBLIC_URL.replace(/\/$/, "")}/api/paypal/webhook`)));

export async function clientConfig() {
  if (!paypalEnabled()) return null;
  const s = await ensureSetup();
  return { clientId: process.env.PAYPAL_CLIENT_ID, env: ENV(), plans: s.plans, topup: TOPUP };
}
const tierForPlan = async planId => { const s = await ensureSetup(); return Object.keys(s.plans).find(t => s.plans[t] === planId) || null; };
const nextBill = sub => { const t = Date.parse(sub?.billing_info?.next_billing_time || ""); return isNaN(t) ? Date.now() + 31 * 864e5 : t; };

// ---------- subscriptions ----------
export async function confirmSubscription(user, subId) {
  if (!/^I-[A-Z0-9]{6,40}$/.test(String(subId || ""))) throw httpError(400, "That doesn't look like a PayPal subscription.");
  const { status, j: sub } = await pp("GET", `/v1/billing/subscriptions/${subId}`);
  if (status >= 400) throw httpError(502, "Couldn't confirm the subscription with PayPal. If you were charged, contact support.");
  if (String(sub.custom_id) !== String(user.id)) throw httpError(403, "That subscription belongs to a different account.");
  if (!["ACTIVE", "APPROVED"].includes(sub.status)) throw httpError(402, "PayPal hasn't activated that subscription yet. Wait a minute, then refresh.");
  const tier = await tierForPlan(sub.plan_id); if (!tier) throw httpError(400, "That isn't one of our plans.");
  const old = user.sub_id && user.sub_id !== subId ? user.sub_id : null;
  applyOnce(user.id, "plan_start", subId, () => { setPlan(user.id, tier, { subId, status: "ACTIVE", periodEnd: nextBill(sub), resetCredits: true }); return TIERS[tier].credits; });
  // switching plans: stop billing the old subscription
  if (old) await pp("POST", `/v1/billing/subscriptions/${old}/cancel`, { reason: "Switched to a different plan" }).catch(() => {});
  return getUser(user.id);
}
export async function cancelSubscription(user) {
  if (!user.sub_id) throw httpError(400, "You don't have a paid plan to cancel.");
  const r = await pp("POST", `/v1/billing/subscriptions/${user.sub_id}/cancel`, { reason: "Cancelled from Reel Listing Studio" });
  if (r.status >= 400 && r.status !== 422) throw httpError(502, "PayPal couldn't cancel the plan right now. Try again, or cancel it in your PayPal account.");
  setSubStatus(user.id, "CANCELLED");                  // keeps the plan and credits until the paid month ends
  return getUser(user.id);
}

// ---------- one-time top-ups ----------
export async function createTopup(user) {
  const r = await pp("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ custom_id: String(user.id),
    description: `${TOPUP.credits} AI motion credits`, amount: { currency_code: "USD", value: TOPUP.price } }] });
  if (!r.j.id) throw httpError(502, "PayPal couldn't start the checkout. Try again in a moment.");
  return r.j.id;
}
export async function captureTopup(user, orderId) {
  if (!/^[A-Z0-9]{10,40}$/.test(String(orderId || ""))) throw httpError(400, "That doesn't look like a PayPal order.");
  let r = await pp("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { "paypal-request-id": `rls-cap-${orderId}` });
  if (r.status === 422) r = await pp("GET", `/v2/checkout/orders/${orderId}`);          // already captured: read it instead
  const o = r.j, pu = o.purchase_units?.[0], cap = pu?.payments?.captures?.[0];
  if (o.status !== "COMPLETED" || !cap || cap.status !== "COMPLETED") throw httpError(402, "PayPal didn't complete the payment. You haven't been charged.");
  if (String(pu.custom_id ?? cap.custom_id) !== String(user.id)) throw httpError(403, "That payment belongs to a different account.");
  if (cap.amount?.value !== TOPUP.price || cap.amount?.currency_code !== "USD") throw httpError(400, "That payment doesn't match the credit pack price.");
  applyOnce(user.id, "topup", orderId, db => { db.prepare("UPDATE users SET extra=extra+? WHERE id=?").run(TOPUP.credits, user.id); return TOPUP.credits; });
  return getUser(user.id);
}

// ---------- webhooks: renewals, cancellations, failed payments ----------
export async function handleWebhook(headers, event) {
  const id = webhookId(); if (!id) throw httpError(400, "Webhook isn't set up.");
  const v = await pp("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"], cert_url: headers["paypal-cert-url"], transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"], transmission_time: headers["paypal-transmission-time"], webhook_id: id, webhook_event: event });
  if (v.j.verification_status !== "SUCCESS") throw httpError(400, "Webhook signature didn't verify.");
  const res = event.resource || {}, type = event.event_type;
  if (type === "PAYMENT.SALE.COMPLETED") {
    const u = res.billing_agreement_id && userBySub(res.billing_agreement_id); if (!u) return "ignored";
    const { j: sub } = await pp("GET", `/v1/billing/subscriptions/${u.sub_id}`);
    const tier = (await tierForPlan(sub.plan_id)) || u.tier;
    // each paid month resets the monthly allowance (top-up credits are kept)
    applyOnce(u.id, "renewal", res.id, () => { setPlan(u.id, tier, { subId: u.sub_id, status: "ACTIVE", periodEnd: nextBill(sub), resetCredits: true }); return TIERS[tier].credits; });
    return "renewed";
  }
  const u = res.id && userBySub(res.id); if (!u) return "ignored";
  if (type === "BILLING.SUBSCRIPTION.ACTIVATED" || type === "BILLING.SUBSCRIPTION.RE-ACTIVATED") setSubStatus(u.id, "ACTIVE", nextBill(res));
  else if (type === "BILLING.SUBSCRIPTION.CANCELLED") setSubStatus(u.id, "CANCELLED");
  else if (type === "BILLING.SUBSCRIPTION.SUSPENDED") setSubStatus(u.id, "SUSPENDED", Date.now());
  else if (type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") setSubStatus(u.id, "PAST_DUE");   // PayPal retries; the plan ends if the paid month runs out first
  else if (type === "BILLING.SUBSCRIPTION.EXPIRED") setSubStatus(u.id, "EXPIRED", Date.now());
  return "updated";
}
