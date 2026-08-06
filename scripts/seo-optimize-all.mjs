// seo-optimize-all.mjs — batch SEO pass over EVERY video post.
//
// What it does, per video:
//   1. gets the transcript (Supadata) — or falls back to the existing post body
//   2. Claude proposes keyword candidates
//   3. DataForSEO grounds them with real search volume + difficulty (0–100)
//   4. picks the most winnable target and pulls the live top-10 + People-Also-Ask
//   5. Claude on-page SEO editor rewrites title / meta / body around it + writes an FAQ
//   6. deterministic on-page score, one auto-revision if weak
//   7. writes the optimized markdown back to content/videos/
//
// Also (optional) DISCOVERS long-form channel uploads not yet on the site and
// creates new *draft* posts for them (needs YT_API_KEY; Shorts/clips are skipped).
//
// Runs from the "SEO — optimize all posts" GitHub Action (one click) or locally:
//   ANTHROPIC_API_KEY=... DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... \
//   TRANSCRIPT_API_KEY=... YT_API_KEY=... node scripts/seo-optimize-all.mjs
//
// Env:
//   ANTHROPIC_API_KEY   (required)
//   DATAFORSEO_LOGIN/PASSWORD   (strongly recommended — real keyword + SERP data)
//   TRANSCRIPT_API_KEY  (supadata.ai; optional — existing posts fall back to their body)
//   YT_API_KEY          (optional — enables discovery of missing long-form videos)
//   YT_CHANNEL          (default "@Akshonmedia")
//   CLAUDE_MODEL        (default claude-opus-4-8; set claude-haiku-4-5-20251001 to cut cost)
//   DATAFORSEO_LOCATION (2840=US)  DATAFORSEO_LANGUAGE (en)
//   MIN_DURATION        (seconds; default 180 — below this is treated as a Short/clip)
//   LIMIT               (process at most N videos this run — TEST WITH 5 FIRST)
//   CONCURRENCY         (default 3)
//   FORCE               ("1" = re-optimize posts that already have an seo_score)
//   DISCOVER            ("0" = skip channel discovery even if YT_API_KEY is set)
//
// Idempotent: skips posts that already have `seo_score:` unless FORCE=1.
// NEVER renames an existing file (preserves /video/<slug>/ URLs and SEO).

import { readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const DFS_LOC = Number(process.env.DATAFORSEO_LOCATION || 2840);
const DFS_LANG = process.env.DATAFORSEO_LANGUAGE || "en";
const MIN_DURATION = Number(process.env.MIN_DURATION || 180);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const FORCE = process.env.FORCE === "1" || process.env.FORCE === "true";
const DISCOVER = process.env.DISCOVER !== "0";
const YT_CHANNEL = process.env.YT_CHANNEL || "@Akshonmedia";
const SCORE_PASS = 80;
const DIR = "content/videos";

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required."); process.exit(1); }
const dfsOn = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

// ---------- helpers shared with the generator ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function slugify(s) {
  return String(s).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function splitFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  return m ? { front: m[1], body: m[2] } : null;
}
function field(front, name) {
  const m = new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(front);
  return m ? m[1] : "";
}

async function fetchMeta(id) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`);
    if (r.ok) return await r.json();
  } catch {}
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const r = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "user-agent": UA } });
    if (r.ok) { const m = (await r.text()).match(/<meta property="og:title" content="([^"]*)"/); if (m) return { title: m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"') }; }
  } catch {}
  return { title: "" };
}
async function fetchTranscript(id) {
  const key = process.env.TRANSCRIPT_API_KEY;
  if (!key) return "";
  try {
    const r = await fetch(`https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=${id}&text=true`, { headers: { "x-api-key": key } });
    if (!r.ok) return "";
    const data = await r.json();
    const text = typeof data.content === "string" ? data.content : Array.isArray(data.content) ? data.content.map((c) => c.text || "").join(" ") : "";
    return (text || "").trim();
  } catch { return ""; }
}

async function claudeJSON({ system, user, schema, effort = "medium", maxTokens = 4000 }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, output_config: { format: { type: "json_schema", schema }, effort }, system, messages: [{ role: "user", content: user }] }),
    });
    if (r.status === 429 || r.status === 529) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    if (data.stop_reason === "refusal") throw new Error("refusal");
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) throw new Error("no output");
    return JSON.parse(block.text);
  }
  throw new Error("Claude rate-limited after retries");
}
async function proposeKeywords({ title, transcript }) {
  const out = await claudeJSON({
    effort: "low", maxTokens: 800,
    system: "You are an SEO keyword strategist. Given a gaming video's title and transcript, propose 6–8 realistic search queries a person might type into Google to find this content. Mix head terms and specific long-tail phrases. Match search intent. Return lowercase phrases, no punctuation, no hashtags. JSON only.",
    user: `Title: ${title}\n\nTranscript:\n${(transcript || "").slice(0, 8000)}`,
    schema: { type: "object", additionalProperties: false, properties: { candidates: { type: "array", items: { type: "string" } } }, required: ["candidates"] },
  });
  return (out.candidates || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 8);
}

// ---------- DataForSEO ----------
async function dfsPost(path_, task) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const r = await fetch(`https://api.dataforseo.com${path_}`, { method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json" }, body: JSON.stringify([task]) });
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
async function serpBrief(keyword) {
  const res = await dfsPost("/v3/serp/google/organic/live/advanced", { keyword, location_code: DFS_LOC, language_code: DFS_LANG, depth: 10 }).catch(() => []);
  const items = (res[0] || {}).items || [];
  const organic = items.filter((i) => i.type === "organic").slice(0, 10).map((i) => ({ title: i.title, description: i.description }));
  const paa = items.filter((i) => i.type === "people_also_ask").flatMap((i) => (i.items || []).map((q) => q.title)).slice(0, 8);
  const related = items.filter((i) => i.type === "related_searches").flatMap((i) => i.items || []).slice(0, 10);
  return { organic, paa, related, count: organic.length };
}

