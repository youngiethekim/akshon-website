#!/usr/bin/env python3
"""Akshon Media static site generator (stdlib only).
Reads content/*.md + data/site.json, renders dist/ with real per-page URLs & SEO.
Build: python3 build.py   ->   publish dir: dist/
"""
import os, re, json, shutil, html

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
SITE_URL = "https://akshonmedia.com"

# ---------- helpers ----------
def read(p): return open(os.path.join(ROOT, p), encoding="utf8").read()

try:
    import yaml  # PyYAML — parses structured frontmatter (e.g. the FAQ list)
except Exception:
    yaml = None

def parse_md(path):
    raw = open(path, encoding="utf8").read()
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", raw, re.S)
    if not m:
        return {}, raw
    front, body = m.group(1), m.group(2).strip()
    fm = {}
    if yaml is not None:
        try:
            fm = yaml.safe_load(front) or {}
        except Exception:
            fm = {}
    if not fm:  # fallback: flat key:value parser (no structured fields)
        for line in front.splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip().strip('"')
    return fm, body

LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")

def inline_md(text):
    """Escape, then render inline markdown: links, **bold**, *italic*."""
    slots = []
    def stash(m):
        slots.append((m.group(1), m.group(2)))
        return f"\x00{len(slots)-1}\x00"
    text = LINK_RE.sub(stash, text)
    out = html.escape(text)
    out = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<![\*\w])\*([^*\n]+)\*(?!\w)", r"<em>\1</em>", out)
    def unstash(m):
        label, href = slots[int(m.group(1))]
        label = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", html.escape(label))
        ext = ' rel="noopener" target="_blank"' if href.startswith("http") else ""
        return f'<a href="{esc(href)}"{ext}>{label}</a>'
    return re.sub(r"\x00(\d+)\x00", unstash, out)

def md_body_to_html(body):
    """Minimal markdown: blank-line paragraphs, ## / ### headings, - lists."""
    out = []
    for block in re.split(r"\n\s*\n", body.strip()):
        b = block.strip()
        if not b: continue
        if b.startswith("### "): out.append(f"<h3 id=\"{slugify(b[4:])}\">{inline_md(b[4:])}</h3>")
        elif b.startswith("## "): out.append(f"<h2 id=\"{slugify(b[3:])}\">{inline_md(b[3:])}</h2>")
        elif all(l.strip().startswith(("- ", "* ")) for l in b.splitlines()):
            lis = "".join(f"<li>{inline_md(l.strip()[2:])}</li>" for l in b.splitlines())
            out.append(f"<ul>{lis}</ul>")
        else: out.append(f"<p>{inline_md(b)}</p>")
    return "\n".join(out)

def slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-")

def esc(s): return html.escape(s or "", quote=True)

CAT_LABEL = {"originals": "Originals", "press": "Press"}
def cat_label(c): return CAT_LABEL.get(c, c.title())

def write(path, content):
    fp = os.path.join(DIST, path)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    open(fp, "w", encoding="utf8").write(content)

# ---------- load content ----------
def load_videos():
    vids = []
    vdir = os.path.join(ROOT, "content/videos")
    for fn in os.listdir(vdir):
        if not fn.endswith(".md"): continue
        fm, body = parse_md(os.path.join(vdir, fn))
        if str(fm.get("draft", "")).lower() == "true":
            continue  # drafts are hidden from the live site until published
        slug = fn[:-3]
        def strlist(key):
            raw = fm.get(key) or []
            if isinstance(raw, str): raw = [raw]
            return [str(x).strip() for x in raw if str(x).strip()]
        vids.append({
            "slug": slug,
            "title": fm.get("title", slug),
            "date": str(fm.get("date", "") or ""),
            "youtube_id": str(fm.get("youtube_id", "") or ""),
            "category": fm.get("category", "originals"),
            "thumbnail": fm.get("thumbnail") or f"https://i.ytimg.com/vi/{fm.get('youtube_id','')}/hqdefault.jpg",
            "description": fm.get("description", ""),
            "primary_keyword": str(fm.get("primary_keyword", "") or "").strip(),
            "secondary_keywords": strlist("secondary_keywords"),
            "tags": strlist("tags"),
            "related": strlist("related"),
            "faq": [q for q in (fm.get("faq") or []) if isinstance(q, dict) and q.get("question") and q.get("answer")],
            "body": body,
            "url": f"/video/{slug}/",
        })
    vids.sort(key=lambda v: v["date"], reverse=True)
    return vids

# ---------- topics (tag hubs) ----------
TOPIC_MIN = 3          # a hub page needs at least this many videos to be worth indexing
TOPIC_MAX_PER_POST = 4  # topic chips shown on a post

def build_topic_index(videos):
    """Normalise the free-form tags into canonical topics -> {slug: {label, videos}}."""
    buckets = {}
    for v in videos:
        for t in v["tags"]:
            s = slugify(t)
            if not s: continue
            b = buckets.setdefault(s, {"slug": s, "labels": {}, "videos": []})
            b["labels"][t] = b["labels"].get(t, 0) + 1
            if v not in b["videos"]:
                b["videos"].append(v)
    topics = {}
    for s, b in buckets.items():
        if len(b["videos"]) < TOPIC_MIN: continue
        label = max(b["labels"].items(), key=lambda kv: (kv[0][:1].isupper(), kv[1]))[0]
        b["videos"].sort(key=lambda v: v["date"], reverse=True)
        topics[s] = {"slug": s, "label": label, "url": f"/topics/{s}/", "videos": b["videos"]}
    return topics

