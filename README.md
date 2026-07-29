# Akshon Media — Website

The new [Akshon Media](https://akshonmedia.com) website: a fast, SEO-first static
site that replaces the old WordPress site while **preserving every existing URL**.

- **149 video posts** imported from WordPress, at their original
  `/video/<slug>/` URLs — each now a real, indexable page with the YouTube video
  embedded, a written article, and `VideoObject` schema.
- Pages: Home, Videos, Work With Us, About, Contact, Press.
- **Decap CMS** at `/admin` — add/edit content in a form, no code.
- 301 redirects for the few changed URLs (`static/_redirects`).

## 🚀 Going live
See **[MIGRATION.md](MIGRATION.md)** for the full step-by-step deploy + DNS cutover guide.

## Local development
```bash
python3 build.py        # generates dist/
cd dist && python3 -m http.server 8000   # preview at localhost:8000
```

## Structure
```
build.py            generator (Python stdlib only)
content/videos/     149 posts as markdown (Decap-editable)
data/site.json      stats, brands, offers (editable)
assets/             css, fonts, images
admin/              Decap CMS
static/             _redirects, robots.txt
netlify.toml        build config (command: python3 build.py, publish: dist)
```
