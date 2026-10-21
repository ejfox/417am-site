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
//   POST /upload          basic-auth, Cloudinary 417am/uploads, kind "upload" (image or video)
//   POST   /api/post            Bearer POST_TOKEN: multipart {image|video, id, kind, date?, publish_at?}
//   DELETE /api/post/:id        Bearer: remove from the manifest (Cloudinary asset is kept)
//   PATCH  /api/post/:id        Bearer: JSON {publish_at: iso|null} (reschedule a drip item)
//   GET    /api/schedule        Bearer: every era-"now" entry incl. not-yet-public ones
//   GET  /media/:name     dev only (MEDIA_DIR set): files stored locally instead of Cloudinary
//
// PRIVACY: new entries carry media, date and kind only. Never prompts, recipes, note names
// or piece names. The poster's `id` is private: used only for idempotency + removal, never
// rendered; public URLs use a random `slug`. PNG text/exif chunks are stripped before upload
// (generated PNGs embed their prompt). Videos are re-muxed with ffmpeg with every metadata
// field dropped (container tags, chapters, encoder strings, creation times, H.264 SEI user
// data, extra data/metadata tracks such as GPS); their poster frame is a stripped PNG.
// Entries with a future `publish_at` are invisible everywhere public (page, permalink,
// feeds) until that moment.
//
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, UPLOAD_PASSWORD,
//      POST_TOKEN (fail closed if unset), LIVE_MANIFEST, SITE_URL, PORT (8417),
//      MEDIA_DIR (dev only). Video needs ffmpeg + ffprobe on PATH and --allow-run=ffmpeg,ffprobe.

import { Hono } from "jsr:@hono/hono";

const ARCHIVE_PATH = new URL("./data/art.json", import.meta.url);
const LIVE_PATH = Deno.env.get("LIVE_MANIFEST") ||
  new URL("./data/live/now.json", import.meta.url).pathname;
const SITE = (Deno.env.get("SITE_URL") || "https://417am.party").replace(/\/$/, "");
const TZ = "America/New_York";
// Self-hosted Umami (umami.tools.ejfox.com). Unset = no script, no tracking.
const UMAMI_ID = (Deno.env.get("UMAMI_WEBSITE_ID") || "").trim();
// Umami 3.4: the tracker (?v= dodges a stale 3.0.3 copy cached at Cloudflare's edge) with Web
// Vitals, the shared umami-plus behavior helper (scroll / engaged time / outbound / copy, no
// text captured), and recorder.js (heatmaps + strictly-masked session replay; sampling and
// masking are configured per site inside Umami, not here).
const UMAMI_TAG = /^[0-9a-f-]{36}$/i.test(UMAMI_ID)
  ? `<script defer src="https://umami.tools.ejfox.com/script.js?v=3.4.0" data-website-id="${UMAMI_ID}" data-performance="true"></script>
  <script defer src="https://umami-plus.tools.ejfox.com/umami-plus.js?v=3"></script>
  <script defer src="https://umami.tools.ejfox.com/recorder.js" data-website-id="${UMAMI_ID}"></script>`
  : "";
// Fires once when §2 (the bot era) scrolls into view.
const UMAMI_DIVIDER = UMAMI_TAG
  ? `<script>(function(){var d=document.getElementById("bot-era");if(!d||!("IntersectionObserver" in window))return;
var o=new IntersectionObserver(function(es){if(es.some(function(e){return e.isIntersecting})&&window.umami){
window.umami.track("archive-divider-view");o.disconnect();}});o.observe(d);})();</script>`
  : "";
// "video-play" once per video per page view, with its entry number.
const UMAMI_VIDEO = UMAMI_TAG
  ? `<script>document.querySelectorAll("video[data-no]").forEach(function(v){v.addEventListener("play",function(){
if(window.umami)window.umami.track("video-play",{no:v.getAttribute("data-no")});},{once:true});});</script>`
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
  // video entries: `url` is the video file, `poster` its first non-black frame (PNG)
  media?: "video";
  mime?: string;
  duration?: number;
  poster?: string;
  poster_public_id?: string;
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

type Resource = "image" | "video";

// Dev only: with MEDIA_DIR set, files are written there and served from /media/ instead of
// going to Cloudinary, so the whole posting path can be exercised without touching storage.
const MEDIA_DIR = (Deno.env.get("MEDIA_DIR") || "").trim().replace(/\/$/, "");
const MEDIA_RE = /^[a-z0-9-]+\.(png|jpg|gif|webp|mp4|webm)$/;
const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm",
};