def topics_for(v, topics):
    """The indexable topics this video belongs to, rarest (most specific) first."""
    mine = [topics[slugify(t)] for t in v["tags"] if slugify(t) in topics]
    seen, out = set(), []
    for t in sorted(mine, key=lambda t: len(t["videos"])):
        if t["slug"] not in seen:
            seen.add(t["slug"]); out.append(t)
    return out[:TOPIC_MAX_PER_POST]

# ---------- related posts ----------
STOP = set("the a an and or of to in on for is are was were how why what who when "
           "with vs this that it its at by from as be but not you your we our".split())

def title_tokens(v):
    return {w for w in re.findall(r"[a-z0-9]+", v["title"].lower()) if w not in STOP and len(w) > 2}

def related_for(v, videos, by_slug, n=4):
    """Curated `related:` slugs first, then tag / keyword / title overlap."""
    picked, seen = [], {v["slug"]}
    for s in v["related"]:
        r = by_slug.get(s.strip("/").split("/")[-1])
        if r and r["slug"] not in seen:
            seen.add(r["slug"]); picked.append(r)
    if len(picked) >= n: return picked[:n]

    mytags = {slugify(t) for t in v["tags"]}
    mykw = {k.lower() for k in v["secondary_keywords"] + [v["primary_keyword"]] if k}
    mytok = title_tokens(v)
    scored = []
    for o in videos:
        if o["slug"] in seen: continue
        score = 3 * len(mytags & {slugify(t) for t in o["tags"]})
        score += 2 * len(mykw & {k.lower() for k in o["secondary_keywords"] + [o["primary_keyword"]] if k})
        score += len(mytok & title_tokens(o))
        if score: scored.append((score, o["date"] or "", o))
    scored.sort(key=lambda x: x[1], reverse=True)   # newest first...
    scored.sort(key=lambda x: -x[0])                # ...then stable-sort by relevance
    for _, _, o in scored:
        if len(picked) >= n: break
        picked.append(o); seen.add(o["slug"])
    return picked[:n]

# ---------- contextual in-body internal links ----------
MAX_AUTOLINKS = 5       # per post — enough to pass link equity, few enough to stay readable
MAX_TOPIC_LINKS = 2     # of those, how many may point at a topic hub rather than a video

# Too generic to be a useful anchor — they still get hub pages, just no in-body autolinks.
GENERIC_TAGS = {"esports", "gaming", "video games", "competitive gaming", "tournament",
                "highlights", "playoffs", "press conference", "gaming industry",
                "gaming analysis", "gaming culture", "esports highlights", "multiplayer games",
                "game design", "game development", "esports history", "gaming history"}

def is_entity(p):
    """Proper-noun-ish? 'League of Legends' yes, 'ultimate economy' no."""
    words = [w for w in p.split() if len(w) > 2]
    return any(w[:1].isupper() or w[:1].isdigit() for w in words)

def link_phrases(videos, topics):
    """Anchor phrase -> (phrase, target-key, url, kind). Deep video links rank above hubs."""
    vid_p, top_p = {}, {}
    for t in topics.values():
        for label in {t["label"]} | {tag for v in t["videos"] for tag in v["tags"] if slugify(tag) == t["slug"]}:
            if label.lower() in GENERIC_TAGS or len(label) < 5: continue
            top_p.setdefault(label.lower(), (label, "topic:" + t["slug"], t["url"], "topic"))
    for v in videos:
        # A post's own keyword / title always describes it. Secondary keywords only earn a
        # link when they name something concrete — otherwise "team fights" ends up pointing
        # at an unrelated match page.
        cands = [v["primary_keyword"], re.sub(r"\s*[—–:|]\s*.*$", "", v["title"] or "")]
        cands += [k for k in v["secondary_keywords"] if is_entity(k)]
        for p in cands:
            p = (p or "").strip()
            if len(p.split()) < 2 or len(p) < 10: continue
            if p.lower() in top_p: continue   # a topic hub is the better home for a tag phrase
            vid_p.setdefault(p.lower(), (p, v["slug"], v["url"], "video"))
    # longest phrase first, so "Overwatch League Season 2" beats "Overwatch League"
    key = lambda x: -len(x[0])
    return sorted(vid_p.values(), key=key) + sorted(top_p.values(), key=key)

def topical_kin(v, videos):
    """Slugs close enough to `v` that an in-body link to them is genuinely useful."""
    mytags = {slugify(t) for t in v["tags"]} - {slugify(g) for g in GENERIC_TAGS}
    mytok = title_tokens(v)
    return {o["slug"] for o in videos
            if (mytags & ({slugify(t) for t in o["tags"]} - {slugify(g) for g in GENERIC_TAGS}))
            or len(mytok & title_tokens(o)) >= 2}

