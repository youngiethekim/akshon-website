// generate-video — Netlify serverless function (SEO agent)
//
// Flow: paste a YouTube URL (+ optional pasted transcript) →
//   1. fetch title/thumbnail (oEmbed) and transcript
//   2. Claude proposes candidate target keywords from the content
//   3. [optional] DataForSEO returns real search volume + difficulty for them
//   4. Claude "on-page SEO editor" writes an optimized title, meta description,
//      headings, and body targeting the best keyword — engineered to rank AND
//      drive the click to YouTube
//   5. commit a *draft* markdown post; Netlify rebuilds; you review in /admin.
//
// Zero npm dependencies — talks to the Anthropic, DataForSEO, GitHub and YouTube
// REST APIs directly via fetch, so it bundles and deploys with no toolchain.
//
// Required env vars (Netlify → Site configuration → Environment variables):
//   ANTHROPIC_API_KEY    - Claude API key (console.anthropic.com)
//   GITHUB_TOKEN         - fine-grained token, Contents:Read+Write on this repo
//   GITHUB_REPO          - "youngiethekim/akshon-website"
//   TRANSCRIPT_API_KEY   - Supadata key (supadata.ai) for auto transcripts
// Optional — enables real keyword grounding (recommended):
//   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD  - dataforseo.com API credentials
//   DATAFORSEO_LOCATION  - numeric location code (default 2840 = United States)
//   DATAFORSEO_LANGUAGE  - language code (default "en")
// Optional:
//   CLAUDE_MODEL         - default "claude-opus-4-8" ("claude-haiku-4-5" = cheaper)
//   GITHUB_BRANCH        - default "main"

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const DFS_LOC = Number(process.env.DATAFORSEO_LOCATION || 2840);
const DFS_LANG = process.env.DATAFORSEO_LANGUAGE || "en";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function videoId(url) {
  const m = String(url).match(
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return m ? m[1] : null;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function fetchMeta(id) {
  // Primary: oEmbed (clean title). Some videos disable embedding → 401; fall
  // back to the watch page's og:title, then to an empty title (Claude will
  // still write one from the transcript).
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${id}&format=json`);
    if (r.ok) return await r.json();
  } catch {}
  try {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    const r = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "user-agent": UA } });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/<meta property="og:title" content="([^"]*)"/);
      if (m) return { title: m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"') };
    }
  } catch {}
  return { title: "" };
}

async function fetchTranscript(id) {
  const key = process.env.TRANSCRIPT_API_KEY;
  if (!key) throw new Error("No transcript found and TRANSCRIPT_API_KEY is not set — paste the script instead.");
  const r = await fetch(
    `https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=${id}&text=true`,
    { headers: { "x-api-key": key } }
  );
  if (!r.ok) throw new Error(`Transcript service returned ${r.status} — this video may have no captions. Paste the script instead.`);
  const data = await r.json();
  const text = typeof data.content === "string" ? data.content
    : Array.isArray(data.content) ? data.content.map((c) => c.text || "").join(" ") : "";
  if (!text.trim()) throw new Error("Transcript came back empty — paste the script instead.");
  return text;
}

// ---- Claude helper (structured JSON output) ----
async function claudeJSON({ system, user, schema, effort = "medium", maxTokens = 4000 }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      output_config: { format: { type: "json_schema", schema }, effort },
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("Claude declined to process this content.");
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new Error("Claude returned no output.");
  return JSON.parse(block.text);
}

// ---- Stage 1: propose candidate target keywords ----
async function proposeKeywords({ title, transcript }) {
  const schema = {
    type: "object", additionalProperties: false,
    properties: { candidates: { type: "array", items: { type: "string" } } },
    required: ["candidates"],
  };
  const out = await claudeJSON({
    effort: "low", maxTokens: 800,
    system:
      "You are an SEO keyword strategist. Given a gaming video's title and transcript, " +
      "propose 6–8 realistic search queries a person might type into Google to find this " +
      "content. Mix head terms and specific long-tail phrases. Match search intent. " +
      "Return lowercase phrases, no punctuation, no hashtags. JSON only.",
    user: `Title: ${title}\n\nTranscript:\n${transcript.slice(0, 8000)}`,
    schema,
  });
  return (out.candidates || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 8);
}

// ---- Stage 2 (optional): ground keywords in real DataForSEO data ----
function dfsEnabled() {
  return process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD;
}
async function dfsPost(path, task) {
  const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
  const r = await fetch(`https://api.dataforseo.com${path}`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
    body: JSON.stringify([task]),
  });
  if (!r.ok) throw new Error(`DataForSEO ${r.status}`);
  const data = await r.json();
  return (((data.tasks || [])[0] || {}).result) || [];
}
async function keywordData(candidates) {
  // Search volume (Google Ads) + keyword difficulty (DataForSEO Labs)
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
    const kw = v.keyword.toLowerCase();
    const volume = v.search_volume || 0;
    const kd = diffMap[kw];
    const difficulty = typeof kd === "number" ? kd : null;
    // opportunity: reward volume, penalize difficulty
    const opp = volume * (difficulty == null ? 0.6 : (100 - difficulty) / 100);
    rows.push({ keyword: v.keyword, volume, difficulty, cpc: v.cpc || null, opportunity: Math.round(opp) });
  }
  rows.sort((a, b) => b.opportunity - a.opportunity);
  return rows;
}

