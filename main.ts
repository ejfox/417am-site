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
//   GET  /a/:no           one bot-archive piece: image, tweet, script + seed as tweeted, source
//   GET  /rss.xml         RSS 2.0, era "now" only, live entries only
//   GET  /feed.json       JSON Feed 1.1, same items
//   GET  /upload          basic-auth upload form (UPLOAD_PASSWORD)
//   POST /upload          basic-auth, Cloudinary 417am/uploads, kind "upload" (image or video)
//   POST   /api/post            Bearer POST_TOKEN: multipart {image|video, id, kind, date?, publish_at?, materials?}
//   POST   /api/materials       Bearer: JSON {slug|id, materials}: attach a piece's art supplies
//   DELETE /api/post/:id        Bearer: remove from the manifest (Cloudinary asset is kept)
//   PATCH  /api/post/:id        Bearer: JSON {publish_at: iso|null} (reschedule a drip item)
//   GET    /api/schedule        Bearer: every era-"now" entry incl. not-yet-public ones
//   GET  /media/:name     dev only (MEDIA_DIR set): files stored locally instead of Cloudinary
//
// PRIVACY: new entries carry media, date, kind and (optionally) allow-listed materials: tool
// settings such as dither, steps, seed (MATERIAL_RULES). Never prompts, recipes, note names
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
  // the piece's own art supplies (dither, steps, ...): allow-listed, see MATERIAL_RULES
  materials?: Materials;
};

