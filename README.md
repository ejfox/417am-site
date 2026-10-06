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

## Routes

| route | auth | notes |
|---|---|---|
| `GET /` | public | the record |
| `GET /p/:slug` | public | one piece, with og:image |
| `GET /rss.xml` | public | RSS 2.0, §1 only, live entries only, guid `417am.party:<slug>` |
| `GET /feed.json` | public | JSON Feed 1.1, same items |
| `GET/POST /upload` | Basic (`UPLOAD_PASSWORD`) | hand posting, Cloudinary `417am/uploads`, kind `upload`, caption shown |
| `POST /api/post` | Bearer (`POST_TOKEN`) | multipart `image` (PNG), `id`, `kind` (flux\|studio), `date?`, `publish_at?`. Cloudinary `417am/now/<kind>`. Idempotent on `id` (a repeat returns `existed: true`, no upload). |
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
| `PORT` | default `8417` |

## Run locally

```bash
cp .env.example .env   # fill in values
deno task dev          # http://localhost:8417
```

## Deploy

Push to `main`. The GitHub Action SSHes to the VPS and runs
`git fetch && git reset --hard origin/main && pm2 restart 417am` in `/data2/417am-site`
(pm2 runs `deno run ... --env-file=.env main.ts`). Caddy routes `417am.party` + `www` to
`localhost:8417` behind Cloudflare. `.env` and `/data2/417am-data/` are untouched by deploys.