// ---- Stage 3: SEO editor writes optimized post ----
const SEO_RUBRIC =
  "You are a senior on-page SEO editor for Akshon Media, a gaming-media YouTube channel. " +
  "Write the blog post for a video so it ranks in Google AND makes the reader click through " +
  "to watch the full video on YouTube. Follow on-page SEO best practices strictly:\n" +
  "- Choose ONE primary keyword (best mix of real search demand, winnable difficulty, and intent match).\n" +
  "- TITLE TAG: <=60 chars, primary keyword near the front, compelling, true to the video.\n" +
  "- META DESCRIPTION: 150–160 chars, include the primary keyword naturally + a hook, implying 'watch the video'.\n" +
  "- SLUG: short, hyphenated, keyword-based.\n" +
  "- BODY: 250–450 words of original, people-first prose (never a transcript dump). " +
  "Put the primary keyword in the first ~100 words. Use 2–4 '##' subheadings carrying secondary/semantic keywords. " +
  "Natural keyword usage — no stuffing. Match informational intent. End by pointing readers to watch the full video.\n" +
  "- Pick 3–6 secondary keywords actually used in the copy.\n" +
  "Return only the requested JSON.";

async function seoEditor({ title, transcript, videoUrl, keywordRows }) {
  const schema = {
    type: "object", additionalProperties: false,
    properties: {
      title: { type: "string" },
      slug: { type: "string" },
      meta_description: { type: "string" },
      category: { type: "string", enum: ["originals", "press"] },
      body_markdown: { type: "string" },
      primary_keyword: { type: "string" },
      secondary_keywords: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
      seo_notes: { type: "string", description: "1–2 sentences on why this target was chosen" },
    },
    required: ["title", "slug", "meta_description", "category", "body_markdown", "primary_keyword", "secondary_keywords", "tags", "seo_notes"],
  };
  let dataBlock = "";
  if (keywordRows && keywordRows.length) {
    dataBlock =
      "\n\nReal keyword data (search volume / difficulty 0-100 / opportunity score), ranked best-first — " +
      "prefer a primary keyword high on this list unless intent clearly demands otherwise:\n" +
      keywordRows.map((r) => `- "${r.keyword}": volume ${r.volume}, difficulty ${r.difficulty == null ? "n/a" : r.difficulty}, opportunity ${r.opportunity}`).join("\n");
  } else {
    dataBlock =
      "\n\n(No live keyword data available — choose the primary keyword from your own SEO judgment and note that it is an estimate.)";
  }
  return claudeJSON({
    effort: "medium", maxTokens: 4000,
    system: SEO_RUBRIC,
    user: `Video title: ${title}\nYouTube URL: ${videoUrl}${dataBlock}\n\nTranscript / script:\n${transcript.slice(0, 22000)}`,
    schema,
  });
}