def autolink(body, phrases, self_slug, self_topics=(), kin=None):
    """Link the first mention of another post's key phrase, or of a topic this post sits in."""
    blocks = re.split(r"(\n\s*\n)", body)
    used = {self_slug}
    added = topic_added = 0
    for i, blk in enumerate(blocks):
        if added >= MAX_AUTOLINKS: break
        if not blk.strip() or blk.lstrip().startswith("#"): continue
        per_block = 0
        for phrase, key, url, kind in phrases:
            if added >= MAX_AUTOLINKS or per_block >= 2: break
            if key in used: continue
            if kind == "video" and kin is not None and key not in kin:
                continue  # only link out to posts on the same subject
            if kind == "topic" and (topic_added >= MAX_TOPIC_LINKS or key in self_topics):
                continue  # the topic chips under the article already cover its own topics
            spans = [m.span() for m in LINK_RE.finditer(blocks[i])]
            m = next((c for c in re.finditer(r"(?<![\w\-])" + re.escape(phrase) + r"(?![\w\-])",
                                             blocks[i], re.I)
                      if not any(a <= c.start() < b for a, b in spans)), None)
            if not m: continue
            blocks[i] = blocks[i][:m.start()] + f"[{m.group(0)}]({url})" + blocks[i][m.end():]
            used.add(key); added += 1; per_block += 1
            if kind == "topic": topic_added += 1
    return "".join(blocks)

SITE = json.load(open(os.path.join(ROOT, "data/site.json")))

# ---------- layout ----------
def head(title, desc, path, og_image=None, extra="", og_type="website"):
    canonical = SITE_URL + path
    ogimg = og_image or (SITE_URL + "/assets/img/hero-main.jpg")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="canonical" href="{canonical}">
<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1">
<meta property="og:type" content="{og_type}">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{ogimg}">
<meta property="og:site_name" content="Akshon Media">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@akshonmedia">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="preconnect" href="https://www.youtube-nocookie.com">
<link rel="stylesheet" href="/assets/css/site.css">
{extra}
</head>
<body>
{nav(path)}
<main>
"""

NAV = [("/", "Home", "home"), ("/videos/", "Videos", "videos"), ("/topics/", "Topics", "topics"),
       ("/work-with-us/", "Work With Us", "work"), ("/about/", "About", "about"),
       ("/contact/", "Contact", "contact")]
def nav(path):
    def active(href):
        if href == "/": return path == "/"
        return path.startswith(href)
    parts = []
    for href, label, _ in NAV:
        cls = ' class="on"' if active(href) else ''
        parts.append(f'<a href="{href}"{cls}>{label}</a>')
    links = "".join(parts)
    return f"""<nav aria-label="Main">
  <div class="nav-in">
    <a class="nav-logo" href="/" aria-label="Akshon Media home"><img src="/assets/img/logo-white.png" alt="Akshon Media"></a>
    <div class="nav-links">{links}</div>
  </div>
</nav>"""

def footer():
    return """</main>
<footer><div class="wrap">
<div class="ft">
  <div><div class="logo"><img src="/assets/img/logo-white.png" alt="Akshon Media"></div>
    <p class="about">Telling the stories that move gamers. Documentaries, esports coverage, and original content from inside the gaming world.</p></div>
  <div><h4>Explore</h4><ul>
    <li><a href="/videos/">Videos</a></li><li><a href="/topics/">Topics</a></li><li><a href="/work-with-us/">Work With Us</a></li><li><a href="/about/">About</a></li></ul></div>
  <div><h4>Company</h4><ul>
    <li><a href="/about/">About Us</a></li><li><a href="/contact/">Contact</a></li><li><a href="/press/">Press</a></li></ul></div>
  <div><h4>Follow</h4><ul>
    <li><a href="https://www.youtube.com/c/Akshonmedia" rel="noopener">YouTube</a></li>
    <li><a href="https://www.instagram.com/akshonmedia" rel="noopener">Instagram</a></li>
    <li><a href="https://x.com/akshonmedia" rel="noopener">X / Twitter</a></li>
    <li><a href="https://discord.gg/akshon" rel="noopener">Discord</a></li>
    <li><a href="https://www.linkedin.com/company/akshon-media" rel="noopener">LinkedIn</a></li></ul></div>
</div>
<div class="ft-bar"><span>&copy; 2026 Akshon Media Inc. All rights reserved.</span>
<span>801&ndash;838 W Hastings St, Vancouver, BC</span></div>
</div></footer>
<script src="https://identity.netlify.com/v1/netlify-identity-widget.js"></script>
<script>if(window.netlifyIdentity){window.netlifyIdentity.on("init",function(u){if(!u){window.netlifyIdentity.on("login",function(){document.location.href="/admin/";});}});}</script>
</body></html>"""

def vcard(v):
    return f"""<a class="vcard" href="{v['url']}"><div class="im"><img src="{v['thumbnail']}" alt="{esc(v['title'])}" loading="lazy" width="480" height="270"><div class="play"><span>&#9654;</span></div></div><div class="t">{esc(v['title'])}</div><div class="d">{cat_label(v['category'])} &middot; {fmt_date(v['date'])}</div></a>"""

MONTHS = ["","January","February","March","April","May","June","July","August","September","October","November","December"]
def fmt_date(d):
    m = re.match(r"(\d{4})-(\d{2})", d or "")
    return f"{MONTHS[int(m.group(2))]} {m.group(1)}" if m else ""

