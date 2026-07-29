# Akshon Media — Go-Live / Migration Guide

This is the new Akshon Media website: a fast, SEO-first static site that replaces
the WordPress site, **keeping every existing link**. Follow the steps below to take
it live. Nothing you do in steps 1–4 touches `akshonmedia.com` — the switch only
happens in **Step 5**, when you point the domain.

---

## What was migrated

- **All 149 video posts** were imported from the old site — same URLs
  (`akshonmedia.com/video/<slug>/`), so their Google rankings and inbound links
  carry over with **zero redirects and zero loss**.
- Each post is now a **real, indexable page** with the YouTube video embedded, a
  written article (pulled from the video description), `VideoObject` schema, and a
  unique title/description. The old pages had no article text — this is the SEO upgrade.
- Core pages rebuilt: **Home, Videos, Work With Us, About, Contact, Press**.
- The handful of URLs that changed (old case-study pages, duplicate homepages,
  category archives) get **301 redirects** — see `static/_redirects`.
- **Decap CMS** at `/admin` lets you add/edit posts in a form, no code.

---

## Step 1 — Deploy to Netlify (free)

1. Go to **app.netlify.com** → log in (use "Sign up with GitHub" with your
   `youngiethekim` account).
2. **Add new site → Import an existing project → GitHub →** pick
   **`akshon-website`**.
3. Netlify auto-detects the settings from `netlify.toml` (build command
   `python3 build.py`, publish dir `dist`). Click **Deploy**.
4. In ~1 minute you get a preview URL like `random-name.netlify.app`.

## Step 2 — Test the preview thoroughly

On the `.netlify.app` URL, click through:
- Home, Videos (try the category filters), a few video posts (video should play),
  Work With Us, About, Contact.
- Spot-check that a video plays and the article text reads correctly.

## Step 3 — Turn on the CMS login (so you can edit content)

1. In Netlify: **Site configuration → Identity → Enable Identity.**
2. Under Identity → **Registration**, set it to **Invite only**.
3. Under Identity → **Services → Git Gateway → Enable Git Gateway.**
4. Identity → **Invite users** → enter your email → accept the emailed invite and
   set a password.
5. Visit `your-site.netlify.app/admin` → log in with that email/password →
   you'll see all 149 videos and can add/edit posts. **Publish** commits the change
   and the site rebuilds automatically (~1 min).

## Step 4 — (Optional) Enable form submissions

The Contact and Work-With-Us forms are wired for **Netlify Forms**. They work
automatically once deployed; submissions show under **Netlify → Forms**. Add a
notification email under Forms → Settings if you want them forwarded.

## Step 5 — Point akshonmedia.com at the new site  ⚠️ this is the live switch

> Do this only after Steps 1–3 look good. This is the moment the public site changes.

1. In Netlify: **Domain management → Add a domain → `akshonmedia.com`.**
2. Netlify shows you DNS records. In your **domain registrar** (where you bought
   akshonmedia.com — GoDaddy/Namecheap/etc.), update DNS:
   - Easiest: set Netlify as your DNS (change nameservers to the ones Netlify lists), **or**
   - Keep your registrar's DNS and add the records Netlify shows (an `A`/`ALIAS`
     for the apex `akshonmedia.com` and a `CNAME` for `www`).
3. Netlify auto-provisions HTTPS (Let's Encrypt) once DNS resolves — usually
   minutes to a couple of hours.
4. Once live, the old WordPress hosting can be cancelled (keep a backup first).

### Rollback
If anything looks wrong, revert the DNS change at your registrar — the old site
comes back. Keep your WordPress host active for ~1–2 weeks as a safety net.

---

## After launch (recommended)

- **Google Search Console:** submit `https://akshonmedia.com/sitemap.xml` and use
  "Change of Address"? (not needed — same domain). Just re-submit the sitemap.
- **Redirect check:** visit an old URL like
  `akshonmedia.com/overwatch-league-akshon-media/` — it should 301 to
  `/work-with-us/`.
- **Confirm the stats** on the homepage and Work-With-Us page (they're placeholders:
  subscribers / total views / etc.) — edit them in `/admin → Site settings` or in
  `data/site.json`.
- **`/esports-industry-report/`** currently 301s to `/about/` as a placeholder — if
  you want that report page back, we can rebuild it.

## Adding a new video later (the everyday workflow)

1. Go to `akshonmedia.com/admin` → **Videos → New Video.**
2. Paste the **title**, pick a **date**, paste the **YouTube video ID** (the part
   after `watch?v=`), choose a **category**, and write a few paragraphs of **article
   body** (this is what helps it rank).
3. **Publish.** The post appears at `akshonmedia.com/video/<slug>/` within ~1 minute.

## Auto-generate a post from a YouTube link (AI summary tool)

There's a tool at **`akshonmedia.com/admin/generate.html`** (log in with the same
Netlify Identity account). Paste a YouTube link → it transcribes the video,
writes an SEO-optimized summary with Claude, and saves it as a **draft** post.
You review/edit it in `/admin` and publish. The whole page is engineered to send
readers to watch the full video on YouTube.

**To turn it on, add these environment variables** in Netlify → Site
configuration → Environment variables:

| Variable | What it is | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (writes the summary) | console.anthropic.com → API keys. Cost ≈ 1–2¢ per video. |
| `TRANSCRIPT_API_KEY` | Fetches the transcript automatically | supadata.ai (free tier available). If a video has no captions, paste the script into the tool instead — no key needed for that path. |
| `GITHUB_TOKEN` | Lets the tool save the draft post | GitHub → Settings → Developer settings → **Fine-grained token**, repo `akshon-website`, permission **Contents: Read and write**. |
| `GITHUB_REPO` | `youngiethekim/akshon-website` | — |

Optional: `CLAUDE_MODEL` (defaults to `claude-opus-4-8`; set `claude-haiku-4-5`
to cut cost ~5×), `GITHUB_BRANCH` (defaults to `main`).

The tool is a Netlify Function (`netlify/functions/generate-video.mjs`), gated
behind Identity login. Generated posts always start as `draft: true` and never
appear on the live site until you uncheck **Draft** and publish.

## How it's built (for a developer)

- Static site generated by `build.py` (Python, standard library only).
- Content: `content/videos/*.md` (front-matter + markdown). Settings: `data/site.json`.
- Design: `assets/css/site.css`; fonts in `assets/fonts`; images in `assets/img`.
- Build locally: `python3 build.py` → output in `dist/`. Preview:
  `cd dist && python3 -m http.server`.