async function storeLocal(bytes: Uint8Array<ArrayBuffer>, folder: string, ext: string): Promise<CldResult> {
  await Deno.mkdir(MEDIA_DIR, { recursive: true });
  const name = `${folder.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${newSlug()}${newSlug()}.${ext}`;
  await Deno.writeFile(`${MEDIA_DIR}/${name}`, bytes);
  const d = isPng(bytes) ? pngDims(bytes) : { width: 0, height: 0 };
  return { secure_url: `${SITE}/media/${name}`, public_id: name, ...d, bytes: bytes.length, format: ext };
}

// One entry point for every stored file: Cloudinary in production, MEDIA_DIR in dev.
function store(bytes: Uint8Array<ArrayBuffer>, folder: string, resource: Resource, ext: string, mime: string) {
  if (MEDIA_DIR) return storeLocal(bytes, folder, ext);
  return uploadToCloudinary(new Blob([bytes], { type: mime }), folder, resource);
}

async function uploadToCloudinary(file: Blob, folder: string, resource: Resource = "image"): Promise<CldResult> {
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
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${resource}/upload`, {
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

const isVideo = (e: Entry) => e.media === "video";
// The still that stands for an entry: the image itself, or a video's poster frame.
const stillOf = (e: Entry) => (isVideo(e) && e.poster ? e.poster : e.url);

// What the page shows. Studio pieces are 1-bit/3-level dithers: always lossless PNG, the
// browser scales them with image-rendering: pixelated. Flux: best-quality auto format.
// Videos are always served as the stored original (no on-the-fly video transforms).
function displayUrl(e: Entry): string {
  const u = stillOf(e);
  if (e.kind === "studio") return cld(u, "f_png");
  if (e.kind === "flux") return cld(u, "f_auto,q_auto:best");
  return u;
}

// Social cards / feed readers: a sane size. Studio stays PNG (crisp), the rest -> jpg.
function shareUrl(e: Entry): string {
  const u = stillOf(e);
  if (e.kind === "studio") return cld(u, "c_limit,w_1600,f_png");
  return cld(u, "c_limit,w_1600,f_jpg,q_90");
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

function pngDims(b: Uint8Array): { width: number; height: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

// ---- video: validate, strip, poster ---------------------------------------------------------
// ffmpeg/ffprobe run with a fixed argv (no shell) on a temp copy. The container is sniffed
// from its magic bytes and then FORCED (-f mov / -f matroska), so ffmpeg never auto-picks a
// demuxer that can read other files (hls, concat), and only the file protocol is allowed.

const MAX_VIDEO = 90 * 1024 * 1024; // Cloudflare (free) rejects request bodies over 100 MB
const MAX_SECONDS = 180;
const MAX_SIDE = 4096;
const VIDEO_RULES = {
  mp4: { demux: "mov", mux: "mp4", mime: "video/mp4", v: ["h264"], a: ["aac"] },
  webm: { demux: "matroska", mux: "webm", mime: "video/webm", v: ["vp8", "vp9"], a: ["opus", "vorbis"] },
} as const;
type VideoFmt = keyof typeof VIDEO_RULES;

class VideoError extends Error {
  constructor(public status: 400 | 413 | 415 | 503, msg: string) {
    super(msg);
  }
}

// ISO-BMFF ("....ftyp") or EBML (1A 45 DF A3). Anything else is not a video we take.
function sniffVideo(b: Uint8Array): VideoFmt | null {
  const s = (i: number, j: number) => String.fromCharCode(...b.subarray(i, j));
  if (b.length > 16 && s(4, 8) === "ftyp") return "mp4";
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  return null;
}

async function run(cmd: "ffmpeg" | "ffprobe", args: string[], timeoutMs = 120_000): Promise<string> {
  let out: Deno.CommandOutput;
  try {
    out = await new Deno.Command(cmd, {
      args: ["-hide_banner", "-v", "error", ...args],
      stdin: "null", stdout: "piped", stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
  } catch (err) {
    console.error(`${cmd} unavailable`, err);
    throw new VideoError(503, "video processing unavailable");
  }
  if (!out.success) {
    console.error(`${cmd} failed: ${new TextDecoder().decode(out.stderr).slice(0, 2000)}`);
    throw new VideoError(415, "could not read that video");
  }
  return new TextDecoder().decode(out.stdout);
}

type ProbeStream = { codec_type?: string; codec_name?: string; width?: number; height?: number };

// First frame (within the first 10 s) that is not black: some light or some contrast.
async function firstLitFrame(file: string): Promise<number> {
  const txt = await run("ffmpeg", [
    "-nostdin", "-protocol_whitelist", "file", "-t", "10", "-i", file, "-an", "-sn", "-dn",
    "-vf", "signalstats,metadata=mode=print:file=-", "-f", "null", "-",
  ]);
  let t = 0;
  const stat: Record<string, number> = {};
  const lit = () => stat.YAVG > 24 || stat.YMAX - stat.YMIN > 48;
  for (const line of txt.split("\n")) {
    const f = line.match(/pts_time:([\d.]+)/);
    if (f) {
      if ("YAVG" in stat && lit()) return t;
      t = Number(f[1]);
      for (const k in stat) delete stat[k];
      continue;
    }
    const m = line.match(/lavfi\.signalstats\.(YAVG|YMIN|YMAX)=([\d.]+)/);
    if (m) stat[m[1]] = Number(m[2]);
  }
  return "YAVG" in stat && lit() ? t : 0;
}

type CleanVideo = {
  fmt: VideoFmt;
  video: Uint8Array<ArrayBuffer>;
  poster: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  duration: number;
};

async function cleanVideo(input: Uint8Array): Promise<CleanVideo> {
  if (input.length > MAX_VIDEO) throw new VideoError(413, "video over 90 MB");
  const fmt = sniffVideo(input);
  if (!fmt) throw new VideoError(415, "mp4 (H.264/AAC) or webm (VP8/VP9) only");
  const rule = VIDEO_RULES[fmt];
  const dir = await Deno.makeTempDir({ prefix: "v417-" });
  try {
    const src = `${dir}/in`, out = `${dir}/out.${fmt}`, still = `${dir}/poster.png`;
    await Deno.writeFile(src, input);
    const probe = JSON.parse(await run("ffprobe", [
      "-protocol_whitelist", "file", "-f", rule.demux, "-i", src,
      "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json",
    ]));
    const streams: ProbeStream[] = probe.streams || [];
    const v = streams.find((s) => s.codec_type === "video");
    const a = streams.find((s) => s.codec_type === "audio");
    const duration = Number(probe.format?.duration);
    if (!v || !(rule.v as readonly string[]).includes(v.codec_name || "")) {
      throw new VideoError(415, fmt === "mp4" ? "mp4 video must be H.264" : "webm video must be VP8 or VP9");
    }
    if (a && !(rule.a as readonly string[]).includes(a.codec_name || "")) {
      throw new VideoError(415, fmt === "mp4" ? "mp4 audio must be AAC" : "webm audio must be Opus or Vorbis");
    }
    if (!(duration > 0)) throw new VideoError(415, "could not read the duration");
    if (duration > MAX_SECONDS) throw new VideoError(413, `video over ${MAX_SECONDS} s`);
    if (!v.width || !v.height || v.width > MAX_SIDE || v.height > MAX_SIDE) {
      throw new VideoError(415, `video frame over ${MAX_SIDE} px`);
    }
    // Re-mux the picture (no re-encode): first video + first audio stream only (drops data,
    // subtitle and timed-metadata tracks), no global/stream/chapter metadata, bitexact = no
    // encoder tags and zeroed creation times; H.264 SEI NAL units (x264 settings strings,
    // user data) out. AAC and Vorbis audio IS re-encoded (cheap): AAC encoders hide their
    // name and version in the bitstream (data elements) and Vorbis carries a comment header
    // (vendor + tags); a stream copy would keep both. Opus packets carry nothing: copied.
    const audio = !a ? [] : a.codec_name === "opus" ? ["-c:a", "copy"]
      : fmt === "mp4" ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "libopus", "-b:a", "160k"];
    await run("ffmpeg", [
      "-nostdin", "-protocol_whitelist", "file", "-f", rule.demux, "-i", src,
      "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy", ...audio,
      ...(fmt === "mp4" ? ["-bsf:v", "filter_units=remove_types=6"] : []),
      "-map_metadata", "-1", "-map_metadata:s:v", "-1", "-map_metadata:s:a", "-1", "-map_chapters", "-1",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
      "-metadata:s:v", "handler_name=", "-metadata:s:a", "handler_name=",
      "-metadata:s:v", "encoder=", "-metadata:s:a", "encoder=",
      ...(fmt === "mp4" ? ["-movflags", "+faststart"] : []),
      "-f", rule.mux, out,
    ]);
    const at = await firstLitFrame(out);
    await run("ffmpeg", [
      "-nostdin", "-protocol_whitelist", "file", "-ss", String(at), "-i", out,
      "-frames:v", "1", "-an", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
      "-c:v", "png", "-f", "image2", still,
    ]);
    const poster = stripPng(await Deno.readFile(still));
    return { fmt, video: await Deno.readFile(out), poster, ...pngDims(poster), duration };
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

// Store a cleaned video + its poster; returns the entry fields they fill in.
async function storeVideo(input: Uint8Array, folder: string): Promise<Partial<Entry>> {
  const c = await cleanVideo(input);
  const rule = VIDEO_RULES[c.fmt];
  const p = await store(c.poster, folder, "image", "png", "image/png");
  const r = await store(c.video, folder, "video", c.fmt, rule.mime);
  return {
    media: "video",
    url: r.secure_url,
    public_id: r.public_id,
    poster: p.secure_url,
    poster_public_id: p.public_id,
    width: c.width,
    height: c.height,
    bytes: c.video.length,
    format: c.fmt,
    mime: rule.mime,
    duration: Math.round(c.duration * 100) / 100,
  };
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
// Videos keep their kind glyph and add ▶ (U+25B6, the same Geometric Shapes block as ● ■ ○ ◇,
// so it sits on the same monospace cell). U+FE0E pins the text presentation: without it iOS
// draws U+25B6 as a colored emoji button.
const VIDEO_MARK = "▶︎";
const kindText = (e: Entry) => `${GLYPH[e.kind]} ${e.kind}${isVideo(e) ? ` · ${VIDEO_MARK} video` : ""}`;

const FEED_DESC =
  "417am is EJ Fox's generative art project. It began in 2017 as @417am1975, a Twitter bot " +
  "that tweeted his after-work art scripts every hour with fresh random numbers; that archive " +
  "lives on the site. This feed carries only the new work, 2026 onward.";

const PAGE_STYLES = `
  /* White cube (EJ 2026-10-20: "nyc art world vibe"): white walls, one small grotesk size,
     works hung with room around them, wall-label captions. */
  :root { color-scheme: light; --bg: #fff; --fg: #111; --mid: #8a8a8a; --hair: #e4e4e4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html {
    background: var(--bg); color: var(--fg);
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.4; letter-spacing: 0.005em;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  }
  body { background: var(--bg); }
  h1, h2, p, figcaption, input, button, label, time { font: inherit; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 2px; }
  .wrap { padding: 0 20px; max-width: 1800px; margin: 0 auto; }
  @media (min-width: 900px) { .wrap { padding: 0 48px; } }
  .mid { color: var(--mid); }
  .head { padding: 28px 0 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 32px; }
  .head h1 { font-weight: 700; }
  .head nav { margin-left: auto; display: flex; gap: 24px; }
  /* section title: a quiet line, lots of air above */
  .bar { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 32px; padding: 88px 0 28px; }
  .bar h2 { font-weight: 700; }
  /* works on the wall: each piece contained in an even box (never cropped), bottoms aligned
     so the labels line up, a wall label under each */
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px 20px; }
  @media (min-width: 700px) { .grid { grid-template-columns: repeat(3, 1fr); gap: 64px 40px; } }
  @media (min-width: 1100px) { .grid { grid-template-columns: repeat(4, 1fr); gap: 72px 48px; } }
  @media (min-width: 1600px) { .grid { grid-template-columns: repeat(5, 1fr); } }
  .work { display: block; }
  .work:hover { text-decoration: none; }
  .frame { aspect-ratio: 1; display: flex; align-items: flex-end; justify-content: center; }
  /* a hairline edge so white-ground pieces (1-bit studio work) keep their shape on the white wall */
  .frame img { display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; outline: 1px solid var(--hair); outline-offset: 0; }
  .piece img { outline: 1px solid var(--hair); }
  img.crisp, video.crisp { image-rendering: crisp-edges; image-rendering: pixelated; }
  .label { margin-top: 12px; }
  .label i, .tomb i { font-style: italic; }
  .work:hover .label i { text-decoration: underline; text-underline-offset: 2px; }
  .work:focus-visible { outline: 1px solid var(--fg); outline-offset: 6px; }
  .empty { padding: 16px 0 32px; color: var(--mid); }
  .info { margin-top: 120px; padding: 28px 0 72px; border-top: 1px solid var(--hair);
          display: flex; justify-content: space-between; gap: 24px; }
  .info-page { display: grid; gap: 48px; padding-bottom: 120px; }
  @media (min-width: 900px) { .info-page { grid-template-columns: 2fr 2fr 1fr; gap: 64px; } }
  .info-page h3 { font: inherit; font-weight: 700; margin-bottom: 8px; }
  .info-page p { max-width: 60ch; }
  .info-page section > p + p { margin-top: 12px; }
  /* one work: centered, the checklist entry beside it */
  .piece { padding: 64px 0 96px; display: grid; gap: 28px; }
  @media (min-width: 1100px) { .piece { grid-template-columns: 1fr 260px; align-items: end; gap: 48px; } }
  .piece img, .piece video { display: block; max-width: 100%; max-height: 82vh; width: auto; height: auto; margin: 0 auto; }
  .tomb p + p { margin-top: 2px; }
  .tomb .gap { margin-top: 16px; }
  form.post { max-width: 48ch; padding: 48px 0; display: grid; gap: 16px; }
  label { display: block; margin-bottom: 4px; color: var(--mid); }
  input[type="text"], input[type="file"] {
    width: 100%; padding: 8px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--mid); border-radius: 0;
  }
  button { padding: 10px; background: var(--fg); color: var(--bg); border: none; border-radius: 0; cursor: pointer; }
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