def brands_block():
    b = SITE["brands"]
    cells = "".join(
        f'<div class="cell{" inv" if x.get("inv") else ""}"><img src="{x["img"]}" alt="{esc(x["name"])}"></div>'
        for x in b)
    return f'<div class="brands rv">{cells}</div>'

# ---------- pages ----------
def build_home(videos):
    latest = videos[:6]
    cards = "".join(vcard(v) for v in latest)
    s = SITE["stats_home"]
    stat = "".join(f'<div class="stat"><div class="n">{x["n"]}</div><div class="l">{x["l"]}</div></div>' for x in s)
    html_out = head("Akshon Media — Esports Documentaries & Original Series",
        "Akshon Media is a collective of passionate creators telling the stories that move gamers — documentaries, esports coverage, and original series from inside the game.",
        "/", extra=SITE_LD)
    html_out += f"""
<div class="banner">
  <div class="banner-bg" role="img" aria-label="Akshon crew backstage at an esports event"></div>
  <div class="scan" aria-hidden="true"></div>
  <div class="vf" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
  <div class="hud hud-p1" aria-hidden="true"><span>P1 &middot; Akshon Media</span><span class="hpbar"><i></i></span></div>
  <div class="hud hud-score" aria-hidden="true"><span class="num" id="score">0</span><span class="lbl">Total views</span></div>
  <div class="hud hud-lvl" aria-hidden="true">LVL 10 &middot; Storyteller</div>
  <div class="playhead" aria-hidden="true"></div>
  <div class="banner-in">
    <div class="tag">Stories that shape gaming</div>
    <div class="word glitch" data-text="Akshon Media">Akshon <span class="md">Media</span></div>
    <div class="sub">Esports documentaries &amp; original series</div>
    <a class="pstart" href="/videos/">&#9654;&nbsp; Press start</a>
  </div>
</div>

<div class="wrap sec">
  <div class="mission rv">
    <span class="eyebrow">An eye for the game</span>
    <h2 style="margin-top:14px">Akshon Media is a collective of passionate creators telling the stories that move gamers &mdash; documentaries, esports coverage, and original series from inside the game.</h2>
    <p>Working closely with a breadth of brands, agencies, and companies, we have a proven track record of producing captivating video content that engages, educates, and drives results.</p>
  </div>
</div>

<div class="wrap sec" style="padding-top:8px">
  <div class="sec-head"><h2>Latest videos</h2><a class="viewall" href="/videos/">View all videos &rarr;</a></div>
  <div class="vgrid">{cards}</div>
</div>

<div class="strip"><div class="wrap"><div class="strip-in">{stat}</div>
<div class="strip-note">* Some figures are estimates pending confirmation.</div></div></div>

<div class="wrap sec">
  <div class="sec-head"><h2>Brands we've worked with</h2></div>
  {brands_block()}
</div>

<div class="teaser"><div class="teaser-bg"></div><div class="wrap teaser-in">
  <div><h2>Working with Akshon</h2><p>Sponsorships, branded content, and full-scale production &mdash; see what a partnership looks like at a glance.</p></div>
  <a class="btn btn-red" href="/work-with-us/">Work with us &rarr;</a>
</div></div>

<div class="wrap sec">
  <div class="news">
    <h2>The Akshon Brief</h2>
    <p>New videos, behind-the-scenes stories, and esports deep-dives &mdash; straight to your inbox.</p>
    <form onsubmit="event.preventDefault();this.querySelector('button').textContent='Subscribed'">
      <input type="email" placeholder="Email address" aria-label="Email address" required>
      <button class="btn btn-dark" type="submit">Subscribe</button>
    </form>
  </div>
</div>
{SCORE_JS}
"""
    write("index.html", html_out + footer())

def build_videos_index(videos, topics):
    cats = sorted({v["category"] for v in videos})
    filters = '<button class="fbtn on" data-f="all">All</button>' + "".join(
        f'<button class="fbtn" data-f="{c}">{cat_label(c)}</button>' for c in cats)
    cards = "".join(
        f'<a class="vcard" href="{v["url"]}" data-cat="{v["category"]}"><div class="im"><img src="{v["thumbnail"]}" alt="{esc(v["title"])}" loading="lazy" width="480" height="270"><div class="play"><span>&#9654;</span></div></div><div class="t">{esc(v["title"])}</div><div class="d">{cat_label(v["category"])} &middot; {fmt_date(v["date"])}</div></a>'
        for v in videos)
    hot = sorted(topics.values(), key=lambda t: -len(t["videos"]))[:12]
    top_topics = ('<div class="tchips"><span class="k">Popular topics</span>'
                  + "".join(f'<a href="{t["url"]}">{esc(t["label"])}</a>' for t in hot)
                  + '<a class="all" href="/topics/">All topics &rarr;</a></div>') if hot else ""
    html_out = head("All Videos — Akshon Media",
        "Every Akshon Media video: esports documentaries, deep-dives, and original series. Stories that inspire, moments that define gaming.",
        "/videos/")
    html_out += f"""
<div class="wrap" style="padding-top:64px">
  <span class="eyebrow">Originals</span>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">All videos</h1>
  <p style="color:var(--muted);margin-top:12px">Stories that inspire. Moments that define gaming. &mdash; {len(videos)} videos.</p>
  {top_topics}
  <div class="filters" role="tablist" aria-label="Video categories">{filters}</div>
  <div class="vgrid" id="vgrid" style="padding-bottom:84px">{cards}</div>
</div>
<script>
document.querySelectorAll('.fbtn').forEach(function(b){{b.addEventListener('click',function(){{
  document.querySelectorAll('.fbtn').forEach(function(x){{x.classList.remove('on')}});b.classList.add('on');
  var f=b.getAttribute('data-f');
  document.querySelectorAll('#vgrid .vcard').forEach(function(c){{
    c.style.display=(f==='all'||c.getAttribute('data-cat')===f)?'':'none';}});}});}});
</script>
"""
    write("videos/index.html", html_out + footer())