// ---- GitHub commit ----
async function ghGet(path) {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "akshon-generate-video" },
  });
}
async function uniqueSlug(base) {
  const slug = base || "video";
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const r = await ghGet(`content/videos/${candidate}.md`);
    if (r.status === 404) return candidate;
  }
  return `${slug}-${Date.now()}`;
}
async function commitPost(slug, markdown, title) {
  const path = `content/videos/${slug}.md`;
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "akshon-generate-video", "content-type": "application/json" },
    body: JSON.stringify({ message: `Draft: ${title}`, content: Buffer.from(markdown, "utf8").toString("base64"), branch: BRANCH }),
  });
  if (!r.ok) throw new Error(`GitHub commit failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

function buildMarkdown({ ai, id, date }) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const list = (a) => `[${(a || []).map((t) => `"${esc(t)}"`).join(", ")}]`;
  return [
    "---",
    `title: "${esc(ai.title)}"`,
    `date: ${date}`,
    `youtube_id: "${id}"`,
    `category: ${ai.category || "originals"}`,
    `thumbnail: "https://i.ytimg.com/vi/${id}/hqdefault.jpg"`,
    `description: "${esc(ai.meta_description)}"`,
    `primary_keyword: "${esc(ai.primary_keyword || "")}"`,
    `secondary_keywords: ${list(ai.secondary_keywords)}`,
    `tags: ${list(ai.tags)}`,
    `seo_notes: "${esc(ai.seo_notes || "")}"`,
    "draft: true",
    "---",
    "",
    ai.body_markdown.trim(),
    "",
  ].join("\n");
}

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const user = context.clientContext && context.clientContext.user;
  if (!user) return json(401, { error: "Please log in to use this tool." });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Invalid request." }); }

  const id = videoId(payload.url || "");
  if (!id) return json(400, { error: "That doesn't look like a YouTube link." });

  try {
    const meta = await fetchMeta(id);
    const transcript = payload.script && payload.script.trim().length > 40
      ? payload.script.trim()
      : await fetchTranscript(id);
    const videoUrl = `https://www.youtube.com/watch?v=${id}`;

    // Keyword grounding (optional, resilient)
    let keywordRows = [];
    let grounded = false;
    if (dfsEnabled()) {
      try {
        const candidates = await proposeKeywords({ title: meta.title, transcript });
        if (candidates.length) {
          keywordRows = await keywordData(candidates);
          grounded = keywordRows.length > 0;
        }
      } catch (e) {
        keywordRows = []; // fall back to model judgment on any data failure
      }
    }

    const ai = await seoEditor({ title: meta.title, transcript, videoUrl, keywordRows });

    const slug = await uniqueSlug(slugify(ai.slug || ai.primary_keyword || meta.title));
    const date = new Date().toISOString().slice(0, 10);
    await commitPost(slug, buildMarkdown({ ai, id, date }), ai.title);

    const chosen = grounded
      ? keywordRows.find((r) => r.keyword.toLowerCase() === String(ai.primary_keyword).toLowerCase())
      : null;

    return json(200, {
      ok: true, slug, title: ai.title,
      primary_keyword: ai.primary_keyword,
      secondary_keywords: ai.secondary_keywords,
      seo_notes: ai.seo_notes,
      grounded,
      keyword_stats: chosen ? { volume: chosen.volume, difficulty: chosen.difficulty } : null,
      top_keywords: grounded ? keywordRows.slice(0, 5) : null,
      meta_description: ai.meta_description,
      preview: ai.body_markdown.slice(0, 400),
      editUrl: "/admin/#/collections/videos/entries/" + slug,
      liveUrl: `/video/${slug}/`,
    });
  } catch (err) {
    return json(500, { error: err.message || "Something went wrong." });
  }
};
