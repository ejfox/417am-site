# 417am.party

Relaunch of the old `@417am1975` generative-art Twitter bot's home. Two jobs:

1. **Gallery** — shows all art, newest first, big images, dark background, no chrome.
2. **Post** — a password-protected `/upload` page: pick an image, optional caption,
   hit post. It uploads to Cloudinary and appends an entry to `data/art.json`.
   "Tumblr-simple" is the whole design brief — no CMS, no build step, no login
   system beyond one shared password.

Single file (`main.ts`), Deno + Hono, in the same style as
[`smallweb-starter`](https://github.com/ejfox/smallweb-starter) (EJ's existing
pattern for small self-hosted Deno apps). No database — the manifest is a flat
JSON file.

## Stack

- **Runtime**: Deno (no npm install, no node_modules)
- **Framework**: [Hono](https://hono.dev/) via `jsr:@hono/hono`
- **Storage**: Cloudinary for images (cloud name `ejf`, same account as
  website2), `data/art.json` for the manifest — `[{url, caption, date}]`,
  newest entries first.
- **Auth**: HTTP Basic auth on `/upload` only, single shared password from
  `UPLOAD_PASSWORD`. The gallery itself is fully public.

## Seed content

`data/art.json` ships pre-populated with the 9 existing pieces already on
Cloudinary (`projects/twitter-artbot/piece-01.png` … `piece-09.png`), dated
`2017-06-11` (the original bot's era) and captioned as being from the original
`@417am1975` bot. No re-upload needed — they're referenced by URL.

## Run it locally

```bash
cd ~/code/417am-site
cp .env.example .env
# fill in CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET (cloud name is already "ejf")
# pick an UPLOAD_PASSWORD

deno task dev     # watch mode, http://localhost:8417
# or
deno task start   # no watch
```

No `deno install` step — Deno fetches `jsr:@hono/hono` on first run and caches
it (`deno.lock` pins the version).

## Env vars

| var | required | notes |
|---|---|---|
| `CLOUDINARY_CLOUD_NAME` | yes | `ejf` — same account as website2 |
| `CLOUDINARY_API_KEY` | yes | from Cloudinary dashboard |
| `CLOUDINARY_API_SECRET` | yes | from Cloudinary dashboard — used to sign uploads server-side, never exposed to the client |
| `UPLOAD_PASSWORD` | yes | shared password for `/upload` (any username works with basic auth); if unset, `/upload` fails closed (401 on everything) |
| `PORT` | no | default `8417` |

## How upload works

`/upload` is a plain HTML form (`multipart/form-data`). The server signs a
Cloudinary upload request itself (SHA-1 over `folder=...&timestamp=...` +
secret, per [Cloudinary's signed-upload spec](https://cloudinary.com/documentation/signatures)),
POSTs the file straight to Cloudinary's REST API (no SDK dependency — just
`fetch` and `crypto.subtle`), then appends `{url, caption, date}` to
`data/art.json`. New uploads land in the `417am/uploads` Cloudinary folder,
separate from the seeded `projects/twitter-artbot` pieces.

## DRAFT deploy plan (not executed — for EJ or a future Claude session to run)

Mirrors website2's actual production pattern: pm2 process on the VPS, Caddy
reverse-proxying a subdomain-free custom domain, Cloudflare handling DNS/SSL
in front of it. **Nothing below has been run.**

### 1. Ship the code to the VPS

```bash
# from a local machine, after committing
rsync -av --exclude .env --exclude .git ~/code/417am-site/ vps:/data2/417am-site/
# or: git clone the repo directly on the VPS into /data2/417am-site
```

### 2. Create `.env` on the VPS (not committed)

```bash
ssh vps 'cat > /data2/417am-site/.env' <<'EOF'
CLOUDINARY_CLOUD_NAME=ejf
CLOUDINARY_API_KEY=<real key>
CLOUDINARY_API_SECRET=<real secret>
UPLOAD_PASSWORD=<real password>
PORT=8417
EOF
```

### 3. pm2 process

Deno apps run under pm2 by wrapping the `deno run` invocation directly (no
`ecosystem.config.cjs` needed for something this small, but one could be added
to match website2's pattern):

```bash
ssh vps 'cd /data2/417am-site && pm2 start "deno run --allow-net --allow-env --allow-read --allow-write --env-file=.env main.ts" --name 417am'
ssh vps 'pm2 save'
```

### 4. Caddy site block

Add to `/etc/caddy/Caddyfile` on the VPS:

```
417am.party {
	reverse_proxy localhost:8417
}

www.417am.party {
	redir https://417am.party{uri}
}
```

Then `ssh vps 'sudo systemctl reload caddy'`.

### 5. Cloudflare DNS

Domain is already in EJ's Cloudflare account (registered via Cloudflare
Registrar). Point it at the VPS the same way `ejfox.com` is routed — either:

- A standard `A`/`AAAA` record at the VPS's public IP with Cloudflare proxy
  (orange cloud) on, so Cloudflare terminates TLS and Caddy's `auto_https off`
  pattern (seen in website2/smallweb's Caddyfile) applies, **or**
- A Cloudflare Tunnel hostname (`cloudflared`) pointed at `localhost:8417` or
  at Caddy on `:80`, matching the `tools.ejfox.com` wildcard-tunnel pattern
  documented for smallweb — this avoids opening any port on the VPS at all.

Given this is a single standalone domain (not a `*.tools.ejfox.com`
subdomain), the plain `A` record + Cloudflare proxy + Caddy reverse-proxy path
is simpler and matches how `ejfox.com` itself is set up — prefer that unless
EJ wants it folded into the existing tunnel.

### 6. Verify

```bash
curl -I https://417am.party
ssh vps 'pm2 logs 417am --lines 50 --nostream'
```

### Rollback / iterate

```bash
ssh vps 'pm2 restart 417am'   # after a code change + rsync
ssh vps 'pm2 delete 417am'    # tear down
```