def build_video_posts(videos, topics):
    by_slug = {v["slug"]: v for v in videos}
    phrases = link_phrases(videos, topics)
    for i, v in enumerate(videos):
        prev_v = videos[i+1] if i+1 < len(videos) else None   # older
        next_v = videos[i-1] if i > 0 else None                # newer
        desc = v.get("description", "").strip() or re.sub(r"\s+", " ", v["body"])[:200].strip() or f"{v['title']} — an Akshon Media original."
        my_topics = topics_for(v, topics)
        body_md = autolink(v["body"], phrases, v["slug"],
                           self_topics={"topic:" + slugify(t) for t in v["tags"]},
                           kin=topical_kin(v, videos))
        body_html = md_body_to_html(body_md) or f'<p>{esc(v["title"])} — watch the full video above.</p>'
        yt = v["youtube_id"]
        related = related_for(v, videos, by_slug)
        ld = json.dumps({
            "@context": "https://schema.org", "@type": "VideoObject",
            "@id": SITE_URL + v["url"] + "#video",
            "name": v["title"], "description": desc,
            "thumbnailUrl": v["thumbnail"], "uploadDate": v["date"],
            "embedUrl": f"https://www.youtube.com/embed/{yt}",
            "contentUrl": f"https://www.youtube.com/watch?v={yt}",
            "mainEntityOfPage": {"@type": "WebPage", "@id": SITE_URL + v["url"]},
            "inLanguage": "en",
            "keywords": ", ".join(v["tags"]) or None,
            "publisher": {"@type": "Organization", "name": "Akshon Media",
                          "logo": {"@type": "ImageObject", "url": SITE_URL + "/assets/img/logo-white.png"}}
        }, ensure_ascii=False)
        crumb_ld = json.dumps({
            "@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE_URL + "/"},
                {"@type": "ListItem", "position": 2, "name": "Videos", "item": SITE_URL + "/videos/"},
                {"@type": "ListItem", "position": 3, "name": v["title"], "item": SITE_URL + v["url"]},
            ]}, ensure_ascii=False)
        extra = (f'<script type="application/ld+json">{ld}</script>'
                 f'<script type="application/ld+json">{crumb_ld}</script>'
                 f'<meta property="article:published_time" content="{esc(v["date"])}">'
                 + "".join(f'<meta property="article:tag" content="{esc(t)}">' for t in v["tags"][:8]))
        # FAQ section + FAQPage schema (question-targeting for Google)
        faq_html = ""
        if v["faq"]:
            items = "".join(
                f'<details><summary>{esc(q["question"])}</summary><div>{esc(q["answer"])}</div></details>'
                for q in v["faq"])
            faq_html = f'<section class="faq"><h2>Frequently asked questions</h2><div class="faqlist">{items}</div></section>'
            faq_ld = json.dumps({
                "@context": "https://schema.org", "@type": "FAQPage",
                "mainEntity": [{"@type": "Question", "name": q["question"],
                                "acceptedAnswer": {"@type": "Answer", "text": q["answer"]}} for q in v["faq"]],
            }, ensure_ascii=False)
            extra += f'<script type="application/ld+json">{faq_ld}</script>'
        html_out = head(f"{v['title']} — Akshon Media", desc, v["url"],
                        og_image=v["thumbnail"], extra=extra, og_type="article")
        pn = '<div class="postnav">'
        if next_v: pn += f'<a href="{next_v["url"]}">&larr; {esc(next_v["title"])}</a>'
        if prev_v: pn += f'<a class="next" href="{prev_v["url"]}">{esc(prev_v["title"])} &rarr;</a>'
        pn += "</div>"
        chips = ""
        if my_topics:
            chips = '<div class="tchips"><span class="k">Topics</span>' + "".join(
                f'<a href="{t["url"]}">{esc(t["label"])}</a>' for t in my_topics) + "</div>"
        rel_html = ""
        if related:
            rel_html = ('<section class="related"><h2>Related videos</h2><div class="vgrid">'
                        + "".join(vcard(r) for r in related) + "</div></section>")
        html_out += f"""
<article class="post">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>/</span> <a href="/videos/">Videos</a> <span>/</span> <span class="cur">{esc(v['title'])}</span></nav>
  <h1>{esc(v['title'])}</h1>
  <div class="meta"><span class="cat">{cat_label(v['category'])}</span><span>&middot;</span><time datetime="{esc(v['date'])}">{fmt_date(v['date'])}</time><span>&middot;</span><span>By Akshon Media</span></div>
  <div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/{yt}" title="{esc(v['title'])}" loading="lazy" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen></iframe></div>
  <div class="watch-yt"><span class="s">Watch and subscribe on YouTube to support the channel.</span><a href="https://www.youtube.com/watch?v={yt}" rel="noopener" target="_blank">Watch on YouTube &rarr;</a></div>
  <div class="body">{body_html}</div>
  {chips}
  {faq_html}
  {rel_html}
  {pn}
</article>
"""
        write(f"video/{v['slug']}/index.html", html_out + footer())

