// Pull listing photos and details out of a listing page's HTML.
// Same rules as the Chrome Grabber, run on the server instead of in the browser.

const decode = s => String(s || "")
  .replace(/\\u002F/gi, "/").replace(/\\u0026/gi, "&").replace(/\\u003D/gi, "=").replace(/\\\//g, "/")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'");

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = (html.match(re) || [])[0]; if (!tag) return "";
  return decode((tag.match(/content=["']([^"']*)["']/i) || [])[1] || "").trim();
}

function visibleText(html) {
  return decode(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|p|div|li|h\d|section|tr)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " "))
    .replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// Key facts embedded in page data (Zillow, Realtor.com, Redfin and Airbnb all ship JSON in the page)
const FACT_KEYS = ["streetAddress", "addressLocality", "addressRegion", "city", "state", "zipcode", "postalCode",
  "price", "listPrice", "bedrooms", "beds", "bathrooms", "baths", "bathroomsFloat", "livingArea", "livingAreaValue", "sqft",
  "yearBuilt", "lotSize", "homeType", "propertyType", "personCapacity", "guestCount", "title", "listingTitle"];
function embeddedFacts(html) {
  const s = decode(html), out = {};
  for (const k of FACT_KEYS) {
    const m = s.match(new RegExp(`"${k}"\\s*:\\s*("([^"\\\\]{1,120})"|-?\\d+(?:\\.\\d+)?)`));
    if (m) out[k] = m[2] ?? m[1];
  }
  return out;
}

export function sizeHint(u) {
  let s = u; try { const x = new URL(u); s = x.pathname + x.search; } catch {}
  const nums = (s.match(/\d{3,4}/g) || []).map(Number).filter(n => n >= 200 && n <= 6000);
  let score = nums.length ? Math.max(...nums) : 0;
  if (/thumb|small|tiny|mini|genmid/i.test(s)) score -= 10000;
  if (/original|xxl|xl|large|bigphoto|full|hires|uncropped/i.test(s)) score += 7000;
  return score;
}

// Upgrade each photo URL to its largest version and collapse size variants of the same photo.
export function normalize(list) {
  const out = new Map();
  for (const raw of list) {
    let url; try { url = new URL(raw); } catch { continue; }
    const h = url.hostname.toLowerCase(), p = url.pathname.toLowerCase(), full = p + url.search.toLowerCase();
    if (/\.svg|\.gif|sprite|logo|icon|avatar|badge|favicon|staticmap|static-map|maps\.googleapis|maps\.gstatic|placeholder|blank\.|pixel|tracking|1x1|emoji|flag/.test(full) || /maps\.google|gstatic|doubleclick|facebook\.|googletagmanager/.test(h)) continue;
    let key = h + p;
    if (/muscache\.com$/.test(h)) {
      if (!/\/pictures\//.test(p) || /\/user\/|airbnb-platform-assets|\/users\//.test(p)) continue;
      url.search = "?im_w=1920"; key = "mc:" + p;
    } else if (/zillowstatic\.com$/.test(h)) {
      const mm = url.pathname.match(/\/fp\/([a-f0-9]+)-/i); if (!mm) continue;
      url.pathname = `/fp/${mm[1]}-uncropped_scaled_within_1536_1152.jpg`; url.search = ""; key = "z:" + mm[1];
    } else if (/rdcpix\.com$/.test(h)) {
      url.pathname = url.pathname.replace(/-w\d+_h\d+(_[a-z0-9]+)?/i, "");
      key = "r:" + url.pathname.toLowerCase().replace(/[a-z]{1,2}(\.[a-z]+)$/, "");
    } else {
      key = h + p.replace(/[-_.](\d{2,4}x\d{2,4}|w\d{2,4}|h\d{2,4}|small|thumb(nail)?|medium|large|xl|xxl|mid|genmid|bigphoto)(?=[-_.])/g, "");
      if (/trvl-media|vrbo|expedia|homeaway/.test(h)) url.search = "";
    }
    const href = url.href;
    if (!out.has(key) || sizeHint(href) > sizeHint(out.get(key))) out.set(key, href);
  }
  return [...out.values()];
}

export function extractListing(html, pageUrl) {
  const base = new URL(pageUrl);
  const urls = [], seen = new Set();
  const add = u => {
    if (!u) return; u = decode(u).trim();
    if (u.startsWith("//")) u = base.protocol + u;
    try { u = new URL(u, base).href; } catch { return; }
    if (!/^https?:/.test(u) || seen.has(u)) return; seen.add(u); urls.push(u);
  };
  add(metaContent(html, "og:image")); add(metaContent(html, "twitter:image"));
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of ["src", "data-src", "data-original", "data-lazy", "data-url"]) { const v = (tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i")) || [])[1]; if (v) add(v); }
    const ss = (tag.match(/\b(?:data-)?srcset=["']([^"']+)["']/i) || [])[1]; if (ss) ss.split(",").forEach(x => add(x.trim().split(/\s+/)[0]));
  }
  const body = decode(html);
  let n = 0;
  for (const m of body.matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:jpe?g|png|webp)(?:\?[^"'\s<>\\]*)?/gi)) { add(m[0]); if (++n > 8000) break; }
  for (const m of body.matchAll(/https?:\/\/a\d\.muscache\.com\/im\/pictures\/[^"'\s<>\\]+/gi)) add(m[0]);

  const jsonld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).join("\n").slice(0, 30000);
  const facts = embeddedFacts(html);
  const factLine = Object.keys(facts).length ? "Listing facts: " + Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("; ") + "\n\n" : "";
  const title = metaContent(html, "og:title") || decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();
  return {
    url: base.href, host: base.hostname, title: title.slice(0, 300),
    description: (metaContent(html, "og:description") || metaContent(html, "description")).slice(0, 3000),
    jsonld, text: (factLine + visibleText(html)).slice(0, 20000), facts,
    images: normalize(urls).slice(0, 120),
  };
}

// Image size from the file header, without decoding the image
export function headerDims(b) {
  try {
    if (b[0] === 0xFF && b[1] === 0xD8) { let i = 2; while (i + 9 < b.length) { if (b[i] !== 0xFF) { i++; continue; } const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: (b[i + 7] << 8) | b[i + 8], h: (b[i + 5] << 8) | b[i + 6], ext: "jpg" };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]); } }
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ext: "png" };
    if (b.toString("ascii", 8, 12) === "WEBP") { const t = b.toString("ascii", 12, 16);
      if (t === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, ext: "webp" };
      if (t === "VP8L") { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, ext: "webp" }; }
      if (t === "VP8X") return { w: (b[24] | b[25] << 8 | b[26] << 16) + 1, h: (b[27] | b[28] << 8 | b[29] << 16) + 1, ext: "webp" }; }
  } catch {}
  return null;
}