type Meta = {
  title: string;
  description: string;
  url: string;
  image?: string;
  video?: { url: string; type: string; width?: number; height?: number };
};

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
  ${meta.video ? [m("og:video", meta.video.url), m("og:video:secure_url", meta.video.url), m("og:video:type", meta.video.type),
      meta.video.width ? m("og:video:width", String(meta.video.width)) : "",
      meta.video.height ? m("og:video:height", String(meta.video.height)) : ""].filter(Boolean).join("\n  ") : ""}
  ${n("twitter:card", meta.image ? "summary_large_image" : "summary")}
  ${n("twitter:title", meta.title)}
  ${n("twitter:description", meta.description)}
  ${meta.image ? n("twitter:image", meta.image) : ""}
  <style>${PAGE_STYLES}</style>
  ${UMAMI_TAG}
</head>
<body><div class="wrap">${body}</div>${UMAMI_DIVIDER}${body.includes("<video") ? UMAMI_VIDEO : ""}</body>
</html>`;
}

const HEAD_NAV = `<nav><a href="/#works">Works</a><a href="/#archive">Archive</a><a href="/information">Information</a></nav>`;
function siteHead(right = HEAD_NAV): string {
  return `<header class="head"><h1><a href="/">417am</a></h1>${right}</header>`;
}

function dims(e: Entry): string {
  return e.width && e.height ? ` width="${e.width}" height="${e.height}"` : "";
}

const altText = (e: Numbered) => `417am no. ${pad(e.no)}, ${e.kind}${isVideo(e) ? " video" : ""}, ${localDay(e.date)}`;

// muted + loop + playsinline, never autoplay: nothing moves (or downloads past the first
// bytes) until someone presses play.
function videoTag(e: Numbered): string {
  return `<video src="${escapeHtml(e.url)}" poster="${escapeHtml(displayUrl(e))}"${dims(e)} ${e.kind === "studio" ? 'class="crisp" ' : ""}muted loop playsinline controls preload="metadata" data-no="${pad(e.no)}" aria-label="${altText(e)}"></video>`;
}

// Materials, named the way painters list their supplies (EJ 2026-10-20: "be super clear about
// the pipeline ... like people would talk about their art supplies"). Tools and hardware only:
// never the machine's name, prompts, recipes or piece names. MEDIUM = the one-line wall label,
// SUPPLIES = the full checklist on the piece page and /information. FLUX.2 [klein] has been the
// model since the first wall render (2026-09-13); Blender 5.2 is the only Blender installed.
const MEDIUM: Record<Kind, string> = {
  flux: "FLUX.2 [klein] 9B, stable-diffusion.cpp",
  studio: "Blender 5.2, Cycles; 1-bit dither",
  upload: "Image",
  bot: "Generative image, posted by @417am1975",
};
const SUPPLIES: Record<Kind, string[]> = {
  flux: [
    "FLUX.2 [klein] 9B (Q5_K_M GGUF), Qwen3-8B text encoder, FLUX.2 VAE",
    "stable-diffusion.cpp on Vulkan, AMD Radeon RX 9070 XT",
  ],
  // each piece uses ONE dither; the site doesn't know which yet, so pieces say "1-bit dither"
  // and /information lists the methods (DITHERS)
  studio: ["Blender 5.2, Cycles, Python", "1-bit dither, nearest-neighbor scaling"],
  upload: ["Image"],
  bot: ["Generative image, posted by @417am1975"],
};
const DITHERS = "Bayer, blue noise, Atkinson, Floyd–Steinberg, halftone, line, crosshatch, stipple, threshold";
const medium = (e: Entry) => `${MEDIUM[e.kind]}${isVideo(e) ? ", video" : ""}`;
const supplies = (e: Entry) => [...SUPPLIES[e.kind], ...(isVideo(e) ? ["Video, H.264"] : [])];
const yearOf = (e: Numbered) => localDay(e.date).slice(0, 4);

// A work on the wall: contained in an even box (never cropped), bottom-aligned so the labels
// line up, the wall label always visible. A video hangs as its poster; it plays on its page.
function nowFigure(e: Numbered): string {
  return `<a class="work" id="no-${e.no}" href="/p/${e.slug}" data-umami-event="permalink-open">
      <div class="frame"><img src="${escapeHtml(displayUrl(e))}" loading="lazy" decoding="async"${dims(e)} ${e.kind === "studio" ? 'class="crisp" ' : ""}alt="${altText(e)}"></div>
      <p class="label"><i>417am no. ${pad(e.no)}</i>, ${yearOf(e)}<br><span class="mid">${medium(e)}</span></p>
    </a>`;
}

function botFigure(e: Numbered): string {
  const d = new Date(e.date);
  const day = isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  return `<a class="work" id="no-${e.no}" href="${escapeHtml(e.url)}" data-umami-event="image-open">
      <div class="frame"><img src="${escapeHtml(e.url)}" loading="lazy" decoding="async" alt="417am no. ${pad(e.no)}, @417am1975, ${day}${e.caption ? ": " + escapeHtml(e.caption) : ""}"></div>
      <p class="label"><i>417am no. ${pad(e.no)}</i>, ${day.slice(0, 4)}<br><span class="mid">Generative image</span></p>
    </a>`;
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
    <section id="works">
      <div class="bar"><h2>Works, 2026&ndash;</h2><span class="mid">Newest first</span></div>
      ${nowBlock}
    </section>
    <section id="archive">
      <div class="bar" id="bot-era"><h2>Archive: @417am1975, 2017&ndash;2019</h2><span class="mid">The original hourly bot, <a href="https://x.com/417am1975" data-umami-event="outbound" data-umami-event-url="https://x.com/417am1975">x.com/417am1975</a></span></div>
      <div class="grid">${bot.map(botFigure).join("\n")}</div>
    </section>
    <footer class="info"><p class="mid">417am &middot; EJ Fox</p><p class="mid"><a href="/information">Information</a></p></footer>`,
  );
}

