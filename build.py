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

def md_body_to_html(body):
    """Minimal markdown: blank-line paragraphs, ## / ### headings."""
    out = []
    for block in re.split(r"\n\s*\n", body.strip()):
        b = block.strip()
        if not b: continue
        if b.startswith("### "): out.append(f"<h3>{html.escape(b[4:])}</h3>")
        elif b.startswith("## "): out.append(f"<h2>{html.escape(b[3:])}</h2>")
        else: out.append(f"<p>{html.escape(b)}</p>")
    return "\n".join(out)

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
        vids.append({
            "slug": slug,
            "title": fm.get("title", slug),
            "date": str(fm.get("date", "") or ""),
            "youtube_id": str(fm.get("youtube_id", "") or ""),
            "category": fm.get("category", "originals"),
            "thumbnail": fm.get("thumbnail") or f"https://i.ytimg.com/vi/{fm.get('youtube_id','')}/hqdefault.jpg",
            "description": fm.get("description", ""),
            "faq": [q for q in (fm.get("faq") or []) if isinstance(q, dict) and q.get("question") and q.get("answer")],
            "body": body,
            "url": f"/video/{slug}/",
        })
    vids.sort(key=lambda v: v["date"], reverse=True)
    return vids

SITE = json.load(open(os.path.join(ROOT, "data/site.json")))

# ---------- layout ----------
def head(title, desc, path, og_image=None, extra=""):
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
<meta property="og:type" content="website">
<meta property="og:title" content="{esc(title)}">
<meta property="og:description" content="{esc(desc)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{ogimg}">
<meta property="og:site_name" content="Akshon Media">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://i.ytimg.com">
<link rel="stylesheet" href="/assets/css/site.css">
{extra}
</head>
<body>
{nav(path)}
<main>
"""

NAV = [("/", "Home", "home"), ("/videos/", "Videos", "videos"),
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
    <li><a href="/videos/">Videos</a></li><li><a href="/work-with-us/">Work With Us</a></li><li><a href="/about/">About</a></li></ul></div>
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
  <div class="hud hud-score" aria-hidden="true"><span class="num" id="score">0</span><span class="lbl">Total views*</span></div>
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
<div class="strip-note">* Figures shown are placeholders for review &mdash; final stats to be confirmed.</div></div></div>

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

def build_videos_index(videos):
    cats = sorted({v["category"] for v in videos})
    filters = '<button class="fbtn on" data-f="all">All</button>' + "".join(
        f'<button class="fbtn" data-f="{c}">{cat_label(c)}</button>' for c in cats)
    cards = "".join(
        f'<a class="vcard" href="{v["url"]}" data-cat="{v["category"]}"><div class="im"><img src="{v["thumbnail"]}" alt="{esc(v["title"])}" loading="lazy" width="480" height="270"><div class="play"><span>&#9654;</span></div></div><div class="t">{esc(v["title"])}</div><div class="d">{cat_label(v["category"])} &middot; {fmt_date(v["date"])}</div></a>'
        for v in videos)
    html_out = head("All Videos — Akshon Media",
        "Every Akshon Media video: esports documentaries, deep-dives, and original series. Stories that inspire, moments that define gaming.",
        "/videos/")
    html_out += f"""
<div class="wrap" style="padding-top:64px">
  <span class="eyebrow">Originals</span>
  <h1 style="font-family:var(--disp);font-weight:600;font-size:clamp(34px,5vw,52px);letter-spacing:.04em;text-transform:uppercase;margin-top:10px">All videos</h1>
  <p style="color:var(--muted);margin-top:12px">Stories that inspire. Moments that define gaming. &mdash; {len(videos)} videos.</p>
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

def build_video_posts(videos):
    for i, v in enumerate(videos):
        prev_v = videos[i+1] if i+1 < len(videos) else None   # older
        next_v = videos[i-1] if i > 0 else None                # newer
        desc = v.get("description", "").strip() or re.sub(r"\s+", " ", v["body"])[:200].strip() or f"{v['title']} — an Akshon Media original."
        body_html = md_body_to_html(v["body"]) or f'<p>{esc(v["title"])} — watch the full video above.</p>'
        yt = v["youtube_id"]
        ld = json.dumps({
            "@context": "https://schema.org", "@type": "VideoObject",
            "name": v["title"], "description": desc,
            "thumbnailUrl": v["thumbnail"], "uploadDate": v["date"],
            "embedUrl": f"https://www.youtube.com/embed/{yt}",
            "contentUrl": f"https://www.youtube.com/watch?v={yt}",
            "publisher": {"@type": "Organization", "name": "Akshon Media",
                          "logo": {"@type": "ImageObject", "url": SITE_URL + "/assets/img/logo-white.png"}}
        }, ensure_ascii=False)
        extra = f'<script type="application/ld+json">{ld}</script>'
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
        html_out = head(f"{v['title']} — Akshon Media", desc, v["url"], og_image=v["thumbnail"], extra=extra)
        pn = '<div class="postnav">'
        if next_v: pn += f'<a href="{next_v["url"]}">&larr; Newer</a>'
        if prev_v: pn += f'<a class="next" href="{prev_v["url"]}">Older &rarr;</a>'
        pn += "</div>"
        html_out += f"""
<article class="post">
  <a class="crumb" href="/videos/">&larr; All videos</a>
  <h1>{esc(v['title'])}</h1>
  <div class="meta"><span class="cat">{cat_label(v['category'])}</span><span>&middot;</span><span>{fmt_date(v['date'])}</span><span>&middot;</span><span>By Akshon Media</span></div>
  <div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/{yt}" title="{esc(v['title'])}" loading="lazy" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen></iframe></div>
  <div class="watch-yt"><span class="s">Watch and subscribe on YouTube to support the channel.</span><a href="https://www.youtube.com/watch?v={yt}" rel="noopener" target="_blank">Watch on YouTube &rarr;</a></div>
  <div class="body">{body_html}</div>
  {faq_html}
  {pn}
</article>
"""
        write(f"video/{v['slug']}/index.html", html_out + footer())

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
<div class="strip-note">* Figures shown are placeholders for review &mdash; final stats to be confirmed.</div></div></div>
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

def build_sitemap(videos):
    urls = ["/", "/videos/", "/work-with-us/", "/about/", "/contact/", "/press/"] + [v["url"] for v in videos]
    items = "".join(f"<url><loc>{SITE_URL}{u}</loc></url>\n" for u in urls)
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
  var s=document.getElementById('score'),T=250000000;
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
    build_home(videos)
    build_videos_index(videos)
    build_video_posts(videos)
    build_work(videos)
    build_about()
    build_contact()
    build_press(videos)
    build_sitemap(videos)
    # copy static assets
    shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(DIST, "assets"))
    if os.path.isdir(os.path.join(ROOT, "admin")):
        shutil.copytree(os.path.join(ROOT, "admin"), os.path.join(DIST, "admin"))
    for f in os.listdir(os.path.join(ROOT, "static")):
        shutil.copy(os.path.join(ROOT, "static", f), os.path.join(DIST, f))
    print(f"Built {len(videos)} video posts + 6 pages -> dist/")

if __name__ == "__main__":
    main()
