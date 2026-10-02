# Posting new art to 417am.party

The site is a gallery + one hidden upload page. There's no public link to it on
the site (by design) — bookmark this.

## Where

**https://417am.party/upload**

## Logging in

It's HTTP Basic Auth — any username, and the shared password. The password
lives in `/data2/417am-site/.env` on the VPS as `UPLOAD_PASSWORD`. To see it:

```bash
ssh vps "grep UPLOAD_PASSWORD /data2/417am-site/.env"
```

To change it:

```bash
ssh vps "sed -i 's/^UPLOAD_PASSWORD=.*/UPLOAD_PASSWORD=your-new-password/' /data2/417am-site/.env && pm2 restart 417am"
```

Your browser will remember the password after the first login (until you clear
site data), so you only enter it once per device.

## Posting

1. Go to `/upload`.
2. Pick an image.
3. Optional caption (plain text, 280 chars max).
4. Hit "post it."

It uploads straight to Cloudinary (folder `417am/uploads`) and shows up at the
top of the gallery immediately — no deploy, no wait.

## Nothing else to configure

No accounts, no drafts, no scheduling. It's meant to be as fast as posting to
Tumblr used to be. If you want something fancier later (multi-image posts,
editing captions after the fact, deleting a post), that's a `main.ts` change,
not a config option — ping Claude.