// Information: its own page, like a gallery site (a footer anchor at the end of a long page
// looked like a dead link). About, materials, hours, feeds.
function informationPage(): string {
  const list = (k: Kind) => SUPPLIES[k].map((s) => `<p>${escapeHtml(s)}</p>`).join("\n          ");
  return layout(
    {
      title: "Information · 417am.party",
      description: "417am, EJ Fox's generative art project: about, materials, feeds.",
      url: SITE + "/information",
    },
    `${siteHead()}
    <div class="bar"><h2>Information</h2></div>
    <div class="info-page">
      <section>
        <p>417am is the generative art project of EJ Fox. It began in 2017 as @417am1975, an hourly
        Twitter bot that ran his after-work scripts with fresh random numbers, and resumed in 2026.
        One body of work, numbered oldest first; dates are the day a piece was made, Eastern time.</p>
        <p class="mid">Open daily, 4:17 am.</p>
      </section>
      <section>
        <h3>Materials</h3>
        <div class="tomb">
          <p class="gap"><i>Images</i></p>
          ${list("flux")}
          <p class="gap"><i>Studio renders</i></p>
          ${list("studio")}
          <p class="mid">Dither, one per piece: ${escapeHtml(DITHERS)}</p>
        </div>
      </section>
      <section>
        <h3>Elsewhere</h3>
        <p><a href="/rss.xml" data-umami-event="rss-click">RSS</a><br><a href="/feed.json" data-umami-event="feed-json-click">JSON feed</a><br>
        <a href="https://x.com/417am1975" data-umami-event="outbound" data-umami-event-url="https://x.com/417am1975">@417am1975</a><br>
        <a href="https://ejfox.com" data-umami-event="outbound" data-umami-event-url="https://ejfox.com">ejfox.com</a></p>
      </section>
    </div>`,
  );
}