type Materials = Record<string, string | number | boolean>;

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
  .tomb .tweeted { overflow-wrap: anywhere; }
  /* bot-archive pages: wall text, then the script itself, scrolling in its own box */
  :root { --wash: #f4f4f4; }
  .note { max-width: 60ch; padding-bottom: 64px; }
  .note i { font-style: italic; }
  .code { margin: 0 0 120px; }
  .code pre {
    background: var(--wash); color: var(--fg); padding: 20px 24px; max-height: 70vh; overflow: auto;
    font: 12px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; tab-size: 2; white-space: pre;
  }
  .code figcaption { margin-top: 12px; }
  .info-page .archive-notes { grid-column: 1 / -1; }
  @media (min-width: 900px) { .info-page .archive-notes { grid-column: 1 / span 2; } }
  .info-page .archive-notes i { font-style: italic; }
  form.post { max-width: 48ch; padding: 48px 0; display: grid; gap: 16px; }
  label { display: block; margin-bottom: 4px; color: var(--mid); }
  input[type="text"], input[type="file"] {
    width: 100%; padding: 8px; background: var(--bg); color: var(--fg);
    border: 1px solid var(--mid); border-radius: 0;
  }
  button { padding: 10px; background: var(--fg); color: var(--bg); border: none; border-radius: 0; cursor: pointer; }
  .msg { padding-top: 16px; }

  /* ---- 4:17 am: the party (PARTY_SCRIPT toggles html.party). Hue/invert cycles are slow, so
     no flashing over 3/s; reduced motion keeps the color flip only. */
  .party-marquee { display: none; }
  html.party { --bg: #000; --fg: #fff; --mid: #ff3b8d; --hair: #333; --wash: #111; }
  html.party, html.party body { background: #000; transition: background 400ms; }
  html.party .party-marquee {
    display: block; position: fixed; left: 0; right: 0; top: 40vh; z-index: 5; overflow: hidden;
    pointer-events: none; mix-blend-mode: difference; font-weight: 900; font-size: 18vw; line-height: 1;
    white-space: nowrap; color: #fff; letter-spacing: -0.04em;
  }
  html.party .party-marquee span { display: inline-block; animation: party-marquee 9s linear infinite; }
  html.party .work, html.party .piece img, html.party .piece video {
    animation: party-float var(--dur, 4s) ease-in-out var(--delay, 0s) infinite alternate;
  }
  html.party .frame img, html.party .piece img {
    animation-name: party-float, party-color;
    animation-duration: var(--dur, 4s), 7s;
    animation-timing-function: ease-in-out, linear;
    animation-iteration-count: infinite, infinite;
    animation-direction: alternate, normal;
    outline-color: #ff3b8d;
  }
  html.party .label i { font-weight: 900; color: #ff3b8d; }
  html.party .head h1 { animation: party-wobble 1.4s ease-in-out infinite alternate; color: #fff; }
  @keyframes party-float {
    from { transform: translate(0, 0) rotate(0deg) scale(1); }
    to { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(1.06); }
  }
  /* a full hue spin at high saturation + contrast (an invert phase went muddy gray) */
  @keyframes party-color {
    0% { filter: hue-rotate(var(--hue, 0deg)) saturate(2.4) contrast(1.35); }
    100% { filter: hue-rotate(calc(var(--hue, 0deg) + 360deg)) saturate(2.4) contrast(1.35); }
  }
  @keyframes party-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
  @keyframes party-wobble { from { transform: rotate(-3deg) scale(1); } to { transform: rotate(3deg) scale(1.15); } }
  @media (prefers-reduced-motion: reduce) {
    html.party *, html.party .party-marquee span { animation: none !important; transition: none !important; }
    html.party .party-marquee { display: none; }
  }
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

// 4:17 am (EJ 2026-10-20: "make the site go absolutely crazy at 417am every day"): for the whole
// minute 04:17 America/New_York (the site's clock, one shared nightly opening) the white cube
// becomes a black-box party: works come off the wall and drift/spin, colors cycle, a 4:17 AM
// marquee runs. Snaps back at 04:18. ?party forces it for previews. Safety: nothing flashes
// faster than 3/s (WCAG 2.3.1); prefers-reduced-motion gets the color flip, no movement.
const PARTY_SCRIPT = `<div class="party-marquee" aria-hidden="true"><span>4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp; 4:17 AM &nbsp;</span></div>
<script>
(() => {
  const forced = new URLSearchParams(location.search).has("party");
  const et = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false });
  const isParty = () => {
    if (forced) return true;
    const p = Object.fromEntries(et.formatToParts(new Date()).map((x) => [x.type, x.value]));
    return Number(p.hour) % 24 === 4 && Number(p.minute) === 17;
  };
  const root = document.documentElement;
  const labels = new Map();
  let on = false, logged = false;
  function start() {
    on = true;
    document.querySelectorAll(".work, .piece img, .piece video").forEach((el, i) => {
      // each work gets its own rhythm: drift, spin, bob
      el.style.setProperty("--dx", (Math.random() * 60 - 30).toFixed(1) + "px");
      el.style.setProperty("--dy", (Math.random() * 60 - 30).toFixed(1) + "px");
      el.style.setProperty("--rot", (Math.random() * 30 - 15).toFixed(1) + "deg");
      el.style.setProperty("--dur", (2.5 + Math.random() * 4).toFixed(2) + "s");
      el.style.setProperty("--delay", (-Math.random() * 5).toFixed(2) + "s");
      el.style.setProperty("--hue", Math.floor(Math.random() * 360) + "deg");
    });
    document.querySelectorAll(".label i").forEach((i) => { labels.set(i, i.textContent); i.textContent = "NOW"; });
    root.classList.add("party");
    if (!logged && window.umami) { try { umami.track("party-417", { forced }); } catch (_) {} logged = true; }
  }
  function stop() {
    on = false;
    root.classList.remove("party");
    labels.forEach((t, i) => { i.textContent = t; });
    labels.clear();
  }
  const tick = () => { const p = isParty(); if (p && !on) start(); else if (!p && on) stop(); };
  tick();
  setInterval(tick, 1000);
})();
</script>`;

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
<body><div class="wrap">${body}</div>${PARTY_SCRIPT}${UMAMI_DIVIDER}${body.includes("<video") ? UMAMI_VIDEO : ""}</body>
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

// ---- per-piece materials (2026-10-20) ----------------------------------------------------
// What the poster sends with each piece: settings only, like an art-supplies list. STRICT
// ALLOW-LIST per kind: each key has a type and a range/enum/pattern; the output object is built
// key by key and anything else (a prompt, a path, a name) is dropped, never stored. The PC side
// (post_417am.py materials_for) builds from the same list; this is the second gate.
type Rule =
  | { t: "int"; min: number; max: number }
  | { t: "num"; min: number; max: number }
  | { t: "bool" }
  | { t: "enum"; of: readonly string[] }
  | { t: "intof"; of: readonly number[] }
  | { t: "re"; re: RegExp; max: number };
const SIZE: Rule = { t: "int", min: 1, max: 16384 };
const SEED: Rule = { t: "int", min: 0, max: Number.MAX_SAFE_INTEGER };
const DITHER_NAME: Record<string, string> = {
  threshold: "Threshold", bayer2: "Bayer 2×2", bayer4: "Bayer 4×4", bayer8: "Bayer 8×8",
  blue: "Blue-noise", atkinson: "Atkinson", floyd: "Floyd–Steinberg", halftone: "Halftone",
  lines: "Line", crosshatch: "Crosshatch", stipple: "Stipple", raw: "",
};
const SAMPLER_NAME: Record<string, string> = {
  euler: "Euler", euler_a: "Euler a", heun: "Heun", dpm2: "DPM2", "dpm++2s_a": "DPM++ 2S a",
  "dpm++2m": "DPM++ 2M", "dpm++2mv2": "DPM++ 2M v2", ipndm: "iPNDM", ipndm_v: "iPNDM-v",
  lcm: "LCM", ddim_trailing: "DDIM trailing", tcd: "TCD",
};
const FLUX_MODEL_NAME: Record<string, string> = { "flux2-klein-9b": "FLUX.2 [klein] 9B" };
const MATERIAL_RULES: Partial<Record<Kind, Record<string, Rule>>> = {
  studio: {
    dither: { t: "enum", of: Object.keys(DITHER_NAME) },
    bits: { t: "intof", of: [1, 3, 8, 16] },
    px: { t: "int", min: 1, max: 16 },
    render_w: SIZE, render_h: SIZE, out_w: SIZE, out_h: SIZE,
    render_s: { t: "int", min: 0, max: 86400 },
    seed: SEED,
    red: { t: "re", re: /^#[0-9a-f]{6}$/, max: 7 },
    crt: { t: "bool" },
  },
  flux: {
    model: { t: "enum", of: Object.keys(FLUX_MODEL_NAME) },
    quant: { t: "re", re: /^(Q[2-8](_K)?(_[SML])?|Q8_0|F16|BF16)$/, max: 8 },
    steps: { t: "int", min: 1, max: 500 },
    sampler: { t: "re", re: /^[a-z0-9+_]{1,24}$/, max: 24 },
    cfg: { t: "num", min: 0, max: 50 },
    guidance: { t: "num", min: 0, max: 50 },
    seed: SEED,
    gen_w: SIZE, gen_h: SIZE,
    img2img: { t: "bool" },
    strength: { t: "num", min: 0, max: 1 },
    source: { t: "enum", of: ["studio"] }, // img2img seeded from a studio render (never which)
  },
};
const MAX_MATERIALS_JSON = 2048;

// -> the allow-listed subset (null when nothing survives). `raw` is a JSON string or an object.
function cleanMaterials(kind: Kind, raw: unknown): Materials | null {
  const rules = MATERIAL_RULES[kind];
  if (!rules) return null;
  let o: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_MATERIALS_JSON) return null;
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const src = o as Record<string, unknown>;
  const out: Materials = {};
  for (const [k, r] of Object.entries(rules)) {
    if (!Object.hasOwn(src, k)) continue;
    const v = src[k];
    if (r.t === "bool") {
      if (typeof v === "boolean") out[k] = v;
    } else if (r.t === "int" || r.t === "num") {
      if (typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max &&
        (r.t === "num" || Number.isInteger(v))) out[k] = r.t === "num" ? Math.round(v * 1000) / 1000 : v;
    } else if (r.t === "enum") {
      if (typeof v === "string" && r.of.includes(v)) out[k] = v;
    } else if (r.t === "intof") {
      if (typeof v === "number" && r.of.includes(v)) out[k] = v;
    } else if (typeof v === "string" && v.length <= r.max && r.re.test(v)) {
      out[k] = v;
    }
  }
  if (out.img2img !== true) { // strength/source only mean something for img2img
    delete out.strength;
    delete out.source;
  }
  return Object.keys(out).length ? out : null;
}

const mStr = (m: Materials, k: string) => (typeof m[k] === "string" ? m[k] as string : "");
const mNum = (m: Materials, k: string) => (typeof m[k] === "number" ? m[k] as number : undefined);
const dec1 = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

// the dither phrase for a studio piece: "Atkinson dither" / "undithered" / ""
function ditherPhrase(m: Materials): string {
  const d = mStr(m, "dither");
  if (!d) return "";
  return d === "raw" ? "undithered" : `${DITHER_NAME[d]} dither`;
}

// The wall label, one line. Per-piece when the piece has materials, else the kind's MEDIUM.
function medium(e: Entry): string {
  const m = e.materials;
  let s = MEDIUM[e.kind];
  if (m && e.kind === "studio" && ditherPhrase(m)) s = `Blender 5.2, Cycles; ${ditherPhrase(m)}`;
  if (m && e.kind === "flux") {
    const model = FLUX_MODEL_NAME[mStr(m, "model")] || "FLUX.2 [klein] 9B";
    const steps = mNum(m, "steps");
    s = [model, m.img2img === true ? "img2img" : "", steps ? `${steps} steps` : ""].filter(Boolean).join(", ");
  }
  return `${s}${isVideo(e) ? ", video" : ""}`;
}

// The piece page's specifics, one plain-language line each, after the generic SUPPLIES.
function materialLines(e: Entry): string[] {
  const m = e.materials;
  if (!m) return [];
  const lines: string[] = [];
  const x = (w?: number, h?: number) => (w && h ? `${w} × ${h}` : "");
  if (e.kind === "studio") {
    const bits = mNum(m, "bits"), px = mNum(m, "px"), red = mStr(m, "red");
    const depth = bits === 1 ? "1-bit (black, white)" : bits === 3 ? `3-level (black, white, red${red ? " " + red : ""})`
      : bits ? `${bits}-bit grayscale` : "";
    const d = ditherPhrase(m);
    const head = d === "undithered" ? "Undithered, film-style finish" : d;
    lines.push([head && head[0].toUpperCase() + head.slice(1), d === "undithered" ? "" : depth,
      px && px > 1 && d !== "undithered" ? `${px}× nearest-neighbor` : ""].filter(Boolean).join(", "));
    const rs = mNum(m, "render_s"), rr = x(mNum(m, "render_w"), mNum(m, "render_h"));
    if (rr || rs !== undefined) lines.push(`Rendered${rr ? " " + rr : ""}${rs !== undefined ? ` in ${rs} s` : ""}`);
    if (m.crt === true) lines.push("CRT curvature");
    if (mNum(m, "seed") !== undefined) lines.push(`Seed ${mNum(m, "seed")}`);
  } else if (e.kind === "flux") {
    const steps = mNum(m, "steps"), cfg = mNum(m, "cfg"), g = mNum(m, "guidance"), seed = mNum(m, "seed");
    const sampler = mStr(m, "sampler");
    lines.push([steps ? `${steps} steps` : "", sampler ? SAMPLER_NAME[sampler] || sampler : "",
      cfg !== undefined ? `CFG ${dec1(cfg)}` : "", g !== undefined ? `guidance ${dec1(g)}` : "",
      seed !== undefined ? `seed ${seed}` : ""].filter(Boolean).join(", "));
    const gs = x(mNum(m, "gen_w"), mNum(m, "gen_h"));
    if (gs && gs !== x(e.width, e.height)) lines.push(`Generated at ${gs}`); // else the px line says it
    const st = mNum(m, "strength");
    if (m.img2img === true) {
      lines.push(`img2img${mStr(m, "source") === "studio" ? " from a studio render" : ""}${st !== undefined ? `, strength ${st.toFixed(2)}` : ""}`);
    } else if (m.img2img === false) lines.push("Text-to-image");
  }
  return lines.filter(Boolean);
}

// Generic supplies, then the piece's own. A studio piece that names its dither drops the
// generic "1-bit dither" line (wrong for 3-level and undithered pieces).
function supplies(e: Entry): string[] {
  const own = materialLines(e);
  const base = e.kind === "studio" && e.materials && ditherPhrase(e.materials)
    ? SUPPLIES.studio.filter((s) => !/dither/.test(s))
    : SUPPLIES[e.kind];
  return [...base, ...(isVideo(e) ? ["Video, H.264"] : []), ...own];
}
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
  const day = archiveDay(e.date);
  const m = archiveMeta[e.url];
  return `<a class="work" id="no-${e.no}" href="/a/${e.no}" data-umami-event="archive-open">
      <div class="frame"><img src="${escapeHtml(e.url)}" loading="lazy" decoding="async" alt="417am no. ${pad(e.no)}, @417am1975, ${day}${e.caption ? ": " + escapeHtml(e.caption) : ""}"></div>
      <p class="label"><i>417am no. ${pad(e.no)}</i>, ${day.slice(0, 4)}<br><span class="mid">${m ? escapeHtml(scriptFile(m)) : "Generative image"}</span></p>
    </a>`;
}

// ---- the bot archive, piece by piece (2026-10-21) -------------------------------------------
// data/archive-meta.json joins an archive entry (by url) to its tweet and the script that made
// it; data/artscripts/ holds each script's source as committed. Both are generated by
// tools/build-archive-meta.py from the tweet list + a twitter-artbot clone. 60 of 145 entries
// are matched; the rest get an /a page with image and date only.
type ArchiveMeta = {
  script: string; // as tweeted: "3-4-4", "2018/12-20", "608"
  seed: string; // as tweeted (did not always drive the image; never presented as a recipe)
  tweet_id: string;
  tweet_text: string; // verbatim, minus any "#bot2bot @x" tail
  bot2bot?: string;
  script_path: string;
  commit: string;
  script_date: string; // when the vendored source was last changed
  github_url: string;
  vendored: string;
};

const archiveMeta: Record<string, ArchiveMeta> = (() => {
  try {
    return JSON.parse(Deno.readTextFileSync(new URL("./data/archive-meta.json", import.meta.url)));
  } catch (err) {
    console.error("archive meta read failed", err);
    return {};
  }
})();

const scriptName = (m: ArchiveMeta) => m.script.split("/").pop()!;
const scriptFile = (m: ArchiveMeta) => `${scriptName(m)}.coffee`;

const sourceCache = new Map<string, string | null>();
async function scriptSource(m: ArchiveMeta): Promise<string | null> {
  if (!/^data\/artscripts\/[0-9-]+\.coffee$/.test(m.vendored)) return null;
  if (!sourceCache.has(m.vendored)) {
    try {
      sourceCache.set(m.vendored, await Deno.readTextFile(new URL("./" + m.vendored, import.meta.url)));
    } catch {
      sourceCache.set(m.vendored, null);
    }
  }
  return sourceCache.get(m.vendored)!;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
// "18 November 2019" from a YYYY-MM-DD
function longDay(ymd: string): string {
  const [y, mo, d] = ymd.split("-").map(Number);
  return y && mo && d ? `${d} ${MONTHS[mo - 1]} ${y}` : ymd;
}
// The archive's day, Eastern like the rest of the site. Entries without a real time
// (T00:00:00Z placeholders) keep their calendar day instead of slipping to the evening before.
const noTime = (iso: string) => /T00:00:00(\.000)?Z$/.test(iso);
const archiveDay = (iso: string) => (noTime(iso) ? iso.slice(0, 10) : localDay(iso));

// "18 November 2019, 1:20 am ET"; day only when the archive has no real time
function easternMoment(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = longDay(archiveDay(iso));
  if (noTime(iso)) return day;
  const t = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    .format(d).replace(" AM", " am").replace(" PM", " pm");
  return `${day}, ${t} ET`;
}

// Wall text, EJ-approved stories only (artbot-stories.md A1, A4, A5), in the house register.
const NOTE_10_15 = `<i>10-15</i> (2017) draws nothing itself. The script announces &ldquo;I&rsquo;m in
  charge now... Let&rsquo;s make some art,&rdquo; then prints numbered drawing instructions for a person:
  &ldquo;Clear your mind,&rdquo; &ldquo;Make this as unappealing as possible,&rdquo; &ldquo;Pretend this
  work will sell for $1000.&rdquo; It was in every multi-script rotation of the bot from October 2017 to
  December 2018.`;
const NOTE_12_20 = `From 20 December 2018 until it stopped, the bot ran one script, <i>12-20</i>. Each
  work scatters the name of a randomly chosen animal, letter by letter, in red, blue and yellow on a
  cream ground. The same name is set small in monospace in the corner.`;
const ARCHIVE_NOTES = [
  `The bot&rsquo;s rotation was cut to a single script several times. In November 2017 it ran splines
  only. In December 2017 it ran <i>12-1-3</i>. From March to May 2018 it ran <i>3-4-4</i>, which traced
  words such as &ldquo;love me&rdquo; and &ldquo;417.&rdquo; On 20 December 2018 the artist committed
  &ldquo;change to zoo animals,&rdquo; and from then on the compiled bot ran only <i>12-20</i>.`,
  `In a 2017 essay the artist called the bot &ldquo;a slot machine with a lever being pulled again and
  again&rdquo; and described the project as teaching &ldquo;my robot the unspoken rules of art the way
  you&rsquo;d teach a child.&rdquo; The essay proposes a genetic algorithm in which faves and retweets
  decide which &ldquo;DNA&rdquo; survives. It ends with the heading &ldquo;Building your art robot a
  memory,&rdquo; followed by &ldquo;To be continued...&rdquo; No later commit adds a memory.`,
];

function storyNote(m: ArchiveMeta | undefined): string {
  if (!m) return "";
  if (m.script === "10-15") return NOTE_10_15;
  if (m.script === "2018/12-20") return NOTE_12_20;
  return "";
}

// art.json's placeholder captions say nothing the wall label doesn't
const genericCaption = (c?: string) => !c || /^(Generative piece \d+|Original @417am1975 bot output)/.test(c);

async function archivePage(e: Numbered): Promise<string> {
  const m = archiveMeta[e.url];
  const day = archiveDay(e.date);
  const year = day.slice(0, 4);
  const src = m ? await scriptSource(m) : null;
  // words the bot put before <script>-<seed> (3-4-4's word, the 2017 debug params)
  const words = m ? m.tweet_text.slice(0, m.tweet_text.length - `${m.script}-${m.seed}`.length).trim() : "";
  const note = storyNote(m);
  const title = `417am no. ${pad(e.no)} · @417am1975 · ${day}`;
  const tweet = m ? `https://x.com/417am1975/status/${m.tweet_id}` : "";
  const lines = m
    ? [
      `<p>Generative image, CoffeeScript (Node.js, canvas)</p>`,
      `<p>Script ${escapeHtml(scriptFile(m))}</p>`,
      `<p>Seed as tweeted ${escapeHtml(m.seed)}</p>`,
      m.bot2bot ? `<p>Tagged ${escapeHtml(m.bot2bot)} (#bot2bot)</p>` : "",
      words ? `<p class="gap">Tweeted text</p><p class="mid tweeted">${escapeHtml(m.tweet_text)}</p>` : "",
      `<p class="gap">Posted by @417am1975<br><time datetime="${escapeHtml(e.date)}">${easternMoment(e.date)}</time></p>`,
    ]
    : [
      `<p>${escapeHtml(MEDIUM.bot)}</p>`,
      `<p class="mid"><time datetime="${escapeHtml(e.date)}">${easternMoment(e.date)}</time></p>`,
    ];
  const caption = genericCaption(e.caption) ? "" : `<p class="gap mid">${escapeHtml(e.caption!)}</p>`;
  const links = [
    tweet ? `<a href="${tweet}" data-umami-event="outbound" data-umami-event-url="${tweet}">Original post</a>` : "",
    m ? `<a href="${escapeHtml(m.github_url)}" data-umami-event="outbound" data-umami-event-url="${escapeHtml(m.github_url)}">Source</a>` : "",
    `<a href="${escapeHtml(e.url)}" data-umami-event="image-open">Full size</a>`,
    `<a href="/#no-${e.no}">Back to the archive</a>`,
  ].filter(Boolean).join("<br>");
  return layout(
    {
      title,
      description: m
        ? `417am no. ${pad(e.no)}, generated by ${scriptFile(m)} and posted by @417am1975, ${day}.`
        : `417am no. ${pad(e.no)}, posted by @417am1975, ${day}.`,
      url: `${SITE}/a/${e.no}`,
      image: shareUrl(e),
    },
    `${siteHead()}
    <div class="piece">
      <a href="${escapeHtml(e.url)}" data-umami-event="image-open"><img src="${escapeHtml(e.url)}" alt="417am no. ${pad(e.no)}, @417am1975, ${day}"></a>
      <div class="tomb">
        <p>EJ Fox</p>
        <p><i>417am no. ${pad(e.no)}</i>, ${year}</p>
        ${lines.filter(Boolean).join("\n        ")}${caption}
        <p class="gap">${links}</p>
        <p class="gap mid">Courtesy the artist</p>
      </div>
    </div>${note ? `
    <div class="note"><p>${note}</p></div>` : ""}${m && src !== null ? `
    <figure class="code">
      <pre><code>${escapeHtml(src)}</code></pre>
      <figcaption class="mid">CoffeeScript, as committed ${longDay(m.script_date)}. <a href="${escapeHtml(m.github_url)}">${escapeHtml(m.script_path)}</a></figcaption>
    </figure>` : ""}`,
  );
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
      <section class="archive-notes">
        <h3>Archive notes</h3>
        ${ARCHIVE_NOTES.map((p) => `<p>${p}</p>`).join("\n        ")}
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
  const label = `<p>${xml(medium(e))}</p>`;
  if (!isVideo(e)) return `<p>${still}</p>${label}`;
  return `<p><video src="${xml(e.url)}" poster="${xml(shareUrl(e))}" controls muted loop playsinline preload="metadata">${still}</video></p>${label}`;
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
      summary: medium(e),
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

app.get("/a/:no", async (c) => {
  const p = c.req.param("no");
  const no = /^[1-9][0-9]{0,5}$/.test(p) ? Number(p) : 0;
  const e = no ? (await record()).bot.find((x) => x.no === no) : undefined;
  if (!e) return c.text("not found", 404);
  c.header("Cache-Control", "public, max-age=300");
  return c.html(await archivePage(e));
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
  // optional, never fatal: whatever fails the allow-list is dropped
  const matRaw = form.get("materials");
  const materials = typeof matRaw === "string" ? cleanMaterials(kind as Kind, matRaw) : null;
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
      ...(materials ? { materials } : {}),
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

// Attach / replace one entry's materials. JSON {slug | id, materials}; the same allow-list as
// /api/post. Materials that come out empty are refused (400) rather than wiping what's there.
app.post("/api/materials", async (c) => {
  if (!checkBearer(c.req.raw)) return c.json({ error: "unauthorized" }, 401);
  let body: { slug?: unknown; id?: unknown; materials?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON" }, 400);
  }
  const slug = typeof body.slug === "string" && /^[0-9a-f]{12}$/.test(body.slug) ? body.slug : null;
  const id = typeof body.id === "string" && ID_RE.test(body.id) ? body.id : null;
  if (!slug && !id) return c.json({ error: "slug or id required" }, 400);
  if (JSON.stringify(body.materials ?? null).length > MAX_MATERIALS_JSON) {
    return c.json({ error: "materials too large" }, 413);
  }
  const r = await mutateLive((entries) => {
    const x = entries.find((y) => y.era === "now" && (slug ? y.slug === slug : y.id === id));
    if (!x) return { status: 404 as const };
    const m = cleanMaterials(x.kind, body.materials);
    if (!m) return { status: 400 as const };
    x.materials = m;
    return { status: 200 as const, slug: x.slug, materials: m };
  });
  if (r.status === 404) return c.json({ error: "not found" }, 404);
  if (r.status === 400) return c.json({ error: "no allowed materials" }, 400);
  console.log(`api materials ${r.slug}`);
  return c.json({ ok: true, slug: r.slug, materials: r.materials });
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
