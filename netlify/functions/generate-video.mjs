// generate-video — Netlify serverless function
//
// Flow: paste a YouTube URL (+ optional pasted transcript) → fetch the video's
// title/thumbnail (oEmbed) and transcript → summarize with Claude into an
// SEO-optimized article → commit a *draft* markdown post to the repo. Netlify
// rebuilds; the draft is hidden from the live site until reviewed & published
// in /admin.
//
// Uses the Anthropic + GitHub REST APIs directly via fetch — zero npm
// dependencies, so it bundles and deploys reliably with no build toolchain.
//
// Required environment variables (set in Netlify → Site configuration → Env):
//   ANTHROPIC_API_KEY   - your Anthropic API key (console.anthropic.com)
//   GITHUB_TOKEN        - a GitHub token with contents:write on this repo
//   GITHUB_REPO         - "youngiethekim/akshon-website"
//   TRANSCRIPT_API_KEY  - a Supadata API key (supadata.ai) for auto transcripts
// Optional:
//   CLAUDE_MODEL        - defaults to "claude-opus-4-8" (set "claude-haiku-4-5"
//                         to cut cost ~5x with slightly simpler summaries)
//   GITHUB_BRANCH       - defaults to "main"

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const BRANCH = process.env.GITHUB_BRANCH || "main";

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
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function fetchOEmbed(id) {
  const r = await fetch(
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`
  );
  if (!r.ok) throw new Error("Could not read this video from YouTube (is it public?).");
  return r.json(); // { title, author_name, thumbnail_url, ... }
}

async function fetchTranscript(id) {
  const key = process.env.TRANSCRIPT_API_KEY;
  if (!key) throw new Error("No transcript found and TRANSCRIPT_API_KEY is not set — paste the script instead.");
  const url = `https://api.supadata.ai/v1/transcript?url=https://www.youtube.com/watch?v=${id}&text=true`;
  const r = await fetch(url, { headers: { "x-api-key": key } });
  if (!r.ok) {
    throw new Error(`Transcript service returned ${r.status} — this video may have no captions. Paste the script instead.`);
  }
  const data = await r.json();
  // Supadata returns { content: "..." } with text=true, or an array of segments.
  const text =
    typeof data.content === "string"
      ? data.content
      : Array.isArray(data.content)
      ? data.content.map((c) => c.text || "").join(" ")
      : "";
  if (!text.trim()) throw new Error("Transcript came back empty — paste the script instead.");
  return text;
}

async function summarize({ title, transcript, videoUrl }) {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string", description: "SEO page title, close to the YouTube title" },
      slug: { type: "string", description: "url-safe-slug-with-hyphens" },
      meta_description: { type: "string", description: "~155 character search-result description" },
      category: { type: "string", enum: ["originals", "press"] },
      body_markdown: {
        type: "string",
        description: "The article body in markdown with ## subheadings",
      },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["title", "slug", "meta_description", "category", "body_markdown", "tags"],
  };

  const system =
    "You are an SEO editor for Akshon Media, a gaming-media YouTube channel. " +
    "You write a summary article for a video's blog post. The article's job is to " +
    "rank in Google search AND make the reader want to watch the full video on YouTube. " +
    "Write 250–450 words of genuinely useful, original prose (never a transcript dump): " +
    "a strong hook, 2–4 '##' subheadings, and a closing line that points the reader to " +
    "watch the full video. Do NOT reveal every payoff — leave a reason to click through. " +
    "Return only the requested JSON.";

  const user =
    `Video title: ${title}\nYouTube URL: ${videoUrl}\n\nTranscript / script:\n` +
    transcript.slice(0, 24000);

  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      output_config: { format: { type: "json_schema", schema }, effort: "medium" },
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Claude API error ${r.status}: ${detail.slice(0, 300)}`);
  }
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("Claude declined to summarize this content.");
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude returned no text output.");
  return JSON.parse(textBlock.text);
}

async function ghGet(path) {
  return fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "akshon-generate-video",
    },
  });
}

async function uniqueSlug(base) {
  let slug = base || "video";
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
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "akshon-generate-video",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      message: `Draft: ${title}`,
      content: Buffer.from(markdown, "utf8").toString("base64"),
      branch: BRANCH,
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`GitHub commit failed ${r.status}: ${detail.slice(0, 300)}`);
  }
}

function buildMarkdown({ ai, id, date }) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const fm = [
    "---",
    `title: "${esc(ai.title)}"`,
    `date: ${date}`,
    `youtube_id: "${id}"`,
    `category: ${ai.category || "originals"}`,
    `thumbnail: "https://i.ytimg.com/vi/${id}/hqdefault.jpg"`,
    `description: "${esc(ai.meta_description)}"`,
    `tags: [${(ai.tags || []).map((t) => `"${esc(t)}"`).join(", ")}]`,
    "draft: true",
    "---",
    "",
    ai.body_markdown.trim(),
    "",
  ];
  return fm.join("\n");
}

export const handler = async (event, context) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  // Auth gate: require a logged-in Netlify Identity user.
  const user = context.clientContext && context.clientContext.user;
  if (!user) return json(401, { error: "Please log in to use this tool." });

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request." });
  }

  const id = videoId(payload.url || "");
  if (!id) return json(400, { error: "That doesn't look like a YouTube link." });

  try {
    const meta = await fetchOEmbed(id);
    const transcript =
      payload.script && payload.script.trim().length > 40
        ? payload.script.trim()
        : await fetchTranscript(id);

    const ai = await summarize({ title: meta.title, transcript, videoUrl: `https://www.youtube.com/watch?v=${id}` });

    const slug = await uniqueSlug(slugify(ai.slug || meta.title));
    const date = new Date().toISOString().slice(0, 10);
    const markdown = buildMarkdown({ ai, id, date });
    await commitPost(slug, markdown, ai.title);

    return json(200, {
      ok: true,
      slug,
      title: ai.title,
      meta_description: ai.meta_description,
      preview: ai.body_markdown.slice(0, 400),
      editUrl: "/admin/#/collections/videos/entries/" + slug,
      liveUrl: `/video/${slug}/`,
    });
  } catch (err) {
    return json(500, { error: err.message || "Something went wrong." });
  }
};
