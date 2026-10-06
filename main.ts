// 417am.party -- one record of 417am's work, in two eras on one page:
//   era "now"   2026-      new pieces, posted through /api/post (and by hand at /upload)
//   era "bot"   2017-2019  the original @417am1975 Twitter bot archive (read-only seed)
//
// Single-file Deno + Hono app, smallweb style. No build step.
//
// Data (two files, on purpose -- see README "Data"):
//   data/art.json        the bot-era archive. Committed, READ-ONLY at runtime. Never rewritten.
//   $LIVE_MANIFEST       the new work (default ./data/live/now.json, gitignored; on the VPS
//                        /data2/417am-data/now.json, outside the repo, so a deploy's
//                        `git reset --hard` can never wipe it).
//
// Routes:
//   GET  /               the record: era "now" on top, then the bot archive
//   GET  /p/:slug         one piece (permalink, og:image)
//   GET  /rss.xml         RSS 2.0, era "now" only, live entries only
//   GET  /feed.json       JSON Feed 1.1, same items
//   GET  /upload          basic-auth upload form (UPLOAD_PASSWORD)
//   POST /upload          basic-auth, Cloudinary 417am/uploads, kind "upload"
//   POST   /api/post            Bearer POST_TOKEN: multipart {image, id, kind, date?, publish_at?}
//   DELETE /api/post/:id        Bearer: remove from the manifest (Cloudinary asset is kept)
//   PATCH  /api/post/:id        Bearer: JSON {publish_at: iso|null} (reschedule a drip item)
//   GET    /api/schedule        Bearer: every era-"now" entry incl. not-yet-public ones
//
// PRIVACY: new entries carry image, date and kind only. Never prompts, recipes, note names
// or piece names. The poster's `id` is private: used only for idempotency + removal, never
// rendered; public URLs use a random `slug`. PNG text/exif chunks are stripped before upload
// (generated PNGs embed their prompt). Entries with a future `publish_at` are invisible
// everywhere public (page, permalink, feeds) until that moment.
//
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, UPLOAD_PASSWORD,
//      POST_TOKEN (fail closed if unset), LIVE_MANIFEST, SITE_URL, PORT (8417)

import { Hono } from "jsr:@hono/hono";

const ARCHIVE_PATH = new URL("./data/art.json", import.meta.url);
const LIVE_PATH = Deno.env.get("LIVE_MANIFEST") ||
  new URL("./data/live/now.json", import.meta.url).pathname;
const SITE = (Deno.env.get("SITE_URL") || "https://417am.party").replace(/\/$/, "");
const TZ = "America/New_York";
// Self-hosted Umami (umami.tools.ejfox.com). Unset = no script, no tracking.
const UMAMI_ID = (Deno.env.get("UMAMI_WEBSITE_ID") || "").trim();
const UMAMI_TAG = /^[0-9a-f-]{36}$/i.test(UMAMI_ID)
  ? `<script defer src="https://umami.tools.ejfox.com/script.js" data-website-id="${UMAMI_ID}"></script>`
  : "";
// Fires once when §2 (the bot era) scrolls into view.
const UMAMI_DIVIDER = UMAMI_TAG
  ? `<script>(function(){var d=document.getElementById("bot-era");if(!d||!("IntersectionObserver" in window))return;
var o=new IntersectionObserver(function(es){if(es.some(function(e){return e.isIntersecting})&&window.umami){
window.umami.track("archive-divider-view");o.disconnect();}});o.observe(d);})();</script>`
  : "";

type Era = "bot" | "now";
type Kind = "flux" | "studio" | "bot" | "upload";

type Entry = {
  id: string;
  slug?: string; // public, random; era "now" only
  era: Era;
  kind: Kind;
  url: string;
  date: string; // the piece's own date (when it was made)
  caption?: string; // archive + /upload only; never set for flux/studio
  posted_at?: string;
  publish_at?: string; // drip: hidden until this moment
  public_id?: string;
  width?: number;
  height?: number;
  bytes?: number;
  format?: string;
};

type Numbered = Entry & { no: number };

// ---- data ---------------------------------------------------------------------

let archiveCache: Entry[] | null = null;

