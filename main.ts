// 417am.party — a shit-ton-of-images gallery + tumblr-simple upload page.
// Single-file Deno + Hono app, smallweb style. No build step, no framework bloat.
//
// Routes:
//   GET  /              gallery, newest first
//   GET  /upload         basic-auth protected upload form
//   POST /upload         basic-auth protected, uploads image to Cloudinary,
//                        appends {url, caption, date} to data/art.json
//
// Env (see .env.example):
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//   UPLOAD_PASSWORD   shared password for the upload page (basic auth)
//   PORT              default 8417

import { Hono } from "jsr:@hono/hono";

const MANIFEST_PATH = new URL("./data/art.json", import.meta.url);

type ArtEntry = { url: string; caption: string; date: string };

async function readManifest(): Promise<ArtEntry[]> {
  try {
    const text = await Deno.readTextFile(MANIFEST_PATH);
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function appendManifest(entry: ArtEntry): Promise<void> {
  const entries = await readManifest();
  entries.unshift(entry); // newest first on disk too
  await Deno.writeTextFile(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

// ---- Cloudinary signed upload (no SDK — raw REST + Web Crypto SHA-1) -------

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-1", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function uploadToCloudinary(file: File): Promise<string> {
  const cloudName = Deno.env.get("CLOUDINARY_CLOUD_NAME");
  const apiKey = Deno.env.get("CLOUDINARY_API_KEY");
  const apiSecret = Deno.env.get("CLOUDINARY_API_SECRET");
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Missing CLOUDINARY_* env vars");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = "417am/uploads";
  // Signature = sha1(sorted params (excluding file/api_key/signature) + secret)
  const toSign = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = await sha1Hex(toSign);

  const form = new FormData();
  form.set("file", file);
  form.set("api_key", apiKey);
  form.set("timestamp", String(timestamp));
  form.set("folder", folder);
  form.set("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    throw new Error(`Cloudinary upload failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.secure_url as string;
}

// ---- Basic auth for /upload -------------------------------------------------

function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="417am"' },
  });
}

function checkBasicAuth(req: Request): boolean {
  const password = Deno.env.get("UPLOAD_PASSWORD");
  if (!password) return false; // fail closed if unset
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const [, pass] = decoded.split(":");
    return pass === password;
  } catch {
    return false;
  }
}

// ---- HTML templates ---------------------------------------------------------

const PAGE_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0a0a0a; color: #e5e5e5;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  header {
    padding: 2rem 1.5rem 1rem; border-bottom: 1px solid #222;
  }
  header h1 {
    margin: 0; font-size: 1.1rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: #fff;
  }
  header p { margin: 0.4rem 0 0; color: #777; font-size: 0.85rem; }
  header a { color: #999; }
  .grid {
    display: grid; grid-template-columns: 1fr; gap: 1px; background: #111;
  }
  @media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } }
  figure { margin: 0; background: #0a0a0a; position: relative; }
  figure img { display: block; width: 100%; height: auto; }
  figcaption {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 0.6rem 0.8rem;
    background: linear-gradient(transparent, rgba(0,0,0,0.85));
    font-size: 0.75rem; color: #ccc;
  }
  figcaption time { color: #888; margin-left: 0.5rem; }
  form {
    max-width: 420px; margin: 2rem auto; padding: 1.5rem; display: grid; gap: 1rem;
  }
  label { font-size: 0.8rem; color: #999; display: block; margin-bottom: 0.3rem; }
  input[type="text"], input[type="file"] {
    width: 100%; padding: 0.6rem; background: #141414; border: 1px solid #333;
    color: #eee; font-family: inherit; font-size: 0.9rem;
  }
  button {
    padding: 0.7rem; background: #fff; color: #000; border: none; cursor: pointer;
    font-family: inherit; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase;
  }
  .msg { max-width: 420px; margin: 1rem auto; padding: 0 1.5rem; font-size: 0.85rem; }
  .msg.err { color: #f87171; }
  .msg.ok { color: #4ade80; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function galleryPage(entries: ArtEntry[]): string {
  const items = entries
    .map((e) => {
      const d = new Date(e.date);
      const dateStr = isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
      return `<figure>
        <img src="${escapeHtml(e.url)}" loading="lazy" alt="${escapeHtml(e.caption)}">
        <figcaption>${escapeHtml(e.caption)}<time>${dateStr}</time></figcaption>
      </figure>`;
    })
    .join("\n");

  return layout(
    "417am.party",
    `<header>
      <h1>417am.party</h1>
      <p>generative art, since 2017 &middot; originally @417am1975 &middot; <a href="/upload">post</a></p>
    </header>
    <div class="grid">${items}</div>`,
  );
}

function uploadPage(message?: { ok: boolean; text: string }): string {
  const msg = message
    ? `<p class="msg ${message.ok ? "ok" : "err"}">${escapeHtml(message.text)}</p>`
    : "";
  return layout(
    "post — 417am.party",
    `<header><h1>417am.party</h1><p><a href="/">&larr; gallery</a></p></header>
    ${msg}
    <form method="post" enctype="multipart/form-data" action="/upload">
      <div>
        <label for="image">image</label>
        <input type="file" id="image" name="image" accept="image/*" required>
      </div>
      <div>
        <label for="caption">caption (optional)</label>
        <input type="text" id="caption" name="caption" maxlength="280">
      </div>
      <button type="submit">post it</button>
    </form>`,
  );
}

// ---- App --------------------------------------------------------------------

const app = new Hono();

app.get("/", async (c) => {
  const entries = await readManifest();
  entries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return c.html(galleryPage(entries));
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

    const url = await uploadToCloudinary(file);
    await appendManifest({ url, caption, date: new Date().toISOString() });

    return c.html(uploadPage({ ok: true, text: "Posted. Check the gallery." }));
  } catch (err) {
    console.error(err);
    const text = err instanceof Error ? err.message : "Upload failed";
    return c.html(uploadPage({ ok: false, text }), 500);
  }
});

const port = Number(Deno.env.get("PORT") || 8417);
console.log(`417am.party listening on :${port}`);

Deno.serve({ port }, app.fetch);