def build_topic_pages(topics):
    """Hub pages per topic — every video links up to its hubs, every hub links back down."""
    ordered = sorted(topics.values(), key=lambda t: (-len(t["videos"]), t["label"].lower()))
    for t in ordered:
        vids = t["videos"]
        # sibling topics that share the most videos with this one
        mine = {v["slug"] for v in vids}
        sibs = sorted(
            ((len(mine & {v["slug"] for v in o["videos"]}), o) for o in ordered if o["slug"] != t["slug"]),
            key=lambda x: -x[0])
        sibs = [o for n, o in sibs if n][:6]
        sib_html = ""
        if sibs:
            sib_html = ('<div class="tchips"><span class="k">See also</span>'
                        + "".join(f'<a href="{o["url"]}">{esc(o["label"])}</a>' for o in sibs) + "</div>")
        desc = (f"{len(vids)} Akshon Media videos about {t['label']} — documentaries, "
                f"deep-dives, and esports coverage, newest first.")
        ld = json.dumps({
            "@context": "https://schema.org", "@type": "CollectionPage",
            "name": f"{t['label']} videos", "description": desc, "url": SITE_URL + t["url"],
            "mainEntity": {"@type": "ItemList", "numberOfItems": len(vids),
                           "itemListElement": [{"@type": "ListItem", "position": i + 1,
                                                "url": SITE_URL + v["url"], "name": v["title"]}
                                               for i, v in enumerate(vids)]},
        }, ensure_ascii=False)
        crumb_ld = json.dumps({
            "@context": "https://schema.org", "@type": "BreadcrumbList",
            "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE_URL + "/"},
                {"@type": "ListItem", "position": 2, "name": "Topics", "item": SITE_URL + "/topics/"},
                {"@type": "ListItem", "position": 3, "name": t["label"], "item": SITE_URL + t["url"]},
            ]}, ensure_ascii=False)
        html_out = head(f"{t['label']} Videos & Documentaries — Akshon Media", desc, t["url"],
                        og_image=vids[0]["thumbnail"],
                        extra=f'<script type="application/ld+json">{ld}</script>'
                              f'<script type="application/ld+json">{crumb_ld}</script>')
        html_out += f"""
<div class="wrap" style="padding-top:64px">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>/</span> <a href="/topics/">Topics</a> <span>/</span> <span class="cur">{esc(t['label'])}</span></nav>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(30px,4.6vw,48px);letter-spacing:.04em;text-transform:uppercase;margin-top:12px">{esc(t['label'])}</h1>
  <p style="color:var(--muted);margin-top:12px;max-width:64ch">Every Akshon Media video on {esc(t['label'])} &mdash; {len(vids)} in total, newest first. Each one pairs the full video with a written breakdown of what happened and why it mattered.</p>
  {sib_html}
</div>
<div class="wrap sec" style="padding-top:34px"><div class="vgrid" style="padding-bottom:70px">{"".join(vcard(v) for v in vids)}</div></div>
"""
        write(f"topics/{t['slug']}/index.html", html_out + footer())

    rows = "".join(
        f'<a class="tcard" href="{t["url"]}"><span class="n">{esc(t["label"])}</span>'
        f'<span class="c">{len(t["videos"])} videos</span></a>' for t in ordered)
    desc = "Browse every Akshon Media video by topic — Overwatch League, fighting games, battle royale, esports history, and more."
    html_out = head("Topics — Akshon Media Video Archive", desc, "/topics/")
    html_out += f"""
<div class="wrap" style="padding-top:64px">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span>/</span> <span class="cur">Topics</span></nav>
  <span class="eyebrow" style="display:block;margin-top:14px">Archive</span>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">Browse by topic</h1>
  <p style="color:var(--muted);margin-top:12px;max-width:64ch">{len(ordered)} topics across the Akshon archive. Pick a game, a league, or an era and get every video we've made about it.</p>
  <div class="tgrid" style="padding-bottom:80px">{rows}</div>
</div>
"""
    write("topics/index.html", html_out + footer())

