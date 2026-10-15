// Getting a listing page's HTML.
// Ordinary sites (brokerage and MLS pages) are fetched directly for free.
// Sites that block automated visitors (Zillow, Airbnb, Realtor.com, ...) go through a paid
// "web unblocker" provider when one is configured. Each provider is a few lines; add more here.
import { safeFetch, plainFetch, assertPublicUrl, httpError } from "./safe-fetch.js";

export const PROTECTED = /(^|\.)(zillow|airbnb|vrbo|realtor|redfin|trulia|homes|apartments|booking|expedia|hotpads)\.[a-z.]+$/i;

const PROVIDERS = {
  // https://docs.scraperapi.com  — tier 1 ≈ 10–20 credits, tier 2 (ultra premium + render) = 75 credits
  scraperapi: (url, key, tier) => {
    const q = new URLSearchParams({ api_key: key, url, country_code: "us" });
    if (tier === 1) q.set("premium", "true"); else { q.set("ultra_premium", "true"); q.set("render", "true"); }
    return { url: (process.env.SCRAPERAPI_BASE || "https://api.scraperapi.com/") + "?" + q };
  },
  // https://docs.zenrows.com
  zenrows: (url, key, tier) => {
    const q = new URLSearchParams({ apikey: key, url, premium_proxy: "true", proxy_country: "us" });
    if (tier === 2) q.set("js_render", "true");
    return { url: "https://api.zenrows.com/v1/?" + q };
  },
  // Bright Data Web Unlocker — needs BRIGHTDATA_ZONE as well
  brightdata: (url, key) => ({
    url: "https://api.brightdata.com/request",
    init: { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ zone: process.env.BRIGHTDATA_ZONE || "web_unlocker1", url, format: "raw", country: "us" }) },
  }),
};

export function providerInfo() {
  const name = (process.env.SCRAPER_PROVIDER || "").toLowerCase();
  return PROVIDERS[name] && process.env.SCRAPER_KEY ? name : null;
}

const looksBlocked = (status, html) => status === 403 || status === 429 || status === 503 ||
  /(captcha|px-captcha|perimeterx|access to this page has been denied|are you a robot|cf-chl|verify you are human|request unsuccessful)/i.test(html.slice(0, 20000));

async function viaProvider(url, tier) {
  const name = providerInfo(); if (!name) return null;
  const { url: endpoint, init } = PROVIDERS[name](url, process.env.SCRAPER_KEY, tier);
  const r = await plainFetch(endpoint, { ...(init || {}), timeout: 120000 });
  const html = r.buf.toString("utf8");
  if (r.status >= 400) throw httpError(502, `The page service (${name}) couldn't load that listing (error ${r.status}). Try again in a minute.`);
  return html;
}

// Returns { html, via } where via is "direct" or the provider name.
export async function getListingHtml(url, { needPhotos = n => n >= 3, extract } = {}) {
  const u = assertPublicUrl(url);
  const prot = PROTECTED.test(u.hostname);
  const provider = providerInfo();
  if (!prot || !provider) {
    try {
      const r = await safeFetch(u.href, { accept: "text/html,application/xhtml+xml", maxBytes: 15e6 });
      const html = r.buf.toString("utf8");
      if (!looksBlocked(r.status, html) && r.status < 400) {
        if (!prot || !provider || needPhotos(extract(html, r.url).images.length)) return { html, via: "direct", finalUrl: r.url };
      } else if (!provider) {
        throw httpError(422, prot
          ? `${u.hostname} blocks automated visitors. Add a page-service key on the server (see the README), or use the Chrome Grabber for this listing.`
          : `That site wouldn't let us load the page (error ${r.status}). Try the Chrome Grabber for this listing.`);
      }
    } catch (e) {
      if (e.status) throw e;
      if (!provider) throw httpError(prot ? 422 : 502, prot
        ? `${u.hostname} blocks automated visitors. Add a page-service key on the server (see the README), or use the Chrome Grabber for this listing.`
        : `Couldn't reach ${u.hostname}. Check the link and try again.`);
    }
  }
  // cheaper tier first, then the full browser tier if the page came back without photos
  const t1 = await viaProvider(u.href, 1);
  if (t1 && !looksBlocked(200, t1) && needPhotos(extract(t1, u.href).images.length)) return { html: t1, via: provider + ":1", finalUrl: u.href };
  const t2 = await viaProvider(u.href, 2);
  if (t2 && !looksBlocked(200, t2)) return { html: t2, via: provider + ":2", finalUrl: u.href };
  throw httpError(502, "The listing site blocked the request. Try again in a minute, or use the Chrome Grabber for this listing.");
}
