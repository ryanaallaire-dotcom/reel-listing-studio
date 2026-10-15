# Reel Listing Studio — server

Hosts the Reel Listing Studio page on your own domain and adds **paste a listing link → Import**.
The server loads the listing page, finds the full-size photos and the listing details, downloads them,
and hands them to the Studio as one ZIP: the same format the Chrome Grabber makes. The video
itself is still rendered in the user's browser, so it costs you nothing to render.

```
GET  /              the Studio
GET  /api/health    tells the Studio that link import (and AI) are available
POST /api/import    {"url": "https://..."}  →  ZIP of photos + listing.json
POST /api/ai        auto-fill, photo labels and captions, through your Anthropic API key
POST /api/clips     AI motion: turns a photo into a moving clip (fal.ai), then
GET  /api/clips/:id        and  GET /api/clips/:id/video
GET  /models/, /vendor/     the 3D depth model and the engine that runs it in the browser
```

## Run it on your computer

Needs Node.js 20 or newer.

```bash
npm install
npm start              # http://localhost:8787
npm test               # 44 checks against a fake listing site, page service, Claude API and AI video service
```

## Which links work

| Link | How it's loaded | Needs a page-service key? |
|---|---|---|
| Brokerage sites, agent sites, most MLS public pages | Directly, free | No |
| Zillow, Realtor.com, Redfin, Trulia, Homes.com, Airbnb, VRBO | Through a page service | **Yes**, otherwise the Studio tells users to use the Chrome Grabber |

These big sites block automated visitors and their terms of use prohibit scraping. A page service
(ScraperAPI, ZenRows or Bright Data) gets the page through anyway. Weigh that before launching it
publicly. The licensed route is an MLS/IDX feed (Bridge, Spark, SimplyRETS), which agents usually
need MLS approval for; it would plug in as another provider in `lib/providers.js`.
Also tell users to import only listings they have the right to market: listing photos are
copyrighted by the photographer or brokerage.

## Settings (environment variables)

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on (default 8787) |
| `SCRAPER_PROVIDER` | `scraperapi`, `zenrows` or `brightdata` — leave empty to skip protected sites |
| `SCRAPER_KEY` | That provider's API key |
| `BRIGHTDATA_ZONE` | Bright Data only: your Web Unlocker zone name |
| `ACCESS_KEY` | Optional. Require this key for imports (private beta). The Studio shows a key box. |
| `IMPORTS_PER_HOUR` | Per-visitor limit (default 20) |
| `MAX_PARALLEL_IMPORTS` | Imports running at once (default 3) |
| `MAX_PHOTOS` | Photos per listing (default 60) |
| `CACHE_HOURS` | Re-importing the same link within this window is free (default 24) |
| `TRUST_PROXY` | Set to `1` behind Render, Railway, Fly or Cloudflare so the rate limit sees real visitor IPs |
| `ANTHROPIC_API_KEY` | Turns on auto-fill, photo labels and captions (from console.anthropic.com) |
| `AI_MODEL_QUICK` / `AI_MODEL_DEFAULT` | Models used (default `claude-haiku-5-5` / `claude-sonnet-5-5`) |
| `AI_PER_HOUR` | AI requests per visitor per hour (default 60) |
| `FAL_KEY` | Turns on AI motion clips (from fal.ai → API keys) |
| `FAL_VIDEO_MODEL` | Image-to-video model (default `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, about $0.35 per 5-second clip) |
| `CLIPS_PER_HOUR` | AI clips per visitor per hour (default 30) — each clip costs you money |
| `MAX_CLIPS_PER_VIDEO` | Shown to the Studio (default 6) |

Copy `.env.example` to `.env` for local runs (`node --env-file=.env server.js`).

## Deploy

Any host that runs Node or Docker works. Easiest options:

- **Render** or **Railway**: new web service from this folder or its Git repo. Build `npm install`,
  start `npm start`, add the environment variables above, set `TRUST_PROXY=1`. About $7/month.
- **Fly.io / any Docker host**: `docker build -t reel-listing . && docker run -p 8787:8787 --env-file .env reel-listing`

Then point reellistingstudio.com at it.

## Safety built in

- Won't fetch private or internal addresses (blocks localhost, 10.x, 192.168.x, cloud metadata,
  IPv6 local), including after redirects and DNS tricks.
- Size limits on pages (15 MB) and photos (25 MB each); only real JPG, PNG and WebP photos at
  least 640 px wide are kept.
- Per-visitor hourly limit, a cap on simultaneous imports, and a 24-hour cache so repeat imports
  don't cost twice.

## Updating the Studio page

`public/index.html` is the same file as the Studio published in claude.ai. Replace it with the newest
version whenever the Studio changes. When it's served from this server the Studio detects
`/api/health` and shows the **Import listing** button; in claude.ai the button stays hidden.

## AI on your own domain

In claude.ai the Studio's AI runs on each viewer's own Claude account. On your domain it runs through
`/api/ai` with your `ANTHROPIC_API_KEY`, so you pay for it: about $0.003 per video on Haiku and about
$0.05 on Sonnet. The endpoint only does listing work (it won't act as a free chatbot), takes at most
8 photos per request, and is limited per visitor per hour. Without a key the AI buttons stay hidden.

## 3D depth (free)

`public/models/depth_q8.onnx` is Depth Anything (small, Apache 2.0), shrunk to 27 MB. The Studio
downloads it once (cached for a week) and runs it in the visitor's browser to measure how far away
everything in each photo is. Camera moves then use real parallax: near furniture moves and grows
more than far walls. No cost per video. If a browser can't run it, shots fall back to flat moves.

## AI motion (paid, per clip)

With `FAL_KEY` set, the Studio's **AI motion** option (off / top 4 / top 6 shots) sends those photos
to an image-to-video model and swaps the finished clips into the video. The Studio only sends the
photo and the kind of shot; the instructions to the model live in `lib/clips.js`, so visitors can't
use your account for anything else. Clips are made in the video shape selected at the time. Expect
2–5 minutes and about $0.35 per clip ($1.40 for 4 shots). Failed clips leave the photo as a still.

## Not in this server yet

- **Accounts and billing.**