def build_work(videos):
    o = SITE["offers"]; sel = SITE["selected_work"]; st = SITE["stats_work"]
    stat = "".join(f'<div class="stat"><div class="n">{x["n"]}</div><div class="l">{x["l"]}</div></div>' for x in st)
    offers = "".join(f'<div class="ocard"><span class="k">{x["k"]}</span><h3>{x["h"]}</h3><p>{x["p"]}</p></div>' for x in o)
    rows = "".join(f'<div class="workrow"><img src="{x["img"]}" alt="{esc(x["h"])}" loading="lazy"><div><h3>{x["h"]}</h3><p>{x["p"]}</p></div></div>' for x in sel)
    html_out = head("Work With Akshon — For Agencies & Sponsors",
        "Partner with Akshon Media: sponsored integrations, branded content, and full-scale production for gaming brands. See our audience and selected work.",
        "/work-with-us/")
    html_out += f"""
<div class="wrap" style="padding-top:64px">
  <span class="eyebrow">For agencies &amp; sponsors</span>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">Work with Akshon</h1>
  <p style="color:var(--muted);margin-top:12px;max-width:62ch">A gaming media company with an engaged audience and a decade of storytelling &mdash; here's what a partnership looks like.</p>
</div>
<div class="strip" style="margin-top:44px"><div class="wrap"><div class="strip-in">{stat}</div>
<div class="strip-note">* Some figures are estimates pending confirmation.</div></div></div>
<div class="wrap sec"><div class="split">
  <div><div class="sec-head" style="margin-bottom:18px"><h2>Who we are</h2></div>
  <p>Akshon Media is a full-service video production company made up of a collective of passionate creators that produces high-quality digital content.</p>
  <p>From ideation to post-production, our full-service team will work with you to bring your brand to life and find the most effective approach to tell your story.</p></div>
  <img src="/assets/img/hero-about.jpg" alt="Akshon crew filming players backstage" loading="lazy"></div></div>
<div class="wrap sec" style="padding-top:0"><div class="sec-head"><h2>What we offer</h2></div><div class="offer">{offers}</div></div>
<div class="wrap sec" style="padding-top:0"><div class="sec-head"><h2>Selected work</h2></div><div>{rows}</div></div>
<div class="wrap sec" style="padding-top:0"><div class="ct-grid">
  <div><div class="sec-head" style="margin-bottom:18px"><h2>Let's talk</h2></div>
    <p style="color:var(--muted);max-width:44ch">Tell us about your brand and goals &mdash; we'll come back with a concept and a media kit.</p>
    <div style="margin-top:22px">
      <div class="ct-line"><span class="k">Studio</span><span class="v">801&ndash;838 W Hastings St, Vancouver, BC</span></div>
      <div class="ct-line"><span class="k">Email</span><span class="v">hello@akshonmedia.com</span></div>
      <div class="ct-line"><span class="k">Site</span><span class="v">akshonmedia.com</span></div>
    </div></div>
  <form class="ct" name="partner" method="POST" data-netlify="true" netlify-honeypot="bot-field">
    <input type="hidden" name="form-name" value="partner"><p style="display:none"><label>Don't fill this: <input name="bot-field"></label></p>
    <div><label for="w-name">Name</label><input id="w-name" name="name" type="text" required></div>
    <div><label for="w-email">Email</label><input id="w-email" name="email" type="email" required></div>
    <div><label for="w-type">I'm interested in</label>
      <select id="w-type" name="interest"><option>Sponsored integration</option><option>Branded content</option><option>Production services</option><option>Other</option></select></div>
    <div><label for="w-msg">About your brand</label><textarea id="w-msg" name="message" rows="4"></textarea></div>
    <button class="btn btn-dark" type="submit">Send message &rarr;</button>
  </form>
</div></div>
"""
    write("work-with-us/index.html", html_out + footer())

def build_about():
    html_out = head("About — Akshon Media",
        "Akshon Media is a full-service video production company: a collective of passionate creators producing high-quality digital content for gaming brands.",
        "/about/")
    html_out += f"""
<div class="wrap" style="padding-top:64px">
  <span class="eyebrow">About</span>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">We are Akshon</h1>
</div>
<div class="wrap sec" style="padding-top:40px"><div class="split">
  <div><p>Akshon Media is a full-service video production company made up of a collective of passionate creators that produces high-quality digital content.</p>
  <p>Working closely with a breadth of brands, agencies, and companies, we have a proven track record of producing captivating video content that engages, educates, and drives results.</p>
  <p>From ideation to post-production, our full-service team will work with you to bring your brand to life and find the most effective approach to tell your story.</p></div>
  <img src="/assets/img/hero-cta.jpg" alt="Akshon editor at work in the studio" loading="lazy"></div></div>
<div class="wrap sec" style="padding-top:0"><div class="sec-head"><h2>How we work</h2></div>
<div class="pillars">
  <div class="pillar"><span class="k">01</span><h3>Creative Development</h3><p>Concepting, strategy, and story development rooted in gaming culture.</p></div>
  <div class="pillar"><span class="k">02</span><h3>Videography</h3><p>On-location and studio production, from arena floors to backstage moments.</p></div>
  <div class="pillar"><span class="k">03</span><h3>Post Production</h3><p>Editing, motion design, and finishing that turn footage into stories.</p></div>
</div></div>
<div class="wrap sec" style="padding-top:0"><div class="sec-head"><h2>Brands we've worked with</h2></div>{brands_block()}</div>
"""
    write("about/index.html", html_out + footer())