function piecePage(e: Numbered): string {
  const day = localDay(e.date);
  const v = isVideo(e);
  const title = `417am no. ${pad(e.no)} · ${e.kind}${v ? " video" : ""} · ${day}`;
  const media = v
    ? videoTag(e)
    : `<a href="${escapeHtml(e.url)}" data-umami-event="image-open"><img src="${escapeHtml(displayUrl(e))}"${dims(e)} ${e.kind === "studio" ? 'class="crisp" ' : ""}alt="${altText(e)}"></a>`;
  const open = v ? "video-open" : "image-open";
  return layout(
    {
      title,
      description: `417am no. ${pad(e.no)}, a ${e.kind} ${v ? "video" : "piece"}, ${day}.`,
      url: `${SITE}/p/${e.slug}`,
      image: shareUrl(e),
      ...(v ? { video: { url: e.url, type: e.mime || "video/mp4", width: e.width, height: e.height } } : {}),
    },
    `${siteHead()}
    <div class="piece">
      ${media}
      <div class="tomb">
        <p>EJ Fox</p>
        <p><i>417am no. ${pad(e.no)}</i>, ${yearOf(e)}</p>
        ${supplies(e).map((s) => `<p>${escapeHtml(s)}</p>`).join("\n        ")}
        ${e.width && e.height ? `<p class="mid">${e.width} &times; ${e.height} px</p>` : ""}
        <p class="mid"><time datetime="${escapeHtml(e.date)}">${day}</time></p>${e.kind === "upload" && e.caption ? `
        <p class="gap">${escapeHtml(e.caption)}</p>` : ""}
        <p class="gap"><a href="${escapeHtml(e.url)}" data-umami-event="${open}">${v ? "File" : "Full size"}</a><br><a href="/#no-${e.no}">Back to works</a></p>
      </div>
    </div>`,
  );
}