// ---------- on-page SEO editor ----------
const RUBRIC =
  "You are a senior on-page SEO editor for Akshon Media, a gaming-media YouTube channel. Write the blog post for a video so it RANKS in Google for the given primary keyword AND makes the reader click through to watch the full video on YouTube. Requirements:\n" +
  "- Put the exact primary keyword in: the title (near the front), the meta description, the first ~100 words of the body, and at least one '##' subheading.\n" +
  "- TITLE TAG 20–60 chars. META DESCRIPTION 140–160 chars, includes the keyword + a hook implying 'watch the video'. SLUG short, hyphenated, keyword-based.\n" +
  "- BODY 300–550 words of original, people-first prose (never a transcript dump, no sponsor/promo lines), with 3–5 '##' subheadings. If competitor/PAA info is provided, cover the important subtopics and answer the People-Also-Ask questions so the post is MORE complete than what currently ranks — without keyword-stuffing.\n" +
  "- Pick 4–6 secondary keywords actually used in the copy. End by pointing readers to watch the full video.\n" +
  "- FAQ: include 4–6 frequently-asked questions with concise, genuinely useful answers (40–80 words each). PRIORITIZE the 'People Also Ask' questions if provided; otherwise infer the real questions a viewer would search. Weave relevant keywords in naturally.\n" +
  "Return only the requested JSON.";
const EDITOR_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string" }, slug: { type: "string" }, meta_description: { type: "string" },
    category: { type: "string", enum: ["originals", "press"] }, body_markdown: { type: "string" },
    primary_keyword: { type: "string" }, secondary_keywords: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } }, seo_notes: { type: "string" },
    faq: { type: "array", items: { type: "object", additionalProperties: false, properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] } },
  },
  required: ["title", "slug", "meta_description", "category", "body_markdown", "primary_keyword", "secondary_keywords", "tags", "seo_notes", "faq"],
};
function serpText(serp) {
  if (!serp || !serp.count) return "";
  let t = "\n\nWHAT CURRENTLY RANKS for this keyword (out-cover these — be more complete, don't copy):\n";
  serp.organic.forEach((o, i) => { t += `${i + 1}. ${o.title}${o.description ? " — " + o.description : ""}\n`; });
  if (serp.paa.length) t += "\nPeople Also Ask (answer these in the post):\n- " + serp.paa.join("\n- ") + "\n";
  if (serp.related.length) t += "\nRelated searches (use as secondary keywords where natural): " + serp.related.join(", ") + "\n";
  return t;
}
async function runEditor({ title, source, videoUrl, keywordRows, serp, revision, previous }) {
  let u = `Video title: ${title}\nYouTube URL: ${videoUrl}\n`;
  if (keywordRows && keywordRows.length) {
    u += "\nCandidate keywords with real data (volume / difficulty 0-100 / opportunity), best-first — choose the primary keyword high on this list unless intent clearly demands otherwise:\n" +
      keywordRows.map((r) => `- "${r.keyword}": volume ${r.volume}, difficulty ${r.difficulty == null ? "n/a" : r.difficulty}, opportunity ${r.opportunity}`).join("\n") + "\n";
  } else u += "\n(No live keyword data — choose the best primary keyword from SEO judgment.)\n";
  u += serpText(serp);
  if (revision && previous) {
    u += `\n\nREVISION: your previous draft failed these on-page SEO checks: ${revision}. Fix ALL of them while keeping quality and the SAME primary keyword. Previous draft:\nTITLE: ${previous.title}\nMETA: ${previous.meta_description}\nSLUG: ${previous.slug}\nBODY:\n${previous.body_markdown}\n`;
  }
  u += `\nSource material (transcript or existing article — rewrite into an original SEO post, do not copy verbatim):\n${(source || "").slice(0, 20000)}`;
  return claudeJSON({ system: RUBRIC, user: u, schema: EDITOR_SCHEMA, effort: "medium", maxTokens: 4000 });
}
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
    { label: "kw in title", pass: title.includes(kw) },
    { label: "kw near start of title", pass: title.includes(kw) && title.indexOf(kw) <= title.length * 0.5 },
    { label: "title 20–60 chars", pass: (ai.title || "").length >= 20 && (ai.title || "").length <= 60 },
    { label: "kw in meta", pass: meta.toLowerCase().includes(kw) },
    { label: "meta 140–160", pass: meta.length >= 140 && meta.length <= 160 },
    { label: "kw in first 100 words", pass: first100.includes(kw) },
    { label: "kw in a subheading", pass: inH2 },
    { label: "body ≥ 300 words", pass: bodyWords.length >= 300 },
    { label: "kw in slug", pass: !!inSlug },
  ];
  const passed = checks.filter((c) => c.pass).length;
  return { score: Math.round((passed / checks.length) * 100), checks };
}