async function readArchive(): Promise<Entry[]> {
  if (archiveCache) return archiveCache;
  try {
    const raw: { url: string; caption: string; date: string }[] = JSON.parse(
      await Deno.readTextFile(ARCHIVE_PATH),
    );
    archiveCache = raw.map((e) => ({
      id: "bot:" + e.url.split("/upload/").pop(),
      era: "bot" as Era,
      kind: "bot" as Kind,
      url: e.url,
      caption: e.caption,
      date: e.date,
    }));
  } catch (err) {
    console.error("archive read failed", err);
    return [];
  }
  return archiveCache;
}

async function readLive(): Promise<Entry[]> {
  try {
    return JSON.parse(await Deno.readTextFile(LIVE_PATH));
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err; // a corrupt manifest must not look empty (a write would then wipe it)
  }
}

// All writes go through one queue, and land atomically (tmp + rename).
let writeChain: Promise<unknown> = Promise.resolve();
function mutateLive<T>(fn: (entries: Entry[]) => T | Promise<T>): Promise<T> {
  const run = writeChain.then(async () => {
    const entries = await readLive();
    const out = await fn(entries);
    const dir = LIVE_PATH.replace(/\/[^/]*$/, "");
    await Deno.mkdir(dir, { recursive: true });
    const tmp = `${LIVE_PATH}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, JSON.stringify(entries, null, 2) + "\n");
    await Deno.rename(tmp, LIVE_PATH);
    return out;
  });
  writeChain = run.catch(() => {});
  return run;
}

const publicAt = (e: Entry) => Date.parse(e.publish_at || e.posted_at || e.date);
const isLive = (e: Entry, now = Date.now()) => publicAt(e) <= now;

// The whole public record, numbered as one body of work: bot pieces by date (no. 1 = the
// oldest), then new pieces in the order they went public. Newest first within each era.
async function record(): Promise<{ now: Numbered[]; bot: Numbered[] }> {
  const t = Date.now();
  const bot = [...(await readArchive())].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const now = (await readLive())
    .filter((e) => e.era === "now" && e.slug && isLive(e, t))
    .sort((a, b) => publicAt(a) - publicAt(b));
  let n = 0;
  const nb = bot.map((e) => ({ ...e, no: ++n }));
  const nn = now.map((e) => ({ ...e, no: ++n }));
  return { now: nn.reverse(), bot: nb.reverse() };
}

function newSlug(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- Cloudinary signed upload (raw REST + Web Crypto SHA-1) ------------------------

async function sha1Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

type CldResult = {
  secure_url: string;
  public_id: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
};

async function uploadToCloudinary(file: Blob, folder: string): Promise<CldResult> {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) throw new Error("Missing CLOUDINARY_* env vars");

  const timestamp = Math.floor(Date.now() / 1000);
  // Signature = sha1(sorted params, excluding file/api_key/signature, + secret)
  const signature = await sha1Hex(`folder=${folder}&timestamp=${timestamp}${apiSecret}`);
  const form = new FormData();
  form.set("file", file);
  form.set("api_key", apiKey);
  form.set("timestamp", String(timestamp));
  form.set("folder", folder);
  form.set("signature", signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

// Cloudinary delivery transform: insert `t` after /upload/.
function cld(url: string, t: string): string {
  return url.includes("/upload/") ? url.replace("/upload/", `/upload/${t}/`) : url;
}

// What the page shows. Studio pieces are 1-bit/3-level dithers: always lossless PNG, the
// browser scales them with image-rendering: pixelated. Flux: best-quality auto format.
function displayUrl(e: Entry): string {
  if (e.kind === "studio") return cld(e.url, "f_png");
  if (e.kind === "flux") return cld(e.url, "f_auto,q_auto:best");
  return e.url;
}

// Social cards / feed readers: a sane size. Studio stays PNG (crisp), the rest -> jpg.
function shareUrl(e: Entry): string {
  if (e.kind === "studio") return cld(e.url, "c_limit,w_1600,f_png");
  return cld(e.url, "c_limit,w_1600,f_jpg,q_90");
}

// ---- PNG metadata strip ---------------------------------------------------------------
// Keep only the chunks needed to draw the image (drops tEXt/iTXt/zTXt/eXIf/tIME/...).

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "sBIT", "pHYs"]);

function isPng(b: Uint8Array): boolean {
  return b.length > 8 && PNG_SIG.every((v, i) => b[i] === v);
}

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let off = 8;
  while (off + 12 <= b.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    const end = off + 12 + len;
    if (end > b.length) throw new Error("truncated PNG");
    if (KEEP.has(type)) parts.push(b.subarray(off, end));
    off = end;
    if (type === "IEND") break;
  }
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- auth -----------------------------------------------------------------------------

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="417am"' },
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function checkBasicAuth(req: Request): boolean {
  const password = Deno.env.get("UPLOAD_PASSWORD");
  if (!password) return false; // fail closed if unset
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    return safeEqual(decoded.slice(decoded.indexOf(":") + 1), password);
  } catch {
    return false;
  }
}

function checkBearer(req: Request): boolean {
  const token = Deno.env.get("POST_TOKEN");
  if (!token || token.length < 32) return false; // fail closed if unset/weak
  const header = req.headers.get("authorization") || "";
  return header.startsWith("Bearer ") && safeEqual(header.slice(7).trim(), token);
}

// ---- HTML -----------------------------------------------------------------------------
// Brutalist-academic: one monospace stack, ONE font size, one line-height, flat black /
// off-white / one grey for rules. No gradients, shadows, radii, hover effects or animation.
// Hierarchy from position, case, weight and 1px rules only.

const GLYPH: Record<Kind, string> = { flux: "●", studio: "■", upload: "○", bot: "◇" };

const NOW_PROSE =
  "417am, continued. New generative pieces, added as they are chosen; the newest is first. " +
  "Two kinds: ● flux, painterly images; ■ studio, 1-bit dithered renders.";
const BOT_PROSE =
  "A generative Twitter bot that tweeted randomized art every hour for a couple of years. " +
  "I would write a new art script after work to unwind and drop it in a folder; the bot ran " +
  "it with a fresh set of random numbers and tweeted whatever came out.";
const FEED_DESC =
  "417am is EJ Fox's generative art project. It began in 2017 as @417am1975, a Twitter bot " +
  "that tweeted his after-work art scripts every hour with fresh random numbers; that archive " +
  "lives on the site. This feed carries only the new work, 2026 onward.";

const PAGE_STYLES = `
  :root { color-scheme: dark; --bg: #000; --fg: #e8e8e8; --mid: #6b6b6b; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html {
    background: var(--bg); color: var(--fg);
    font-family: ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", monospace;
    font-size: 14px; line-height: 1.5;
    -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  }
  body { background: var(--bg); }
  h1, h2, p, figcaption, input, button, label, time { font: inherit; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
  .wrap { padding: 0 16px; }
  @media (min-width: 900px) { .wrap { padding: 0 32px; } }
  .rule { border-top: 1px solid var(--mid); }
  .head { padding: 32px 0 16px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 2ch; }
  .head h1 { font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .mid { color: var(--mid); }
  .sec { padding: 48px 0 16px; }
  .sec h2 { font-weight: 700; }
  .sec p { margin-top: 8px; max-width: 72ch; }
  .break { margin-top: 64px; border-top: 1px solid var(--fg); }
  .grid {
    display: grid; grid-template-columns: 1fr;
    border-top: 1px solid var(--mid); border-left: 1px solid var(--mid);
  }
  @media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
  figure { border-right: 1px solid var(--mid); border-bottom: 1px solid var(--mid); }
  figure img { display: block; width: 100%; height: auto; }
  img.crisp { image-rendering: crisp-edges; image-rendering: pixelated; }
  figcaption { padding: 8px 12px 12px; border-top: 1px solid var(--mid); }
  figcaption a { text-decoration: none; }
  figcaption a:hover { text-decoration: underline; }
  .empty { padding: 16px 0 32px; color: var(--mid); }
  .colophon { padding: 48px 0 64px; }
  .colophon p { margin-top: 8px; max-width: 72ch; }
  .piece { padding: 16px 0 48px; }
  .piece img { display: block; max-width: 100%; max-height: 88vh; width: auto; height: auto; margin: 0 auto; }
  .piece p { margin-top: 12px; }
  form.post { max-width: 48ch; padding: 32px 0; display: grid; gap: 16px; }
  label { display: block; margin-bottom: 4px; color: var(--mid); }
  input[type="text"], input[type="file"] {
    width: 100%; padding: 8px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--mid); border-radius: 0;
  }
  button {
    padding: 8px; background: var(--fg); color: var(--bg); border: none; border-radius: 0;
    cursor: pointer; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  }
  .msg { padding-top: 16px; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function localDay(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d);
}

const pad = (n: number) => String(n).padStart(4, "0");

type Meta = { title: string; description: string; url: string; image?: string };

function layout(meta: Meta, body: string): string {
  const m = (p: string, v: string) => `<meta property="${p}" content="${escapeHtml(v)}">`;
  const n = (p: string, v: string) => `<meta name="${p}" content="${escapeHtml(v)}">`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(meta.title)}</title>
  ${n("description", meta.description)}
  <link rel="canonical" href="${escapeHtml(meta.url)}">
  <link rel="alternate" type="application/rss+xml" title="417am.party" href="${SITE}/rss.xml">
  <link rel="alternate" type="application/feed+json" title="417am.party" href="${SITE}/feed.json">
  ${m("og:site_name", "417am.party")}
  ${m("og:type", "website")}
  ${m("og:title", meta.title)}
  ${m("og:description", meta.description)}
  ${m("og:url", meta.url)}
  ${meta.image ? m("og:image", meta.image) : ""}
  ${n("twitter:card", meta.image ? "summary_large_image" : "summary")}
  ${n("twitter:title", meta.title)}
  ${n("twitter:description", meta.description)}
  ${meta.image ? n("twitter:image", meta.image) : ""}
  <style>${PAGE_STYLES}</style>
  ${UMAMI_TAG}
</head>
<body><div class="wrap">${body}</div>${UMAMI_DIVIDER}</body>
</html>`;
}

function siteHead(right = `<span class="mid">a record of generative work, 2017&ndash;</span>`): string {
  return `<header class="head"><h1><a href="/">417am.party</a></h1>${right}</header>`;
}

function dims(e: Entry): string {
  return e.width && e.height ? ` width="${e.width}" height="${e.height}"` : "";
}

function nowFigure(e: Numbered): string {
  const day = localDay(e.date);
  const cap = e.kind === "upload" && e.caption ? ` &middot; ${escapeHtml(e.caption)}` : "";
  return `<figure id="no-${e.no}">
      <a href="/p/${e.slug}" data-umami-event="permalink-open"><img src="${escapeHtml(displayUrl(e))}" loading="lazy" decoding="async"${dims(e)}
        ${e.kind === "studio" ? 'class="crisp" ' : ""}alt="417am no. ${pad(e.no)}, ${e.kind}, ${day}"></a>
      <figcaption><a href="/p/${e.slug}" data-umami-event="permalink-open">no.${pad(e.no)}</a> &middot; ${GLYPH[e.kind]} ${e.kind} &middot; <time datetime="${escapeHtml(e.date)}">${day}</time>${cap}</figcaption>
    </figure>`;
}

function botFigure(e: Numbered): string {
  const d = new Date(e.date);
  const day = isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  return `<figure id="no-${e.no}">
      <img src="${escapeHtml(e.url)}" loading="lazy" decoding="async" alt="417am no. ${pad(e.no)}, @417am1975, ${day}">
      <figcaption>no. ${pad(e.no)} &middot; <time datetime="${escapeHtml(e.date)}">${day}</time> &middot; <span class="mid">${escapeHtml(e.caption || "")}</span></figcaption>
    </figure>`;
}

function galleryPage(now: Numbered[], bot: Numbered[]): string {
  const hero = now[0] ? shareUrl(now[0]) : bot[0]?.url;
  const nowBlock = now.length
    ? `<div class="grid">${now.map(nowFigure).join("\n")}</div>`
    : `<p class="empty">◇ no new pieces yet. the first ones arrive soon.</p>`;
  return layout(
    {
      title: "417am.party",
      description: "417am, EJ Fox's generative art project: new work from 2026, and the original @417am1975 bot archive (2017-2019).",
      url: SITE + "/",
      image: hero,
    },
    `${siteHead()}
    <section>
      <div class="sec rule">
        <h2>§1 &nbsp;417am, 2026&ndash;</h2>
        <p>${escapeHtml(NOW_PROSE)}</p>
      </div>
      ${nowBlock}
    </section>
    <section>
      <div class="break" id="bot-era"></div>
      <div class="sec">
        <h2>§2 &nbsp;417am, 2017&ndash;2019 &middot; the original @417am1975 bot</h2>
        <p>${escapeHtml(BOT_PROSE)} <a href="https://x.com/417am1975" data-umami-event="outbound" data-umami-event-url="https://x.com/417am1975">x.com/417am1975</a></p>
      </div>
      <div class="grid">${bot.map(botFigure).join("\n")}</div>
    </section>
    <footer class="colophon">
      <h2>§3 &nbsp;colophon</h2>
      <p>417am is the generative art project of EJ Fox. It began in 2017 as @417am1975, an
      hourly Twitter bot that ran his after-work scripts with fresh random numbers (§2), and
      resumed in 2026 (§1). Entries are numbered as one body of work, oldest first. Dates are
      the day each piece was made, Eastern time.</p>
      <p>Feeds carry the new work only: <a href="/rss.xml" data-umami-event="rss-click">rss</a>, <a href="/feed.json" data-umami-event="feed-json-click">json feed</a>.
      More at <a href="https://ejfox.com" data-umami-event="outbound" data-umami-event-url="https://ejfox.com">ejfox.com</a>.</p>
    </footer>`,
  );
}

function piecePage(e: Numbered): string {
  const day = localDay(e.date);
  const title = `417am no. ${pad(e.no)} · ${e.kind} · ${day}`;
  return layout(
    { title, description: `417am no. ${pad(e.no)}, a ${e.kind} piece, ${day}.`, url: `${SITE}/p/${e.slug}`, image: shareUrl(e) },
    `${siteHead(`<a href="/#no-${e.no}">the full record</a>`)}
    <div class="piece rule">
      <a href="${escapeHtml(e.url)}" data-umami-event="image-open"><img src="${escapeHtml(displayUrl(e))}"${dims(e)} ${e.kind === "studio" ? 'class="crisp" ' : ""}alt="417am no. ${pad(e.no)}, ${e.kind}, ${day}"></a>
      <p>no. ${pad(e.no)} &middot; ${GLYPH[e.kind]} ${e.kind} &middot; <time datetime="${escapeHtml(e.date)}">${day}</time> &middot; <a href="${escapeHtml(e.url)}" data-umami-event="image-open">full size</a></p>
    </div>`,
  );
}

function uploadPage(message?: { ok: boolean; text: string }): string {
  const msg = message ? `<p class="msg">${message.ok ? "◆" : "◇"} ${escapeHtml(message.text)}</p>` : "";
  return layout(
    { title: "post · 417am.party", description: "post", url: SITE + "/upload" },
    `${siteHead(`<a href="/">the record</a>`)}
    <div class="rule">${msg}
    <form class="post" method="post" enctype="multipart/form-data" action="/upload">
      <div>
        <label for="image">image</label>
        <input type="file" id="image" name="image" accept="image/*" required>
      </div>
      <div>
        <label for="caption">caption (optional, shown on the site)</label>
        <input type="text" id="caption" name="caption" maxlength="280">
      </div>
      <button type="submit">post it</button>
    </form></div>`,
  );
}

// ---- feeds ----------------------------------------------------------------------------

const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

function itemHtml(e: Numbered): string {
  // No inline style: readers strip it and the W3C validator flags it. Studio stays a PNG.
  return `<p><a href="${SITE}/p/${e.slug}"><img src="${xml(shareUrl(e))}" alt="417am no. ${pad(e.no)}, ${e.kind}, ${localDay(e.date)}"></a></p>`;
}

const itemTitle = (e: Numbered) => `no. ${pad(e.no)} · ${GLYPH[e.kind]} ${e.kind} · ${localDay(e.date)}`;
const guid = (e: Entry) => `417am.party:${e.slug}`;

function rss(items: Numbered[]): string {
  const built = items[0] ? new Date(publicAt(items[0])) : new Date();
  const body = items.map((e) => {
    const mime = e.kind === "studio" ? "image/png" : "image/jpeg";
    return `    <item>
      <title>${xml(itemTitle(e))}</title>
      <link>${SITE}/p/${e.slug}</link>
      <guid isPermaLink="false">${guid(e)}</guid>
      <pubDate>${new Date(publicAt(e)).toUTCString()}</pubDate>
      <description>${xml(itemHtml(e))}</description>
      <content:encoded><![CDATA[${itemHtml(e)}]]></content:encoded>
      <media:content url="${xml(shareUrl(e))}" medium="image" type="${mime}"/>
    </item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>417am.party</title>
    <link>${SITE}/</link>
    <description>${xml(FEED_DESC)}</description>
    <language>en</language>
    <lastBuildDate>${built.toUTCString()}</lastBuildDate>
    <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
${body}
  </channel>
</rss>
`;
}

function jsonFeed(items: Numbered[]) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "417am.party",
    home_page_url: SITE + "/",
    feed_url: SITE + "/feed.json",
    description: FEED_DESC,
    language: "en",
    authors: [{ name: "EJ Fox", url: "https://ejfox.com" }],
    items: items.map((e) => ({
      id: guid(e),
      url: `${SITE}/p/${e.slug}`,
      title: itemTitle(e),
      content_html: itemHtml(e),
      image: shareUrl(e),
      date_published: new Date(publicAt(e)).toISOString(),
    })),
  };
}

// ---- app ------------------------------------------------------------------------------

const app = new Hono();

app.get("/", async (c) => {
  const { now, bot } = await record();
  c.header("Cache-Control", "public, max-age=60");
  return c.html(galleryPage(now, bot));
});

app.get("/p/:slug", async (c) => {
  const e = (await record()).now.find((x) => x.slug === c.req.param("slug"));
  if (!e) return c.text("not found", 404);
  c.header("Cache-Control", "public, max-age=300");
  return c.html(piecePage(e));
});

app.get("/rss.xml", async (c) => {
  const items = (await record()).now.slice(0, 50);
  return c.body(rss(items), 200, {
    "Content-Type": "application/rss+xml; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/feed.json", async (c) => {
  const items = (await record()).now.slice(0, 50);
  return c.body(JSON.stringify(jsonFeed(items), null, 2), 200, {
    "Content-Type": "application/feed+json; charset=utf-8",
    "Cache-Control": "public, max-age=300",
  });
});

app.get("/upload", (c) => {
  if (!checkBasicAuth(c.req.raw)) return unauthorized();
  return c.html(uploadPage());
});

app.post("/upload", async (c) => {
  if (!checkBasicAuth(c.req.raw)) return unauthorized();
  try {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.html(uploadPage({ ok: false, text: "Invalid form submission." }), 400);
    }
    const file = form.get("image");
    const caption = String(form.get("caption") || "").slice(0, 280);
    if (!(file instanceof File) || file.size === 0) {
      return c.html(uploadPage({ ok: false, text: "No image selected." }), 400);
    }
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (isPng(bytes)) bytes = stripPng(bytes);
    const r = await uploadToCloudinary(new Blob([bytes], { type: file.type }), "417am/uploads");
    const nowIso = new Date().toISOString();
    await mutateLive((entries) => {
      entries.unshift({
        id: "upload:" + r.public_id,
        slug: newSlug(),
        era: "now",
        kind: "upload",
        url: r.secure_url,
        caption,
        date: nowIso,
        posted_at: nowIso,
        public_id: r.public_id,
        width: r.width,
        height: r.height,
        bytes: r.bytes,
        format: r.format,
      });
    });
    return c.html(uploadPage({ ok: true, text: "Posted. Check the record." }));
  } catch (err) {
    console.error(err);
    const text = err instanceof Error ? err.message : "Upload failed";
    return c.html(uploadPage({ ok: false, text }), 500);
  }
});

// ---- posting API ----------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const API_KINDS = new Set(["flux", "studio"]);
const MAX_UPLOAD = 9 * 1024 * 1024; // Cloudinary free plan image cap is 10 MB
const inFlight = new Set<string>();

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

app.post("/api/post", async (c) => {
  if (!checkBearer(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.json({ error: "expected multipart/form-data" }, 400);
  }
  const id = String(form.get("id") || "");
  const kind = String(form.get("kind") || "");
  const file = form.get("image");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  if (!API_KINDS.has(kind)) return c.json({ error: "kind must be flux|studio" }, 400);
  if (!(file instanceof File) || file.size === 0) return c.json({ error: "no image" }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: "image over 9 MB" }, 413);
  const pubRaw = form.get("publish_at");
  const publish_at = pubRaw ? isoOrNull(pubRaw) : null;
  if (pubRaw && !publish_at) return c.json({ error: "bad publish_at" }, 400);
  const nowIso = new Date().toISOString();
  const date = isoOrNull(form.get("date")) || nowIso;

  const existing = (await readLive()).find((e) => e.id === id);
  if (existing) {
    return c.json({ ok: true, existed: true, slug: existing.slug, publish_at: existing.publish_at ?? null });
  }
  if (inFlight.has(id)) return c.json({ error: "already posting this id" }, 409);
  inFlight.add(id);
  try {
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPng(bytes)) return c.json({ error: "PNG only" }, 415);
    bytes = stripPng(bytes);
    const r = await uploadToCloudinary(new Blob([bytes], { type: "image/png" }), `417am/now/${kind}`);
    const entry: Entry = {
      id,
      slug: newSlug(),
      era: "now",
      kind: kind as Kind,
      url: r.secure_url,
      date,
      posted_at: nowIso,
      ...(publish_at ? { publish_at } : {}),
      public_id: r.public_id,
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      format: r.format,
    };
    const stored = await mutateLive((entries) => {
      const dup = entries.find((e) => e.id === id);
      if (dup) return dup;
      entries.unshift(entry);
      return entry;
    });
    console.log(`api post ${kind} ${stored.slug}${publish_at ? " at " + publish_at : ""}`);
    return c.json(
      { ok: true, existed: stored !== entry, slug: stored.slug, publish_at: stored.publish_at ?? null },
      201,
    );
  } catch (err) {
    console.error("api post failed", err);
    return c.json({ error: "upload failed" }, 502);
  } finally {
    inFlight.delete(id);
  }
});

app.delete("/api/post/:id", async (c) => {
  if (!checkBearer(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const removed = await mutateLive((entries) => {
    const i = entries.findIndex((e) => e.id === id && e.era === "now");
    return i < 0 ? null : entries.splice(i, 1)[0];
  });
  if (!removed) return c.json({ ok: true, removed: false }, 404);
  console.log(`api delete ${removed.kind} ${removed.slug} (cloudinary ${removed.public_id} kept)`);
  return c.json({ ok: true, removed: true, public_id: removed.public_id });
});

app.patch("/api/post/:id", async (c) => {
  if (!checkBearer(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  let body: { publish_at?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON" }, 400);
  }
  const at = body.publish_at === null ? null : isoOrNull(body.publish_at);
  if (body.publish_at !== null && !at) return c.json({ error: "bad publish_at" }, 400);
  const e = await mutateLive((entries) => {
    const x = entries.find((y) => y.id === id && y.era === "now");
    if (!x) return null;
    if (at) x.publish_at = at;
    else delete x.publish_at;
    return x;
  });
  if (!e) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, publish_at: e.publish_at ?? null });
});

app.get("/api/schedule", async (c) => {
  if (!checkBearer(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  const now = Date.now();
  const rows = (await readLive())
    .filter((e) => e.era === "now")
    .sort((a, b) => publicAt(a) - publicAt(b))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      slug: e.slug,
      date: e.date,
      public_at: new Date(publicAt(e)).toISOString(),
      live: isLive(e, now),
    }));
  c.header("Cache-Control", "no-store");
  return c.json(rows);
});

const port = Number(Deno.env.get("PORT") || 8417);
console.log(`417am.party listening on :${port} (live manifest ${LIVE_PATH})`);

Deno.serve({ port }, app.fetch);
