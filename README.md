# Akshon Media — Website

The new [Akshon Media](https://akshonmedia.com) website: a fast, SEO-first static
site that replaces the old WordPress site while **preserving every existing URL**.

- **149 video posts** imported from WordPress, at their original
  `/video/<slug>/` URLs — each now a real, indexable page with the YouTube video
  embedded, a written article, and `VideoObject` + `FAQPage` + `BreadcrumbList` schema.
- **Topic hubs** at `/topics/<tag>/`, generated from post tags (any tag with 3+
  videos gets a page). Posts link up to their hubs, hubs link back down and
  across to sibling topics.
- **Automatic interlinking**: each post gets contextual in-body links to related
  posts and topic hubs, a "Related videos" block, and prev/next links with real
  titles as anchor text. All of it computed at build time — nothing to maintain
  by hand.
- Pages: Home, Videos, Topics, Work With Us, About, Contact, Press.
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
build.py            generator (Python stdlib + PyYAML)
content/videos/     149 posts as markdown (Decap-editable)
data/site.json      stats, brands, offers (editable)
assets/             css, fonts, images
admin/              Decap CMS
scripts/            seo-audit.py + the batch SEO/FAQ generators
static/             _redirects, robots.txt
netlify.toml        build config (command: python3 build.py, publish: dist)
```

## SEO

`build.py` handles everything structural — schema, canonicals, breadcrumbs,
sitemap with `lastmod`, topic hubs, and internal links. What it can't do is
write prose, so there's an audit for that:

```bash
python3 scripts/seo-audit.py          # posts that need an editing pass, and why
python3 scripts/seo-audit.py --all    # every post
```

It flags the prose-level checks: does the opening paragraph actually answer the
question the post is about, is the primary keyword in an H2, is the meta
description the right length, are there enough FAQ entries.

### How interlinking works

- **In-body links** — on build, the first mention of another post's primary
  keyword or title (or of a topic hub) becomes a link. Max 5 per post, at most
  2 to topic hubs, and only to posts that share a tag, so anchors stay relevant.
- **Related videos** — scored on shared tags, keywords, and title words. Pin
  specific ones with the `related` field in the CMS to override.
- **Topic hubs** — `/topics/<tag>/`, built from the `tags` field. Tags are
  normalised (`Esports` and `esports` merge), and a tag needs 3+ videos before
  it gets a page, so there are no thin archives.
