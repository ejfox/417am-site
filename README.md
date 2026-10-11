# 417am.party

The record of 417am, EJ Fox's generative art project, on one page:

- **§1 417am, 2026–** new pieces, newest first (kinds: ● flux, ■ studio, ○ upload)
- **§2 417am, 2017–2019** the original `@417am1975` Twitter bot archive

Entries are numbered as one body of work (no. 0001 = the oldest bot piece). Brutalist-academic
look: one monospace stack, one font size, flat black / off-white / one grey, 1px rules, no
gradients or shadows, no modes or toggles. Studio pieces (1-bit dithers) are served as PNG and
scaled with `image-rendering: pixelated`.

Single file (`main.ts`), Deno + Hono, smallweb style. No build step, no database.

## Data

Two manifests, on purpose:

| file | what | in git |
|---|---|---|
| `data/art.json` | the 2017–2019 bot archive, `[{url, caption, date}]`. **Read-only seed: never rewritten.** | yes |
| `$LIVE_MANIFEST` | the new work. VPS: `/data2/417am-data/now.json` (outside the repo). Local default: `data/live/now.json` (gitignored). | **no** |

The live manifest lives outside git because the deploy runs `git reset --hard`, which would
otherwise wipe anything posted since the last commit. Writes are serialized and atomic
(tmp + rename).

Live entry: `{id, slug, era: "now", kind: "flux"|"studio"|"upload", url, date, posted_at,
publish_at?, public_id, width, height, bytes, format}`.

- `id` is the poster's private idempotency key. It is **never rendered**; public URLs use the
  random `slug` (`/p/<slug>`).
- `date` = when the piece was made (shown on the page). `publish_at` (optional) = the moment it
  becomes public; until then it is invisible on the page, permalinks and both feeds. The §1 order
  is by public moment (`publish_at`, else `posted_at`).
- **Privacy:** new work carries image, date and kind only. No prompts, recipes, notes or piece
  names, ever. PNG text/exif chunks are stripped server-side before upload.

### Video

Video entries add `media: "video"`, `mime`, `duration`, `poster`, `poster_public_id` (`url` is the
video, `poster` its first non-black frame as a stripped PNG). Accepted on `/api/post` (field
`video`, kinds flux|studio|upload) and on `/upload` (same field as images; the type is sniffed).

- **Validation:** the container is sniffed from magic bytes (ISO-BMFF `ftyp` or EBML), then
  forced on ffprobe/ffmpeg (`-f mov` / `-f matroska`, `-protocol_whitelist file`), so ffmpeg
  never auto-picks a demuxer that reads other files. mp4/mov must be H.264 (+AAC); webm VP8/VP9
  (+Opus/Vorbis).
- **Caps:** 90 MB (Cloudflare's free plan rejects request bodies over 100 MB), 180 s, 4096 px.
- **Stripping:** re-mux of the first video + first audio stream only (drops data, subtitle and
  timed-metadata tracks such as phone GPS), `-map_metadata -1` (global and per-stream),
  `-map_chapters -1`, bitexact (no encoder tags, zeroed mp4 creation times), empty
  `handler_name`/`encoder`, H.264 SEI NAL units removed (`filter_units=remove_types=6`: x264
  settings strings, user data). AAC and Vorbis audio is re-encoded (AAC hides the encoder
  version in the bitstream; Vorbis has a comment header); Opus is copied. mp4 gets faststart.
- **Render:** `<video>` with poster, `muted loop playsinline controls preload="metadata"`, no
  autoplay. Caption mark `▶︎ video` (U+25B6 + U+FE0E so iOS doesn't draw an emoji).
- **Feeds:** RSS `<enclosure>` + `media:content medium="video"` + thumbnail; JSON Feed
  `attachments`.
- Needs `ffmpeg` + `ffprobe` on PATH and `--allow-run=ffmpeg,ffprobe`; without them video posts
  get a 503 and images keep working.

## Routes

| route | auth | notes |
|---|---|---|
| `GET /` | public | the record |
| `GET /p/:slug` | public | one piece, with og:image |
| `GET /rss.xml` | public | RSS 2.0, §1 only, live entries only, guid `417am.party:<slug>` |
| `GET /feed.json` | public | JSON Feed 1.1, same items |
| `GET/POST /upload` | Basic (`UPLOAD_PASSWORD`) | hand posting, Cloudinary `417am/uploads`, kind `upload`, caption shown |
| `POST /api/post` | Bearer (`POST_TOKEN`) | multipart `image` (PNG) or `video` (mp4/webm), `id`, `kind` (flux\|studio; video also upload), `date?`, `publish_at?`. Cloudinary `417am/now/<kind>`. Idempotent on `id` (a repeat returns `existed: true`, no upload). |
| `DELETE /api/post/:id` | Bearer | removes the entry from the manifest; the Cloudinary asset is kept |
| `PATCH /api/post/:id` | Bearer | JSON `{publish_at: iso \| null}`: reschedule a drip item |
| `GET /api/schedule` | Bearer | every live-manifest entry incl. not-yet-public ones |

`POST_TOKEN` must be set (32+ chars) or the API fails closed (401).

## Env

| var | notes |
|---|---|
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | cloud `ejf`; the secret signs uploads server-side |
| `UPLOAD_PASSWORD` | `/upload` basic auth; unset = fail closed |
| `POST_TOKEN` | API bearer token; unset = fail closed |
| `LIVE_MANIFEST` | path of the live manifest (VPS: `/data2/417am-data/now.json`) |
| `SITE_URL` | default `https://417am.party` (feeds, og tags) |
| `UMAMI_WEBSITE_ID` | optional; when set, every page loads `umami.tools.ejfox.com/script.js`. Events: `rss-click`, `feed-json-click`, `permalink-open`, `image-open`, `video-open`, `video-play` (once per video per page view, `{no}`), `outbound`, `archive-divider-view` (once, when §2 scrolls into view) |
| `PORT` | default `8417` |
| `MEDIA_DIR` | dev only: store files in this folder and serve them at `/media/` instead of Cloudinary (test the whole path with a temp `LIVE_MANIFEST` + `MEDIA_DIR`, nothing leaves the machine) |

## Run locally

```bash
cp .env.example .env   # fill in values
deno task dev          # http://localhost:8417
```

## Deploy

Push to `main`. The GitHub Action SSHes to the VPS and runs
`git fetch && git reset --hard origin/main && pm2 restart 417am` in `/data2/417am-site`
(pm2 runs `deno run ... --allow-run=ffmpeg,ffprobe --env-file=.env main.ts`; ffmpeg from Debian's
`ffmpeg` package). Caddy routes `417am.party` + `www` to
`localhost:8417` behind Cloudflare. `.env` and `/data2/417am-data/` are untouched by deploys.
