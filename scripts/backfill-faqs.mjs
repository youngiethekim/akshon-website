// backfill-faqs.mjs — add an FAQ (+ FAQPage schema on the built page) to every
// existing video post that doesn't already have one.
//
// Run via the "Backfill FAQs" GitHub Action (one click), or locally:
//   ANTHROPIC_API_KEY=... node scripts/backfill-faqs.mjs
// Optional: DATAFORSEO_LOGIN/PASSWORD (real People-Also-Ask questions),
//   CLAUDE_MODEL (default claude-opus-4-8), DATAFORSEO_LOCATION (2840), DATAFORSEO_LANGUAGE (en),
//   LIMIT (process at most N posts this run), CONCURRENCY (default 4).
//
// Idempotent: skips any post whose frontmatter already has `faq:`.

import { readdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";
const DFS_LOC = Number(process.env.DATAFORSEO_LOCATION || 2840);
const DFS_LANG = process.env.DATAFORSEO_LANGUAGE || "en";
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const DIR = "content/videos";

if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY is required."); process.exit(1); }
const dfsOn = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

function splitFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  return m ? { front: m[1], body: m[2] } : null;
}
function field(front, name) {
  const m = new RegExp(`^${name}:\\s*"?(.*?)"?\\s*$`, "m").exec(front);
  return m ? m[1] : "";
}

async function claudeFAQ({ title, body, paa }) {
  const schema = {
    type: "object", additionalProperties: false,
    properties: { faq: { type: "array", items: { type: "object", additionalProperties: false,
      properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] } } },
    required: ["faq"],
  };
  let user = `Video title: ${title}\n\nArticle:\n${(body || "").slice(0, 8000)}`;
  if (paa && paa.length) user += `\n\nPeople Also Ask (prioritize answering these — they are what Google surfaces):\n- ${paa.join("\n- ")}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500,
      output_config: { format: { type: "json_schema", schema }, effort: "low" },
      system: "You write a concise FAQ for a gaming-media blog post so it can rank for question searches on Google. Produce 4–6 real, useful question/answer pairs (answers 40–80 words). Prioritize any 'People Also Ask' questions provided; otherwise infer questions a viewer would actually search. Ground answers in the article; do not invent facts. JSON only.",
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  if (data.stop_reason === "refusal") throw new Error("refusal");
  const block = (data.content || []).find((b) => b.type === "text");
  const out = JSON.parse(block.text);
  return (out.faq || []).filter((q) => q && q.question && q.answer).slice(0, 6);
}

async function serpPAA(keyword) {
  try {
    const auth = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString("base64");
    const r = await fetch("https://api.dataforseo.com/v3/serp/google/organic/live/advanced", {
      method: "POST", headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
      body: JSON.stringify([{ keyword, location_code: DFS_LOC, language_code: DFS_LANG, depth: 10 }]),
    });
    if (!r.ok) return [];
    const items = ((((await r.json()).tasks || [])[0] || {}).result || [])[0]?.items || [];
    return items.filter((i) => i.type === "people_also_ask").flatMap((i) => (i.items || []).map((q) => q.title)).slice(0, 8);
  } catch { return []; }
}

async function processFile(file) {
  const fp = path.join(DIR, file);
  const raw = readFileSync(fp, "utf8");
  const parts = splitFrontmatter(raw);
  if (!parts) return { file, status: "skip (no frontmatter)" };
  if (/^faq:/m.test(parts.front)) return { file, status: "skip (has faq)" };
  const title = field(parts.front, "title") || file.replace(/\.md$/, "");
  const keyword = field(parts.front, "primary_keyword") || title;
  const paa = dfsOn ? await serpPAA(keyword) : [];
  const faq = await claudeFAQ({ title, body: parts.body, paa });
  if (!faq.length) return { file, status: "skip (no faq produced)" };
  const newFront = parts.front.replace(/\s*$/, "") + `\nfaq: ${JSON.stringify(faq)}`;
  writeFileSync(fp, `---\n${newFront}\n---\n${parts.body}`);
  return { file, status: `updated (${faq.length} Q&A${paa.length ? ", PAA-grounded" : ""})` };
}

async function main() {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
  const todo = files.filter((f) => !/^faq:/m.test(splitFrontmatter(readFileSync(path.join(DIR, f), "utf8"))?.front || "")).slice(0, LIMIT);
  console.log(`${files.length} posts total · ${todo.length} need an FAQ · DataForSEO PAA: ${dfsOn ? "on" : "off"} · model ${MODEL}`);
  let updated = 0, failed = 0, i = 0;
  async function worker() {
    while (i < todo.length) {
      const f = todo[i++];
      try { const r = await processFile(f); if (r.status.startsWith("updated")) updated++; console.log(`  ${r.file}: ${r.status}`); }
      catch (e) { failed++; console.log(`  ${f}: ERROR ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  console.log(`\nDone. Updated ${updated}, failed ${failed}, skipped ${files.length - todo.length}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
