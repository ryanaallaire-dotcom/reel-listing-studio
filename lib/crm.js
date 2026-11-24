// Sends each new lead to the CRM (a GoHighLevel "Inbound Webhook" trigger, or any URL that takes JSON).
// Off unless GHL_WEBHOOK_URL is set (https only). Never blocks or fails the visitor's request.
const url = () => { const u = process.env.GHL_WEBHOOK_URL || ""; return /^https:\/\/[^\s]+$/i.test(u) || (process.env.ALLOW_LOCAL_FETCH === "1" && /^http:\/\/127\.0\.0\.1:\d+\//.test(u)) ? u : ""; };
export const crmEnabled = () => !!url();

const isUrl = s => /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(s);
export function crmPayload(lead, partner) {
  const biz = /^Business video/i.test(lead.package || "");
  const parts = String(lead.listing || "").split(" | ").map(s => s.trim()).filter(Boolean);
  const website = biz ? parts.find(isUrl) || "" : "";
  const business = biz ? parts.find(p => p !== website) || "" : "";
  const [first = "", ...rest] = String(lead.name || "").trim().split(/\s+/);
  const brand = biz ? "Reel Business Studio" : "Reel Listing Studio";
  const industry = biz ? String(lead.package).replace(/^Business video\s*·\s*/i, "").trim() : "Real estate";
  const tags = [biz ? "rbs-lead" : "rls-lead", biz && industry ? `industry-${industry.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "",
    lead.utm_campaign ? `campaign-${String(lead.utm_campaign).toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "", lead.offer ? "used-coupon" : ""].filter(Boolean);
  return {
    first_name: first, last_name: rest.join(" "), full_name: lead.name || "", email: lead.email || "", phone: lead.phone || "",
    brand, industry, business_name: business, website, listing: biz ? "" : lead.listing || "",
    package: lead.package || "", notes: lead.notes || "", coupon: lead.coupon || "", offer: lead.offer || "",
    utm_source: lead.utm_source || "", utm_campaign: lead.utm_campaign || "", partner: partner ? partner.name : "",
    tags: tags.join(","), source: "reellistingstudio.com", submitted_at: new Date().toISOString(),
  };
}
export async function forwardLead(lead, partner) {
  const u = url(); if (!u) return false;
  try {
    const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(crmPayload(lead, partner)), signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.error("crm webhook", r.status);
    return r.ok;
  } catch (e) { console.error("crm webhook", e.message); return false; }
}
