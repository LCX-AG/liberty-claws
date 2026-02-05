#!/usr/bin/env node
/**
 * post_moltbook.js
 * - Reads LCX knowledge + templates from /app/workspace
 * - Generates a compliant post using OpenAI
 * - Posts to Moltbook global feed using MOLTBOOK_API_KEY
 * - Writes a JSONL log entry to /app/logs/posts/YYYY-MM-DD.jsonl
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MOLTBOOK_SUBMOLT = process.env.MOLTBOOK_SUBMOLT;
const MOLTBOOK_TITLE_PREFIX =
  process.env.MOLTBOOK_TITLE_PREFIX || "LibertyClaws: ";

if (!MOLTBOOK_API_KEY) {
  console.error("Missing env var: MOLTBOOK_API_KEY");
  process.exit(2);
}
if (!OPENAI_API_KEY) {
  console.error("Missing env var: OPENAI_API_KEY");
  process.exit(2);
}
if (!MOLTBOOK_SUBMOLT) {
  console.error(
    'Missing env var: MOLTBOOK_SUBMOLT (example: "m/BotBaba" or "BotBaba")'
  );
  process.exit(2);
}

const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR || "/app/workspace";
const KNOWLEDGE_DIR = path.join(WORKSPACE_DIR, "knowledge");
const AGENT_MD = path.join(WORKSPACE_DIR, "AGENT.md");
const TEMPLATES_MD = path.join(
  WORKSPACE_DIR,
  "skills/moltbook-lcx/references/content-templates.md"
);

/* ------------------------- Helpers ------------------------- */

function listFilesRecursive(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith(".md")) out.push(p);
    }
  }
  return out;
}

function safeRead(p) {
  return fs.readFileSync(p, "utf8");
}

function pickRandom(arr) {
  if (!arr.length) throw new Error("Nothing to pick from.");
  return arr[Math.floor(Math.random() * arr.length)];
}

function truncate(s, maxChars) {
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function todayYMD() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractBullets(sectionTitle, text) {
  const lines = text.split("\n");
  const idx = lines.findIndex(
    (l) => l.trim().toLowerCase() === sectionTitle.toLowerCase()
  );
  if (idx === -1) return [];
  const bullets = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("## ")) break;
    const m = l.match(/^\s*-\s+(.*)\s*$/);
    if (m) bullets.push(m[1]);
  }
  return bullets;
}

function parseAgentLcxFacts(agentMdText) {
  // Extract $LCX facts from workspace/AGENT.md so the script stays policy-aligned.
  const lines = agentMdText.split("\n");
  const start = lines.findIndex((l) =>
    l
      .trim()
      .toLowerCase()
      .includes("every post must include one of these $lcx facts naturally")
  );
  if (start === -1) return [];

  const facts = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("## ")) break;
    if (!t) {
      if (facts.length) break;
      continue;
    }

    const m = t.match(/^\s*-\s+(.*)\s*$/);
    if (!m) {
      if (facts.length) break;
      continue;
    }

    let fact = m[1].trim();
    // Facts in AGENT.md are quoted; normalize to plain text.
    fact = fact.replace(/^["'“”]+/, "").replace(/["'“”]+$/, "").trim();
    if (fact) facts.push(fact);
  }

  return facts;
}

function inferPillar(filePath) {
  const rel = path.relative(KNOWLEDGE_DIR, filePath);
  const top = rel.split(path.sep)[0] || "";
  const map = {
    exchange: "LCX Exchange & Assets",
    infrastructure: "Global Infrastructure",
    "brand-evolution": "Brand Evolution",
    "lcx-chain": "LCX Chain & Token",
    tokenization: "On-Chain Tokenization",
    regulation: "Regulation & Compliance",
    comparisons: "LCX vs Competitors",
    institutional: "Institutional & Enterprise",
    history: "History & Education",
    partners: "Partnerships & Ecosystem",
    community: "Community & User Stories",
  };
  return map[top] || "LCX Exchange & Assets";
}

