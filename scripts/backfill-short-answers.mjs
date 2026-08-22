// backfill-short-answers.mjs — add a 40–60 word "short answer" to each video post.
// Renders as a "Short answer:" block at the top of the post (AI-Overview / featured-snippet target).
//
// Cheap: one small Claude call per post from the existing article text — no keyword research.
// Run via the "Backfill short answers" GitHub Action, or locally:
//   ANTHROPIC_API_KEY=... node scripts/backfill-short-answers.mjs
// Optional: CLAUDE_MODEL (default claude-haiku-4-5-20251001), LIMIT, CONCURRENCY (default 5), FORCE (1 = redo).
// Idempotent: skips any post whose frontmatter already has `short_answer:`.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const FORCE = process.env.FORCE === "1" || process.env.FORCE === "true";
const DIR = "content/videos";
let USE_EFFORT = !/haiku/i.test(MODEL); // Haiku doesn't support output_config.effort

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required."); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function splitFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  return m ? { front: m[1], body: m[2] } : null;
}
function field(front, name) {
  const m = new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(front);
  return m ? m[1] : "";
}

async function shortAnswer({ title, body }) {
  const schema = { type: "object", additionalProperties: false,
    properties: { short_answer: { type: "string" } }, required: ["short_answer"] };
  for (let attempt = 0; attempt < 5; attempt++) {
    const output_config = { format: { type: "json_schema", schema } };
    if (USE_EFFORT) output_config.effort = "low";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, output_config,
        system: "You write the 'short answer' block for a gaming-media blog post so it can win an AI Overview / featured snippet. Write ONE direct, factual answer of 40–60 words to the core question the video addresses (e.g. what happened, why it matters). Third person, plain, no hype, no 'in this video', no first person. Ground it strictly in the article. JSON only.",
        messages: [{ role: "user", content: `Title: ${title}\n\nArticle:\n${(body || "").slice(0, 6000)}` }] }),
    });
    if (r.status === 429 || r.status === 529) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 400 && /effort/i.test(t) && USE_EFFORT) { USE_EFFORT = false; continue; }
      throw new Error(`Claude ${r.status}: ${t.slice(0, 160)}`);
    }
    const data = await r.json();
    if (data.stop_reason === "refusal") throw new Error("refusal");
    const block = (data.content || []).find((b) => b.type === "text");
    const out = JSON.parse(block.text);
    return (out.short_answer || "").trim();
  }
  throw new Error("rate-limited after retries");
}

async function processFile(file) {
  const fp = path.join(DIR, file);
  const raw = readFileSync(fp, "utf8");
  const parts = splitFrontmatter(raw);
  if (!parts) return { file, status: "skip (no frontmatter)" };
  if (/^short_answer:/m.test(parts.front) && !FORCE) return { file, status: "skip (has short_answer)" };
  const title = field(parts.front, "title") || file.replace(/\.md$/, "");
  const sa = await shortAnswer({ title, body: parts.body });
  if (!sa) return { file, status: "skip (empty)" };
  const esc = sa.replace(/"/g, '\\"');
  let front = parts.front.replace(/^short_answer:.*$/m, "").replace(/\n{2,}/g, "\n").replace(/\s*$/, "");
  front += `\nshort_answer: "${esc}"`;
  writeFileSync(fp, `---\n${front}\n---\n${parts.body}`);
  return { file, status: `updated (${sa.split(/\s+/).length} words)` };
}

async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  const todo = files.filter((f) => FORCE || !/^short_answer:/m.test(splitFrontmatter(readFileSync(path.join(DIR, f), "utf8"))?.front || "")).slice(0, LIMIT);
  console.log(`${files.length} posts · ${todo.length} need a short answer · model ${MODEL}`);
  let updated = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const f = todo[i++];
      try { const r = await processFile(f); if (r.status.startsWith("updated")) updated++; console.log(`  ${r.file}: ${r.status}`); }
      catch (e) { failed++; console.log(`  ${f}: ERROR ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  console.log(`\nDone. Updated ${updated}, failed ${failed}, deferred by LIMIT ${files.length - todo.length}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
