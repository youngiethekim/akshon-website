// generate-video — Netlify serverless function (SEO ranking agent)
//
// Paste a YouTube URL (+ optional pasted transcript, + optional target keyword) →
//   1. fetch title (oEmbed → og:title fallback) + transcript
//   2. pick the target keyword (your override, else Claude proposes + optional
//      DataForSEO volume/difficulty validation)
//   3. [DataForSEO] pull the live top-10 Google results + "People Also Ask" for
//      that keyword, so the editor can out-cover what's ranking
//   4. Claude "on-page SEO editor" writes an optimized post around the keyword
//   5. score the draft's on-page SEO (deterministic) and auto-revise once if weak
//   6. commit a *draft* markdown post; Netlify rebuilds; you review in /admin.
//
// Zero npm dependencies (Anthropic + DataForSEO + GitHub + YouTube REST via fetch).
//
// Required env: ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_REPO, TRANSCRIPT_API_KEY
// Optional (enables keyword data + SERP analysis): DATAFORSEO_LOGIN,
//   DATAFORSEO_PASSWORD, DATAFORSEO_LOCATION (default 2840=US), DATAFORSEO_LANGUAGE (en)
// Optional: CLAUDE_MODEL (default claude-opus-4-8), GITHUB_BRANCH (default main)

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const DFS_LOC = Number(process.env.DATAFORSEO_LOCATION || 2840);
const DFS_LANG = process.env.DATAFORSEO_LANGUAGE || "en";
const SCORE_PASS = 80; // auto-revise if the on-page score is below this