// ---------- optimize one video (returns the AI result + score) ----------
async function optimize({ title, source, id }) {
  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  let keywordRows = [], serp = null;
  if (dfsOn) {
    try {
      const candidates = await proposeKeywords({ title, transcript: source });
      if (candidates.length) keywordRows = await keywordData(candidates);
      const kw = keywordRows[0] && keywordRows[0].keyword;
      if (kw) serp = await serpBrief(kw);
    } catch { /* resilient */ }
  }
  let ai = await runEditor({ title, source, videoUrl, keywordRows, serp });
  let scored = scoreSEO(ai, ai.primary_keyword);
  if (scored.score < SCORE_PASS) {
    const failing = scored.checks.filter((c) => !c.pass).map((c) => c.label).join("; ");
    try {
      const ai2 = await runEditor({ title, source, videoUrl, keywordRows, serp, revision: failing, previous: ai });
      const scored2 = scoreSEO(ai2, ai2.primary_keyword);
      if (scored2.score >= scored.score) { ai = ai2; scored = scored2; }
    } catch {}
  }
  const kwStat = keywordRows.find((r) => r.keyword.toLowerCase() === String(ai.primary_keyword).toLowerCase());
  return { ai, score: scored.score, kwStat };
}

// ---------- markdown writer (preserves existing identity) ----------
function esc(s) { return String(s).replace(/"/g, '\\"'); }
function list(a) { return `[${(a || []).map((t) => `"${esc(t)}"`).join(", ")}]`; }
function buildMarkdown({ ai, id, date, category, thumbnail, seoScore, draft }) {
  const lines = ["---", `title: "${esc(ai.title)}"`, `date: ${date}`, `youtube_id: "${id}"`,
    `category: ${category || ai.category || "originals"}`,
    `thumbnail: "${thumbnail || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`}"`,
    `description: "${esc(ai.meta_description)}"`,
    `primary_keyword: "${esc(ai.primary_keyword || "")}"`, `secondary_keywords: ${list(ai.secondary_keywords)}`,
    `tags: ${list(ai.tags)}`, `seo_score: ${seoScore}`, `seo_notes: "${esc(ai.seo_notes || "")}"`,
    `faq: ${JSON.stringify((ai.faq || []).filter((q) => q && q.question && q.answer))}`];
  if (draft) lines.push("draft: true");
  lines.push("---", "", ai.body_markdown.trim(), "");
  return lines.join("\n");
}

// ---------- YouTube Data API discovery (optional) ----------
function iso8601ToSeconds(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}
async function ytUploadsPlaylist(handle) {
  const h = handle.replace(/^@/, "");
  const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(h)}&key=${process.env.YT_API_KEY}`);
  if (!r.ok) throw new Error(`YouTube channels ${r.status}`);
  const j = await r.json();
  const up = j.items && j.items[0] && j.items[0].contentDetails && j.items[0].contentDetails.relatedPlaylists && j.items[0].contentDetails.relatedPlaylists.uploads;
  if (!up) throw new Error("could not resolve uploads playlist for " + handle);
  return up;
}
async function ytAllVideoIds(playlistId) {
  const ids = []; let pageToken = "";
  do {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${playlistId}&pageToken=${pageToken}&key=${process.env.YT_API_KEY}`);
    if (!r.ok) throw new Error(`YouTube playlistItems ${r.status}`);
    const j = await r.json();
    for (const it of j.items || []) if (it.contentDetails && it.contentDetails.videoId) ids.push(it.contentDetails.videoId);
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return ids;
}
async function ytVideoDetails(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${batch.join(",")}&key=${process.env.YT_API_KEY}`);
    if (!r.ok) throw new Error(`YouTube videos ${r.status}`);
    const j = await r.json();
    for (const v of j.items || []) out[v.id] = { title: v.snippet.title, date: (v.snippet.publishedAt || "").slice(0, 10), seconds: iso8601ToSeconds(v.contentDetails.duration) };
  }
  return out;
}

// ---------- main ----------
async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  const existingById = {};   // youtube_id -> filename
  const worklist = [];       // { kind:'existing'|'new', file?, id, title, date?, category?, thumbnail?, source? }

  // existing posts
  for (const f of files) {
    const raw = readFileSync(path.join(DIR, f), "utf8");
    const parts = splitFrontmatter(raw);
    if (!parts) continue;
    const id = field(parts.front, "youtube_id");
    if (id) existingById[id] = f;
    const already = /^seo_score:/m.test(parts.front);
    if (already && !FORCE) continue;
    worklist.push({
      kind: "existing", file: f, id,
      title: field(parts.front, "title") || f.replace(/\.md$/, ""),
      date: field(parts.front, "date") || new Date().toISOString().slice(0, 10),
      category: field(parts.front, "category") || "originals",
      thumbnail: field(parts.front, "thumbnail") || "",
      draft: /^draft:\s*true/m.test(parts.front),
      body: parts.body,
    });
  }

  // discover missing long-form channel videos
  let discovered = 0;
  if (DISCOVER && process.env.YT_API_KEY) {
    try {
      const pl = await ytUploadsPlaylist(YT_CHANNEL);
      const allIds = await ytAllVideoIds(pl);
      const details = await ytVideoDetails(allIds);
      for (const id of allIds) {
        if (existingById[id]) continue;                 // already have a post
        const d = details[id]; if (!d) continue;
        if (d.seconds < MIN_DURATION) continue;         // skip Shorts / clips
        worklist.push({ kind: "new", id, title: d.title, date: d.date || new Date().toISOString().slice(0, 10), category: "originals", draft: true });
        discovered++;
      }
      console.log(`Discovery: ${allIds.length} channel uploads · ${discovered} new long-form (≥${MIN_DURATION}s) not yet on site.`);
    } catch (e) { console.log(`Discovery skipped: ${e.message}`); }
  } else if (DISCOVER) {
    console.log("Discovery skipped: set YT_API_KEY to pull missing long-form videos.");
  }

  const todo = worklist.slice(0, LIMIT);
  const nExisting = todo.filter((t) => t.kind === "existing").length;
  const nNew = todo.filter((t) => t.kind === "new").length;
  console.log(`\nProcessing ${todo.length} videos (${nExisting} optimize, ${nNew} create) · DataForSEO ${dfsOn ? "ON" : "OFF"} · transcripts ${process.env.TRANSCRIPT_API_KEY ? "ON" : "body-fallback"} · model ${MODEL}\n`);

  let done = 0, created = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const t = todo[i++];
      try {
        // source text: fresh transcript, else existing body (existing posts), else meta only
        let source = t.id ? await fetchTranscript(t.id) : "";
        if (!source && t.kind === "existing") source = t.body || "";
        let title = t.title;
        if (t.kind === "new" && (!source || source.length < 60)) {
          // new video with no transcript → still need *some* material; use YouTube title + fetched meta
          const meta = await fetchMeta(t.id); title = meta.title || title;
          if (!source) { console.log(`  [skip] ${t.id} — no transcript/body available`); continue; }
        }
        const { ai, score } = await optimize({ title, source, id: t.id });
        const md = buildMarkdown({ ai, id: t.id, date: t.date, category: t.category, thumbnail: t.thumbnail, seoScore: score, draft: t.kind === "new" ? true : t.draft });
        let outfile = t.file;
        if (t.kind === "new") {
          let base = slugify(ai.slug || ai.primary_keyword || title) || t.id;
          let name = `${base}.md`, n = 2;
          while (files.includes(name)) { name = `${base}-${n++}.md`; }
          files.push(name); outfile = name; created++;
        }
        writeFileSync(path.join(DIR, outfile), md);
        done++;
        console.log(`  [${t.kind === "new" ? "new" : "opt"}] ${outfile}  score ${score}  kw "${ai.primary_keyword}"`);
      } catch (e) { failed++; console.log(`  [err] ${t.id || t.file}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  console.log(`\nDone. Optimized/created ${done} (new drafts: ${created}), failed ${failed}, deferred by LIMIT: ${worklist.length - todo.length}.`);
  console.log("New videos are committed as draft: true — review in /admin before they go live.");
}
main().catch((e) => { console.error(e); process.exit(1); });
