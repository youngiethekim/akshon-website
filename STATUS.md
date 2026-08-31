# Status — video page SEO work

Last updated: 2026-08-31
Branch: `claude/video-page-seo-optimization-wtvj0t` (pushed, **not merged**)
`main` is unchanged at `06b7bd5`. Production has not been touched.

---

## Where things stand

The work splits into two halves. The first is done; the second is blocked.

| Half | Scope | State |
|---|---|---|
| **Structural** — schema, interlinking, topic hubs, generator fixes | `build.py`, `assets/css/site.css`, `admin/config.yml` | Done, committed, pushed |
| **Content** — the article format + answer-first openings across 150 posts | `content/videos/*.md` | **Blocked** — waiting on the format |

---

## Done and pushed

Commit `73bd43c` — "SEO: topic hubs, contextual interlinking, breadcrumbs + inline markdown".

### Interlinking (all computed at build time, nothing to maintain by hand)

- **Topic hubs** at `/topics/<tag>/` — 48 pages generated from post tags, plus a
  `/topics/` index and a nav entry. Tags are normalised (`Esports` and `esports`
  merge) and a tag needs 3+ videos before it gets a page, so there are no thin
  archives. Posts link up via topic chips; hubs link back down and across to
  sibling topics.
- **Contextual in-body links** — the first mention of another post's primary
  keyword/title, or of a topic hub, becomes a link. 336 links across 149 posts,
  capped at 5 per post (max 2 to hubs).

  The first pass linked generic phrases like "team fights" and "map control" to
  unrelated match pages. It's now gated two ways: an anchor drawn from a
  secondary keyword must name something concrete (contain a proper noun), and
  the target must share a tag with the source. That roughly halved link volume
  and made the anchors read naturally — `League of Legends` goes to the LoL hub,
  `Richard Garfield` to the Artifact deep-dive.
- **"Related videos"** block on every post, scored on shared tags, keywords and
  title words. Overridable per post with a new `related` field in the CMS.
- **Prev/next** now use real post titles as anchor text instead of "Newer"/"Older".

### Other on-page SEO

- `BreadcrumbList` schema plus a visible breadcrumb trail on posts and hubs.
- Richer `VideoObject` (`@id`, `mainEntityOfPage`, `inLanguage`, `keywords`);
  `CollectionPage`/`ItemList` on hubs.
- `og:type=article`, `article:published_time`, `article:tag`, `twitter:site`,
  and a `max-image-preview:large` robots directive.
- Sitemap gains `lastmod` and the topic pages (204 URLs).
- `id` anchors on every H2/H3, for jump-to-section results.

### Bug fixed

The markdown renderer escaped everything, so `**bold**`, `*italic*` and links
rendered as literal asterisks in post bodies. It now handles emphasis, inline
links and bullet lists.

### Tooling added

`scripts/seo-audit.py` — reports the prose-level gaps a build step can't fix.

```bash
python3 scripts/seo-audit.py          # posts that need an editing pass, and why
python3 scripts/seo-audit.py --all    # every post
```

---

## Blocked: the content pass

The original request asked for the video pages to match a specific format —
"the format transcribed below" — but the transcription didn't make it into the
message. Nothing about the layout is known, so this half hasn't started.

Current state of the 150 posts, from `scripts/seo-audit.py`:

```
150 posts — 25 clean, 125 need work
  111  h2-keyword        no H2 contains the primary keyword
   65  answer-first      opening paragraph doesn't answer the post's question
   17  meta              description outside 120–165 chars
    7  dup-h2            body opens with an H2 repeating the H1
    7  length            under 350 words
    6  intro-length      intro outside 40–90 words
```

So 65 posts genuinely fail the answer-first test. Rewriting those openings is
the same editing pass as applying the format — worth doing once, not twice.

### To unblock

1. **Paste the format.** Raw text, a link to a page whose structure to copy, or
   a description ("H1, then a 2-sentence answer, then key takeaways, then
   sections, then FAQ").
2. **Say whether it introduces new elements** (TL;DR box, key takeaways,
   timestamps) or just reorganises existing prose. New elements mean new
   frontmatter fields and CMS widgets in `admin/config.yml`, not just a text
   rewrite.
3. **Pick a scope.** Recommended: a 10-post pilot to approve the pattern before
   committing to the other 140 — the match-highlight posts and the documentary
   posts are different enough that one template may not fit both.

### Rough cost of the full pass

Source material is 150 files / 942K characters ≈ 255K tokens (bodies are 124K
of that; the FAQ frontmatter is larger than the articles).

| Approach | Tokens | Notes |
|---|---|---|
| Post-by-post in one session | ~3–6M | Context re-sent on every edit; several compactions |
| Subagents, ~10 posts each | ~500–800K | Fresh context per batch. Recommended. |
| Existing `scripts/seo-optimize-all.mjs` | ~1.2M in / 375K out | Runs on your own API key |

Biggest lever: edit bodies in place rather than rewriting whole files.
Frontmatter is 51% of the bytes and most of it is FAQ blocks that don't need to
change.

---

## Deploy chain

Verified from the repo. The Netlify dashboard itself wasn't inspected.

- **Netlify builds from GitHub.** `netlify.toml`: build
  `pip install -r requirements.txt && python3 build.py`, publish `dist/`,
  functions `netlify/functions/`.
- **The live site only changes when `main` changes.** The feature branch may
  produce a branch-deploy preview URL depending on a Netlify setting; that is
  not `akshonmedia.com`.

Two things checked before merging:

- **Python 3.9 compat** — `netlify.toml` pins `PYTHON_VERSION = "3.9"`. The new
  code uses no 3.10+ syntax. Separately worth knowing: newer Netlify build
  images have been dropping 3.9. If a build ever fails with a Python-not-found
  error, bump that pin to 3.11. Pre-existing, not introduced here.
- **PyYAML-missing fallback** — `build.py` falls back to a flat frontmatter
  parser if PyYAML doesn't install. Simulated: the build still completes all 149
  posts, degrading to no topic pages and no FAQ blocks rather than failing.

---

## Known risk: the SEO bot can clobber the content pass

Both workflows in `.github/workflows/` have `contents: write` and **commit
directly to `main`, then push** — which triggers a production deploy.

They're `workflow_dispatch` only, so they never fire on their own. But
`scripts/seo-optimize-all.mjs` **rewrites the bodies of `content/videos/*.md`**.
Running that workflow after the content pass would overwrite the new openings.

Two options:

1. Don't run `seo-optimize-all` while the content pass is in flight.
2. Fold the new format into the script's rubric so bot runs and hand edits agree.

Option 2 is better — otherwise the format drifts every time the bot runs.

---

## Next steps

- [ ] Provide the article format (blocking)
- [ ] Review the branch: `python3 build.py && cd dist && python3 -m http.server 8000` —
      check `/topics/` and the bottom of any post
- [ ] Decide pilot vs. full run for the content pass
- [ ] Update the `seo-optimize-all.mjs` rubric to match the new format
- [ ] Merge to `main` (triggers the production deploy)
