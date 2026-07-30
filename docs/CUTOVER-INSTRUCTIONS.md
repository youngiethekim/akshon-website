# akshonmedia.com — DNS Cutover Instructions

**Goal:** point `akshonmedia.com` from the old WordPress site to the new site hosted on
**Netlify**, **without breaking email and without losing SEO**.

The new site is already built, live, and tested here: **https://akshon.netlify.app**

## ⚠️ Two hard rules

1. **Do NOT change the domain's nameservers to Netlify.** We are keeping the current
   DNS provider and only changing the website records. Switching nameservers would move
   DNS control (including the **MX / email records** for `@akshonmedia.com`) and can break
   email. We only touch the web records below.
2. **Do NOT delete or edit any `MX`, `TXT`, `SPF`, `DKIM`, or email-related records.**
   Leave everything except the two web records untouched.

## Access needed

- **Netlify** account access for the site (to add the custom domain). Site: `akshon.netlify.app`.
- **DNS access** for `akshonmedia.com` (the current registrar / DNS host).

---

## Step 1 — Add the domain in Netlify

1. Netlify → the **akshon** site → **Domain management** (a.k.a. Domains) → **Add a domain**.
2. Enter `akshonmedia.com`. Also add `www.akshonmedia.com`.
3. Netlify will detect the domain is registered elsewhere. Choose the **external DNS /
   "point your DNS to Netlify" option** — **NOT** "Delegate to Netlify / use Netlify DNS."
4. Netlify shows the exact records to create. They will be:
   - **Apex** `akshonmedia.com` → **A record** → `75.2.60.5` (use whatever IP Netlify displays)
   - **`www`** → **CNAME** → `akshon.netlify.app`

## Step 2 — Record the current value (for rollback)

Before changing anything, note the **current A record** for `akshonmedia.com` (the WordPress
host's IP). Write it down — that's the rollback value.

## Step 3 — Change the two web records at the DNS host

- Edit the **apex `A` record** for `@` / `akshonmedia.com` → set it to Netlify's IP
  (`75.2.60.5`, or whatever Netlify's panel showed). Remove any extra/duplicate apex A
  records pointing at the old host.
- Set the **`www` CNAME** → `akshon.netlify.app`.
- **Leave all MX / email / TXT records exactly as they are.**
- **Do not change nameservers.**

> If the DNS host doesn't allow a CNAME on `www` alongside other records, a CNAME on `www`
> is standard and fine. If it refuses an apex `A` edit, use Netlify's displayed value type
> (some hosts use `ALIAS`/`ANAME` for apex — follow what Netlify's panel recommends).

## Step 4 — HTTPS

Once the records resolve (minutes to a couple of hours), Netlify auto-issues an HTTPS
certificate (Let's Encrypt). In Netlify → Domain management:
- Set `akshonmedia.com` as the **primary domain** (www will redirect to it).
- Enable **Force HTTPS**.

## Step 5 — Verify

- `https://akshonmedia.com` loads the new site (dark hero, "AKSHON MEDIA").
- A video post loads, e.g. `https://akshonmedia.com/videos/`.
- An **old WordPress URL 301-redirects**, e.g.
  `https://akshonmedia.com/overwatch-league-akshon-media/` → `/work-with-us/`.
- Send/receive a test email on `@akshonmedia.com` to confirm mail is unaffected.

## Rollback

If anything looks wrong: at the DNS host, change the apex `A` record **back to the WordPress
IP** recorded in Step 2. DNS reverts within the TTL window. **Keep the WordPress hosting
active for ~1–2 weeks** after cutover as a safety net before cancelling it.

## Notes

- All 149 existing `/video/<slug>/` URLs are preserved unchanged, so their Google rankings
  and inbound links carry over. Only a handful of old page URLs (e.g. case-study pages)
  change and are handled by 301 redirects already configured on the new site.
- After go-live: in Google Search Console, resubmit the sitemap `https://akshonmedia.com/sitemap.xml`.