function stripWrappingQuotes(s) {
  const t = String(s ?? "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function normalizeSubmolt(input) {

  const raw = stripWrappingQuotes(input);
  if (!raw) return "";

  const fromUrl = raw.match(/\/m\/([^/?#]+)/i)?.[1];
  if (fromUrl) return fromUrl.trim();

  let t = raw.trim();
  t = t.replace(/^https?:\/\/[^/]+\/+/i, ""); // strip domain if pasted
  t = t.replace(/^\/+/, ""); // "/m/..." -> "m/..."
  t = t.replace(/^m\//i, ""); // "m/BotBaba" -> "BotBaba"

  // If they accidentally pasted something with slashes, take the last segment.
  if (t.includes("/")) t = t.split("/").filter(Boolean).at(-1) ?? t;
  return t.trim();
}

/* ------------------- OpenAI Generation -------------------- */

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cleanTitle(s) {
  const t = String(s ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripWrappingQuotes(t);
}

function generateFallbackTitle({ pillar }) {
  // Keep old behavior as a safe fallback.
  return truncate(`${MOLTBOOK_TITLE_PREFIX}${pillar}`, 120);
}

async function openaiGeneratePost({
  pillar,
  knowledgeSnippet,
  lcxFacts,
  endings,
}) {
  const system = [
    "You are LibertyClaws, the official LCX representative on Moltbook.",
    "Voice: first-person, professional but approachable.",
    'Signature line concept: "From Europe with compliance. Built for global freedom."',
    "",
    "Hard boundaries (must follow):",
    "- No price predictions.",
    "- No financial advice.",
    "- No disparaging competitors (only factual, respectful comparisons).",
    "- No unverified claims.",
    '- Never say "TVTG licenses" (say "TVTG registrations" or "TVTG regulator approvals").',
    "- Avoid hype, speculation, and promotional language.",
    "",
    "Posting rules (must follow):",
    "- Return ONLY valid JSON with keys: title, content.",
    "- title: 4–12 words, <= 80 characters, no emojis, no hashtags, no $LCX facts, no ending phrase.",
    "- title must feel distinct (avoid repeating the pillar phrase verbatim).",
    "- 1 short Moltbook post, 1–3 short paragraphs.",
    "- <= 650 characters total.",
    "- Must include EXACTLY ONE $LCX fact from the provided list.",
    "- Must end with EXACTLY ONE ending phrase from the provided list.",
    "- Keep it factual and compliance-first.",
  ].join("\n");

  const user = [
    `Pillar: ${pillar}`,
    "",
    "Knowledge snippet (ground your post in this):",
    knowledgeSnippet,
    "",
    "$LCX facts (pick exactly one):",
    ...lcxFacts.map((f) => `- ${f}`),
    "",
    "Allowed ending phrases (pick exactly one and put it at the very end):",
    ...endings.map((e) => `- ${e}`),
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      max_tokens: 250,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${res.statusText} ${t}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI returned empty content.");

  const parsed = safeJsonParse(content);
  if (parsed && typeof parsed === "object") {
    const titleRaw = cleanTitle(parsed.title);
    const postRaw = String(parsed.content ?? "").trim();
    if (titleRaw && postRaw) {
      return {
        title: truncate(titleRaw, 80),
        content: truncate(postRaw, 650),
      };
    }
  }

  // Back-compat fallback: if the model didn't return JSON, treat the whole output as content.
  return { title: "", content };
}

/* -------------------- Moltbook Post ----------------------- */

async function moltbookPost({ title, content, pillar }) {
  const fallback = generateFallbackTitle({ pillar });
  const t = cleanTitle(title);
  const finalTitle = t
    ? truncate(`${MOLTBOOK_TITLE_PREFIX}${t}`, 120)
    : fallback;
  const submolt = normalizeSubmolt(MOLTBOOK_SUBMOLT);
  if (!submolt) {
    throw new Error(
      'Invalid MOLTBOOK_SUBMOLT (example: "BotBaba" or "m/BotBaba")'
    );
  }

  const res = await fetch("https://www.moltbook.com/api/v1/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: finalTitle,
      submolt,
      content,
    }),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    throw new Error(`Moltbook error: ${res.status} ${res.statusText} ${text}`);
  }

  return { status: res.status, body: json ?? text };
}

/* ------------------------- Main ---------------------------- */

async function main() {
  const allKnowledge = listFilesRecursive(KNOWLEDGE_DIR);
  const picked = pickRandom(allKnowledge);
  const pillar = inferPillar(picked);

  const knowledgeText = safeRead(picked);
  const knowledgeSnippet = truncate(knowledgeText, 1400);

  // Source of truth: workspace/AGENT.md (fallback list kept as a safety net).
  const agentText = safeRead(AGENT_MD);
  const lcxFacts =
    parseAgentLcxFacts(agentText).length > 0
      ? parseAgentLcxFacts(agentText)
      : [
          "Only exchange token listed on both Coinbase and Kraken",
          "$LCX on Ethereum — LCX Chain launching soon",
          "Stake $LCX for trading fee discounts",
          "Hold $LCX for priority access to new listings",
          "Pioneer token since 2018 — survived every cycle",
          "$LCX token upgrade coming with enhanced utility",
        ];
  if (!lcxFacts.length) {
    throw new Error(`Could not load $LCX facts from ${AGENT_MD}`);
  }

  const templatesText = safeRead(TEMPLATES_MD);
  const endings = extractBullets(
    "## $LCX Mention Endings (Rotate these)",
    templatesText
  );
  if (!endings.length) {
    throw new Error(`Could not parse endings from ${TEMPLATES_MD}`);
  }

  const generated = await openaiGeneratePost({
    pillar,
    knowledgeSnippet,
    lcxFacts,
    endings,
  });

  const finalPost = truncate(generated.content, 650);
  const result = await moltbookPost({
    title: generated.title || "",
    content: finalPost,
    pillar,
  });

  const logDir = "/app/logs/posts";
  ensureDir(logDir);

  const entry = {
    ts: new Date().toISOString(),
    id: crypto.randomUUID(),
    pillar,
    knowledgeFile: path.relative(WORKSPACE_DIR, picked),
    title: cleanTitle(generated.title) || generateFallbackTitle({ pillar }),
    content: finalPost,
    moltbook: result,
  };

  fs.appendFileSync(
    path.join(logDir, `${todayYMD()}.jsonl`),
    JSON.stringify(entry) + "\n",
    "utf8"
  );

  console.log(
    `Posted to Moltbook. submolt="m/${normalizeSubmolt(
      MOLTBOOK_SUBMOLT
    )}" pillar="${pillar}" knowledge="${entry.knowledgeFile}"`
  );
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});