const json = (statusCode, body) => ({ statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function videoId(url) {
  const m = String(url).match(/(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}
function slugify(s) {
  return String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function fetchMeta(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`);
    if (r.ok) return await r.json();
  } catch {}
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const r = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "user-agent": UA } });
    if (r.ok) {
      const m = (await r.text()).match(/<meta property="og:title" content="([^"]*)"/);
      if (m) return { title: m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"') };
    }
  } catch {}
  return { title: "" };
}

async function fetchTranscript(id) {
  const key = process.env.TRANSCRIPT_API_KEY;
  if (!key) throw new Error("No transcript found and TRANSCRIPT_API_KEY is not set — paste the script instead.");
  const r = await fetch(`https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=${id}&text=true`, { headers: { "x-api-key": key } });
  if (!r.ok) throw new Error(`Transcript service returned ${r.status} — this video may have no captions. Paste the script instead.`);
  const data = await r.json();
  const text = typeof data.content === "string" ? data.content : Array.isArray(data.content) ? data.content.map((c) => c.text || "").join(" ") : "";
  if (!text.trim()) throw new Error("Transcript came back empty — paste the script instead.");
  return text;
}

// ---- Claude (structured JSON) ----
async function claudeJSON({ system, user, schema, effort = "medium", maxTokens = 4000 }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, output_config: { format: { type: "json_schema", schema }, effort }, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("Claude declined to process this content.");
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("Claude returned no output.");
  return JSON.parse(block.text);
}

async function proposeKeywords({ title, transcript }) {
  const out = await claudeJSON({
    effort: "low", maxTokens: 800,
    system: "You are an SEO keyword strategist. Given a gaming video's title and transcript, propose 6–8 realistic search queries a person might type into Google to find this content. Mix head terms and specific long-tail phrases. Match search intent. Return lowercase phrases, no punctuation, no hashtags. JSON only.",
    user: `Title: ${title}\n\nTranscript:\n${transcript.slice(0, 8000)}`,
    schema: { type: "object", additionalProperties: false, properties: { candidates: { type: "array", items: { type: "string" } } }, required: ["candidates"] },
  });
  return (out.candidates || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 8);
}

// ---- DataForSEO ----
function dfsEnabled() { return process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD; }
async function dfsPost(path, task) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const r = await fetch(`https://api.dataforseo.com${path}`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json" }, body: JSON.stringify([task]) });
  if (!r.ok) throw new Error(`DataForSEO ${r.status}`);
  return (((await r.json()).tasks || [])[0] || {}).result || [];
}
async function keywordData(candidates) {
  const base = { keywords: candidates, location_code: DFS_LOC, language_code: DFS_LANG };
  const [vol, diff] = await Promise.all([
    dfsPost("/v3/keywords_data/google_ads/search_volume/live", base).catch(() => []),
    dfsPost("/v3/dataforseo_labs/google/bulk_keyword_difficulty/live", base).catch(() => []),
  ]);
  const diffMap = {};
  for (const d of diff) if (d && d.keyword) diffMap[d.keyword.toLowerCase()] = d.keyword_difficulty;
  const rows = [];
  for (const v of vol) {
    if (!v || !v.keyword) continue;
    const volume = v.search_volume || 0;
    const difficulty = typeof diffMap[v.keyword.toLowerCase()] === "number" ? diffMap[v.keyword.toLowerCase()] : null;
    rows.push({ keyword: v.keyword, volume, difficulty, opportunity: Math.round(volume * (difficulty == null ? 0.6 : (100 - difficulty) / 100)) });
  }
  rows.sort((a, b) => b.opportunity - a.opportunity);
  return rows;
}
// Live top-10 organic + People Also Ask for a keyword → a compact brief for the editor.
async function serpBrief(keyword) {
  const res = await dfsPost("/v3/serp/google/organic/live/advanced", { keyword, location_code: DFS_LOC, language_code: DFS_LANG, depth: 10 }).catch(() => []);
  const items = (res[0] || {}).items || [];
  const organic = items.filter((i) => i.type === "organic").slice(0, 10).map((i) => ({ title: i.title, description: i.description }));
  const paa = items.filter((i) => i.type === "people_also_ask").flatMap((i) => (i.items || []).map((q) => q.title)).slice(0, 8);
  const related = items.filter((i) => i.type === "related_searches").flatMap((i) => i.items || []).slice(0, 10);
  return { organic, paa, related, count: organic.length };
}

// ---- On-page SEO editor ----
const RUBRIC =
  "You are a senior on-page SEO editor for Akshon Media, a gaming-media YouTube channel. Write the blog post for a video so it RANKS in Google for the given primary keyword AND makes the reader click through to watch the full video on YouTube. Requirements:\n" +
  "- Put the exact primary keyword in: the title (near the front), the meta description, the first ~100 words of the body, and at least one '##' subheading.\n" +
  "- TITLE TAG 20–60 chars. META DESCRIPTION 140–160 chars, includes the keyword + a hook implying 'watch the video'. SLUG short, hyphenated, keyword-based.\n" +
  "- BODY 300–550 words of original, people-first prose (never a transcript dump), with 3–5 '##' subheadings. If competitor/PAA info is provided, cover the important subtopics and answer the People-Also-Ask questions so the post is MORE complete than what currently ranks — without keyword-stuffing.\n" +
  "- Pick 4–6 secondary keywords actually used in the copy. End by pointing readers to watch the full video.\n" +
  "Return only the requested JSON.";

const EDITOR_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" }, slug: { type: "string" }, meta_description: { type: "string" },
    category: { type: "string", enum: ["originals", "press"] }, body_markdown: { type: "string" },
    primary_keyword: { type: "string" }, secondary_keywords: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } }, seo_notes: { type: "string" },
  },
  required: ["title", "slug", "meta_description", "category", "body_markdown", "primary_keyword", "secondary_keywords", "tags", "seo_notes"],
};

function serpText(serp) {
  if (!serp || !serp.count) return "";
  let t = "\n\nWHAT CURRENTLY RANKS for this keyword (out-cover these — be more complete, don't copy):\n";
  serp.organic.forEach((o, i) => { t += `${i + 1}. ${o.title}${o.description ? " — " + o.description : ""}\n`; });
  if (serp.paa.length) t += "\nPeople Also Ask (answer these in the post):\n- " + serp.paa.join("\n- ") + "\n";
  if (serp.related.length) t += "\nRelated searches (use as secondary keywords where natural): " + serp.related.join(", ") + "\n";
  return t;
}

async function runEditor({ title, transcript, videoUrl, targetKeyword, keywordRows, serp, revision, previous }) {
  let u = `Video title: ${title}\nYouTube URL: ${videoUrl}\n`;
  if (targetKeyword) u += `\nPRIMARY KEYWORD (fixed — optimize the whole post for exactly this, do not change it): "${targetKeyword}"\n`;
  else if (keywordRows && keywordRows.length) {
    u += "\nCandidate keywords with real data (volume / difficulty 0-100 / opportunity), best-first — choose the primary keyword high on this list unless intent clearly demands otherwise:\n" +
      keywordRows.map((r) => `- "${r.keyword}": volume ${r.volume}, difficulty ${r.difficulty == null ? "n/a" : r.difficulty}, opportunity ${r.opportunity}`).join("\n") + "\n";
  } else u += "\n(No live keyword data — choose the primary keyword from your own SEO judgment and note it is an estimate.)\n";
  u += serpText(serp);
  if (revision && previous) {
    u += `\n\nREVISION: your previous draft failed these on-page SEO checks: ${revision}. Fix ALL of them while keeping quality and the SAME primary keyword. Previous draft:\nTITLE: ${previous.title}\nMETA: ${previous.meta_description}\nSLUG: ${previous.slug}\nBODY:\n${previous.body_markdown}\n`;
  }
  u += `\nTranscript / script:\n${transcript.slice(0, 20000)}`;
  return claudeJSON({ system: RUBRIC, user: u, schema: EDITOR_SCHEMA, effort: "medium", maxTokens: 4000 });
}

// ---- Deterministic on-page SEO score ----
function scoreSEO(ai, kwRaw) {
  const kw = String(kwRaw || ai.primary_keyword || "").toLowerCase().trim();
  const parts = kw.split(/\s+/).filter((w) => w.length > 3);
  const title = (ai.title || "").toLowerCase();
  const meta = ai.meta_description || "";
  const body = ai.body_markdown || "";
  const bodyWords = body.split(/\s+/);
  const first100 = bodyWords.slice(0, 100).join(" ").toLowerCase();
  const h2s = (body.match(/^##\s+.+/gm) || []).map((s) => s.toLowerCase());
  const inSlug = (ai.slug || "").includes(kw.replace(/\s+/g, "-")) || (parts.length && parts.every((w) => (ai.slug || "").includes(w)));
  const inH2 = h2s.some((h) => h.includes(kw)) || (parts.length && h2s.some((h) => parts.some((w) => h.includes(w))));
  const checks = [
    { label: "Keyword in title", pass: title.includes(kw) },
    { label: "Keyword near start of title", pass: title.includes(kw) && title.indexOf(kw) <= title.length * 0.5 },
    { label: "Title 20–60 characters", pass: (ai.title || "").length >= 20 && (ai.title || "").length <= 60 },
    { label: "Keyword in meta description", pass: meta.toLowerCase().includes(kw) },
    { label: "Meta description 140–160 chars", pass: meta.length >= 140 && meta.length <= 160 },
    { label: "Keyword in first 100 words", pass: first100.includes(kw) },
    { label: "Keyword in a subheading", pass: inH2 },
    { label: "Body ≥ 300 words", pass: bodyWords.length >= 300 },
    { label: "Keyword in URL slug", pass: !!inSlug },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

// ---- GitHub ----
async function ghGet(path) {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${BRANCH}`, { headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "akshon-generate-video" } });
}
async function uniqueSlug(base) {
  const slug = base || "video";
  for (let i = 0; i < 20; i++) { const c = i === 0 ? slug : `${slug}-${i + 1}`; if ((await ghGet(`content/videos/${c}.md`)).status === 404) return c; }
  return `${slug}-${Date.now()}`;
}
async function commitPost(slug, markdown, title) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/content/videos/${slug}.md`, {
    method: "PUT",
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "akshon-generate-video", "content-type": "application/json" },
    body: JSON.stringify({ message: `Draft: ${title}`, content: Buffer.from(markdown, "utf8").toString("base64"), branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`GitHub commit failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
}
function buildMarkdown({ ai, id, date, seoScore }) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const list = (a) => `[${(a || []).map((t) => `"${esc(t)}"`).join(", ")}]`;
  return ["---", `title: "${esc(ai.title)}"`, `date: ${date}`, `youtube_id: "${id}"`, `category: ${ai.category || "originals"}`,
    `thumbnail: "https://i.ytimg.com/vi/${id}/hqdefault.jpg"`, `description: "${esc(ai.meta_description)}"`,
    `primary_keyword: "${esc(ai.primary_keyword || "")}"`, `secondary_keywords: ${list(ai.secondary_keywords)}`,
    `tags: ${list(ai.tags)}`, `seo_score: ${seoScore}`, `seo_notes: "${esc(ai.seo_notes || "")}"`, "draft: true", "---", "", ai.body_markdown.trim(), ""].join("\n");
}

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const user = context.clientContext && context.clientContext.user;
  if (!user) return json(401, { error: "Please log in to use this tool." });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid request." }); }
  const id = videoId(payload.url || "");
  if (!id) return json(400, { error: "That doesn't look like a YouTube link." });
  const targetKeyword = (payload.target_keyword || "").trim().toLowerCase() || null;

  try {
    const meta = await fetchMeta(id);
    const transcript = payload.script && payload.script.trim().length > 40 ? payload.script.trim() : await fetchTranscript(id);
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;

    // Keyword grounding + SERP analysis (only if DataForSEO creds are present)
    let keywordRows = [], grounded = false, serp = null, targetStats = null;
    if (dfsEnabled()) {
      try {
        if (targetKeyword) {
          const rows = await keywordData([targetKeyword]);
          targetStats = rows[0] || null;
        } else {
          const candidates = await proposeKeywords({ title: meta.title, transcript });
          if (candidates.length) { keywordRows = await keywordData(candidates); grounded = keywordRows.length > 0; }
        }
        // SERP is analyzed for whatever keyword we'll target
        const kwForSerp = targetKeyword || (keywordRows[0] && keywordRows[0].keyword);
        if (kwForSerp) serp = await serpBrief(kwForSerp);
        if (targetKeyword) grounded = true;
      } catch { /* resilient: fall back to model judgment */ }
    }

    // Write, score, and auto-revise once if the on-page score is weak
    let ai = await runEditor({ title: meta.title, transcript, videoUrl, targetKeyword, keywordRows, serp });
    if (targetKeyword) ai.primary_keyword = targetKeyword;
    let scored = scoreSEO(ai, targetKeyword);
    let revised = false;
    if (scored.score < SCORE_PASS) {
      const failing = scored.checks.filter((c) => !c.pass).map((c) => c.label).join("; ");
      const ai2 = await runEditor({ title: meta.title, transcript, videoUrl, targetKeyword, keywordRows, serp, revision: failing, previous: ai });
      if (targetKeyword) ai2.primary_keyword = targetKeyword;
      const scored2 = scoreSEO(ai2, targetKeyword);
      if (scored2.score >= scored.score) { ai = ai2; scored = scored2; revised = true; }
    }

    const slug = await uniqueSlug(slugify(ai.slug || ai.primary_keyword || meta.title));
    const date = new Date().toISOString().slice(0, 10);
    await commitPost(slug, buildMarkdown({ ai, id, date, seoScore: scored.score }), ai.title);

    return json(200, {
      ok: true, slug, title: ai.title, primary_keyword: ai.primary_keyword,
      secondary_keywords: ai.secondary_keywords, seo_notes: ai.seo_notes,
      seo_score: scored.score, checks: scored.checks, revised,
      grounded, keyword_stats: targetStats ? { volume: targetStats.volume, difficulty: targetStats.difficulty }
        : (grounded && keywordRows.length ? (() => { const c = keywordRows.find((r) => r.keyword.toLowerCase() === String(ai.primary_keyword).toLowerCase()); return c ? { volume: c.volume, difficulty: c.difficulty } : null; })() : null),
      competitors_analyzed: serp ? serp.count : 0,
      meta_description: ai.meta_description, preview: ai.body_markdown.slice(0, 400),
      editUrl: "/admin/#/collections/videos/entries/" + slug, liveUrl: `/video/${slug}/`,
    });
  } catch (err) {
    return json(500, { error: err.message || "Something went wrong." });
  }
};