function uploadPage(message?: { ok: boolean; text: string }): string {
  const msg = message ? `<p class="msg">${message.ok ? "◆" : "◇"} ${escapeHtml(message.text)}</p>` : "";
  return layout(
    { title: "post · 417am.party", description: "post", url: SITE + "/upload" },
    `${siteHead()}
    <div>${msg}
    <form class="post" method="post" enctype="multipart/form-data" action="/upload">
      <div>
        <label for="image">image, or video (mp4 H.264 / webm, up to 90 MB and ${MAX_SECONDS} s)</label>
        <input type="file" id="image" name="image" accept="image/*,video/mp4,video/webm" required>
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
  // Videos: a <video> for readers that play it, the linked poster frame for those that don't.
  const still = `<a href="${SITE}/p/${e.slug}"><img src="${xml(shareUrl(e))}" alt="${altText(e)}"></a>`;
  if (!isVideo(e)) return `<p>${still}</p>`;
  return `<p><video src="${xml(e.url)}" poster="${xml(shareUrl(e))}" controls muted loop playsinline preload="metadata">${still}</video></p>`;
}

const itemTitle = (e: Numbered) => `no. ${pad(e.no)} · ${kindText(e)} · ${localDay(e.date)}`;
const guid = (e: Entry) => `417am.party:${e.slug}`;

function rss(items: Numbered[]): string {
  const built = items[0] ? new Date(publicAt(items[0])) : new Date();
  const body = items.map((e) => {
    const mime = e.kind === "studio" ? "image/png" : "image/jpeg";
    const media = isVideo(e)
      ? `<enclosure url="${xml(e.url)}" length="${e.bytes || 0}" type="${e.mime || "video/mp4"}"/>
      <media:content url="${xml(e.url)}" medium="video" type="${e.mime || "video/mp4"}"${e.bytes ? ` fileSize="${e.bytes}"` : ""}${e.duration ? ` duration="${Math.round(e.duration)}"` : ""}${e.width ? ` width="${e.width}" height="${e.height}"` : ""}>
        <media:thumbnail url="${xml(shareUrl(e))}"/>
      </media:content>`
      : `<media:content url="${xml(shareUrl(e))}" medium="image" type="${mime}"/>`;
    return `    <item>
      <title>${xml(itemTitle(e))}</title>
      <link>${SITE}/p/${e.slug}</link>
      <guid isPermaLink="false">${guid(e)}</guid>
      <pubDate>${new Date(publicAt(e)).toUTCString()}</pubDate>
      <description>${xml(itemHtml(e))}</description>
      <content:encoded><![CDATA[${itemHtml(e)}]]></content:encoded>
      ${media}
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
      ...(isVideo(e)
        ? {
          attachments: [{
            url: e.url,
            mime_type: e.mime || "video/mp4",
            ...(e.bytes ? { size_in_bytes: e.bytes } : {}),
            ...(e.duration ? { duration_in_seconds: Math.round(e.duration) } : {}),
          }],
        }
        : {}),
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

app.get("/information", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.html(informationPage());
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
      return c.html(uploadPage({ ok: false, text: "No file selected." }), 400);
    }
    if (file.size > MAX_VIDEO) return c.html(uploadPage({ ok: false, text: "Over 90 MB." }), 413);
    let bytes = new Uint8Array(await file.arrayBuffer());
    let fields: Partial<Entry>;
    if (sniffVideo(bytes)) {
      fields = await storeVideo(bytes, "417am/uploads");
    } else {
      if (isPng(bytes)) bytes = stripPng(bytes);
      const ext = isPng(bytes) ? "png" : (file.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const r = await store(bytes, "417am/uploads", "image", ext, file.type);
      fields = { url: r.secure_url, public_id: r.public_id, width: r.width, height: r.height, bytes: r.bytes, format: r.format };
    }
    const nowIso = new Date().toISOString();
    await mutateLive((entries) => {
      entries.unshift({
        id: "upload:" + fields.public_id,
        slug: newSlug(),
        era: "now",
        kind: "upload",
        url: fields.url!,
        caption,
        date: nowIso,
        posted_at: nowIso,
        ...fields,
      });
    });
    return c.html(uploadPage({ ok: true, text: "Posted. Check the record." }));
  } catch (err) {
    console.error(err);
    if (err instanceof VideoError) return c.html(uploadPage({ ok: false, text: err.message }), err.status);
    const text = err instanceof Error ? err.message : "Upload failed";
    return c.html(uploadPage({ ok: false, text }), 500);
  }
});

