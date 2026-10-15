// Link in → ZIP out. The ZIP has the same layout as the Chrome Grabber's
// (numbered photos + listing.json), so the Studio handles both the same way.
import { zipSync } from "fflate";
import { extractListing, headerDims } from "./extract.js";
import { getListingHtml } from "./providers.js";
import { safeFetch, httpError } from "./safe-fetch.js";

const MAX_PHOTOS = +process.env.MAX_PHOTOS || 60;

async function downloadPhoto(url) {
  try {
    let r;
    try { r = await safeFetch(url, { accept: "image/avif,image/webp,image/jpeg,image/png,*/*", maxBytes: 25e6, timeout: 20000 }); }
    catch (e) { return null; }
    if (r.status !== 200) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && !/^image\//.test(ct) && !/octet-stream/.test(ct)) return null;
    if (r.buf.length < 15000) return null;
    const d = headerDims(r.buf); if (!d) return null;
    if (Math.max(d.w, d.h) < 640 || Math.min(d.w, d.h) < 360) return null;
    return { url, buf: r.buf, ...d };
  } catch { return null; }
}

export async function importListing(url, { onStep = () => {} } = {}) {
  onStep("Loading the listing page");
  const { html, via, finalUrl } = await getListingHtml(url, { extract: extractListing });
  const info = extractListing(html, finalUrl || url);
  if (!info.images.length) throw httpError(422, "We loaded the listing but couldn't find any photos on it. Try the Chrome Grabber, or upload the photos directly.");

  onStep(`Downloading ${Math.min(info.images.length, 90)} photos`);
  const cands = info.images.slice(0, 90), results = new Array(cands.length); let i = 0;
  const worker = async () => { while (i < cands.length) { const k = i++; results[k] = await downloadPhoto(cands[k]); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  const seen = new Set();
  const photos = results.filter(Boolean).filter(p => { const sig = `${p.w}x${p.h}:${p.buf.length}`; if (seen.has(sig)) return false; seen.add(sig); return true; }).slice(0, MAX_PHOTOS);
  if (!photos.length) throw httpError(422, "We found the listing's photos but couldn't download them at full size. Try the Chrome Grabber, or upload the photos directly.");

  onStep("Packing");
  const files = {};
  photos.forEach((p, k) => { files[`${String(k + 1).padStart(2, "0")}.${p.ext}`] = [new Uint8Array(p.buf), { level: 0 }]; });
  files["listing.json"] = [new TextEncoder().encode(JSON.stringify({
    source: "Reel Listing Import", version: 1, grabbedAt: new Date().toISOString(),
    url: info.url, host: info.host, title: info.title, description: info.description, jsonld: info.jsonld, text: info.text,
  }, null, 2)), { level: 6 }];
  const zip = Buffer.from(zipSync(files));
  return { zip, count: photos.length, title: info.title, via };
}