def build_contact():
    html_out = head("Contact — Akshon Media",
        "Get in touch with Akshon Media — documentaries, league partnerships, and brand campaigns for the gaming world.", "/contact/")
    html_out += """
<div class="wrap" style="padding-top:64px"><span class="eyebrow">Contact</span>
<h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">Create with us</h1></div>
<div class="wrap sec" style="padding-top:40px"><div class="ct-grid">
  <div><h2 style="font-family:var(--disp);text-transform:uppercase;font-size:26px;letter-spacing:.04em">Let's tell your story.</h2>
    <p style="color:var(--muted);margin:14px 0 24px;max-width:44ch">Whether it's a documentary, a league partnership, or a brand campaign &mdash; we'd love to hear what you're building.</p>
    <div class="ct-line"><span class="k">Studio</span><span class="v">801&ndash;838 W Hastings St, Vancouver, BC</span></div>
    <div class="ct-line"><span class="k">Email</span><span class="v">hello@akshonmedia.com</span></div>
    <div class="ct-line"><span class="k">Follow</span><span class="v">YouTube &middot; Instagram &middot; X &middot; Discord &middot; LinkedIn</span></div></div>
  <form class="ct" name="contact" method="POST" data-netlify="true" netlify-honeypot="bot-field">
    <input type="hidden" name="form-name" value="contact"><p style="display:none"><label>Don't fill this: <input name="bot-field"></label></p>
    <div><label for="c-name">Name</label><input id="c-name" name="name" type="text" required></div>
    <div><label for="c-email">Email</label><input id="c-email" name="email" type="email" required></div>
    <div><label for="c-msg">Tell us about it</label><textarea id="c-msg" name="message" rows="5"></textarea></div>
    <button class="btn btn-dark" type="submit">Send message &rarr;</button>
  </form>
</div></div>
"""
    write("contact/index.html", html_out + footer())

def build_press(videos):
    press = [v for v in videos if v["category"] == "press"]
    html_out = head("Press — Akshon Media", "Press coverage and announcements from Akshon Media.", "/press/")
    body = "".join(vcard(v) for v in press) or "<p style='color:var(--muted)'>Press items coming soon.</p>"
    html_out += f"""
<div class="wrap" style="padding-top:64px"><span class="eyebrow">Press</span>
<h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">Press &amp; announcements</h1></div>
<div class="wrap sec" style="padding-top:40px"><div class="vgrid">{body}</div></div>
"""
    write("press/index.html", html_out + footer())

def build_sitemap(videos, topics):
    entries = [(u, None) for u in ("/", "/videos/", "/topics/", "/work-with-us/", "/about/", "/contact/", "/press/")]
    entries += [(t["url"], t["videos"][0]["date"]) for t in topics.values()]
    entries += [(v["url"], v["date"]) for v in videos]
    items = "".join(
        f"<url><loc>{SITE_URL}{u}</loc>" + (f"<lastmod>{d}</lastmod>" if d else "") + "</url>\n"
        for u, d in entries)
    xml = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{items}</urlset>\n'
    write("sitemap.xml", xml)

# ---------- static bits injected into templates ----------
SITE_LD = '<script type="application/ld+json">' + json.dumps({
    "@context": "https://schema.org", "@type": "Organization", "name": "Akshon Media",
    "url": SITE_URL, "logo": SITE_URL + "/assets/img/logo-white.png",
    "sameAs": ["https://www.youtube.com/c/Akshonmedia", "https://x.com/akshonmedia", "https://www.instagram.com/akshonmedia"]
}) + '</script>'

SCORE_JS = """<script>
(function(){
  var r=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var s=document.getElementById('score'),T=192772958;
  function f(n){return n.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');}
  if(s){ if(r){s.textContent=f(T)+'+';} else {var t0=null;function step(ts){if(!t0)t0=ts;var p=Math.min((ts-t0)/2600,1);var e=1-Math.pow(1-p,4);s.textContent=f(Math.round(T*e))+(p>=1?'+':'');if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);} }
  var b=document.querySelector('.banner');
  if(b&&!r){for(var i=0;i<22;i++){var d=document.createElement('i');d.className='px';d.style.left=Math.random()*100+'%';var z=3+Math.random()*5;d.style.width=d.style.height=z+'px';d.style.animationDuration=(6+Math.random()*9)+'s';d.style.animationDelay=(-Math.random()*12)+'s';if(Math.random()<.38)d.style.background='rgba(255,77,85,.5)';b.appendChild(d);}
  if(window.matchMedia('(pointer:fine)').matches){var bg=b.querySelector('.banner-bg');b.addEventListener('mousemove',function(e){var q=b.getBoundingClientRect();var x=(e.clientX-q.left)/q.width-.5,y=(e.clientY-q.top)/q.height-.5;bg.style.transform='translate('+(x*-14)+'px,'+(y*-10)+'px)';});b.addEventListener('mouseleave',function(){bg.style.transform='none';});}}
})();
</script>"""

# ---------- run ----------
def main():
    if os.path.exists(DIST): shutil.rmtree(DIST)
    os.makedirs(DIST)
    videos = load_videos()
    topics = build_topic_index(videos)
    build_home(videos)
    build_videos_index(videos, topics)
    build_video_posts(videos, topics)
    build_topic_pages(topics)
    build_work(videos)
    build_about()
    build_contact()
    build_press(videos)
    build_sitemap(videos, topics)
    # copy static assets
    shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(DIST, "assets"))
    if os.path.isdir(os.path.join(ROOT, "admin")):
        shutil.copytree(os.path.join(ROOT, "admin"), os.path.join(DIST, "admin"))
    for f in os.listdir(os.path.join(ROOT, "static")):
        shutil.copy(os.path.join(ROOT, "static", f), os.path.join(DIST, f))
    print(f"Built {len(videos)} video posts + 6 pages -> dist/")

if __name__ == "__main__":
    main()