if (MEDIA_DIR) {
  // Dev only. Single-range support so browsers can seek in videos.
  app.get("/media/:name", async (c) => {
    const name = c.req.param("name");
    if (!MEDIA_RE.test(name)) return c.text("not found", 404);
    let data: Uint8Array;
    try {
      data = await Deno.readFile(`${MEDIA_DIR}/${name}`);
    } catch {
      return c.text("not found", 404);
    }
    const type = MIME[name.split(".").pop()!];
    const range = (c.req.header("range") || "").match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      if (start > end) return c.body(null, 416, { "Content-Range": `bytes */${data.length}` });
      return c.body(data.slice(start, end + 1), 206, {
        "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${data.length}`,
      });
    }
    return c.body(data.slice(), 200, { "Content-Type": type, "Accept-Ranges": "bytes" });
  });
}

// ---- posting API ----------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const API_KINDS = new Set(["flux", "studio"]);
const VIDEO_KINDS = new Set(["flux", "studio", "upload"]);
const MAX_UPLOAD = 9 * 1024 * 1024; // images; videos: MAX_VIDEO
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
  const asVideo = form.has("video");
  const file = form.get(asVideo ? "video" : "image");
  if (!ID_RE.test(id)) return c.json({ error: "bad id" }, 400);
  if (asVideo ? !VIDEO_KINDS.has(kind) : !API_KINDS.has(kind)) {
    return c.json({ error: asVideo ? "kind must be flux|studio|upload" : "kind must be flux|studio" }, 400);
  }
  if (!(file instanceof File) || file.size === 0) return c.json({ error: asVideo ? "no video" : "no image" }, 400);
  if (asVideo && file.size > MAX_VIDEO) return c.json({ error: "video over 90 MB" }, 413);
  if (!asVideo && file.size > MAX_UPLOAD) return c.json({ error: "image over 9 MB" }, 413);
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
    let fields: Partial<Entry>;
    if (asVideo) {
      fields = await storeVideo(bytes, `417am/now/${kind}`);
    } else {
      if (!isPng(bytes)) return c.json({ error: "PNG only" }, 415);
      bytes = stripPng(bytes);
      const r = await store(bytes, `417am/now/${kind}`, "image", "png", "image/png");
      fields = { url: r.secure_url, public_id: r.public_id, width: r.width, height: r.height, bytes: r.bytes, format: r.format };
    }
    const entry: Entry = {
      id,
      slug: newSlug(),
      era: "now",
      kind: kind as Kind,
      url: fields.url!,
      date,
      posted_at: nowIso,
      ...(publish_at ? { publish_at } : {}),
      ...fields,
    };
    const stored = await mutateLive((entries) => {
      const dup = entries.find((e) => e.id === id);
      if (dup) return dup;
      entries.unshift(entry);
      return entry;
    });
    console.log(`api post ${kind}${asVideo ? " video" : ""} ${stored.slug}${publish_at ? " at " + publish_at : ""}`);
    return c.json(
      { ok: true, existed: stored !== entry, slug: stored.slug, publish_at: stored.publish_at ?? null },
      201,
    );
  } catch (err) {
    console.error("api post failed", err);
    if (err instanceof VideoError) return c.json({ error: err.message }, err.status);
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
      ...(isVideo(e) ? { media: "video" } : {}),
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
