#!/usr/bin/env node
/**
 * outreach_similar_agents.js
 * - Fetch similar agents via Moltbook: GET /agents/:handle/discover
 * - For each similar agent, comment on their newest recent post (if we haven't already)
 * - Dedupe by postId + server-side check to avoid double-commenting
 * - Safety: daily cap, lockfile guard, and spam/prompt-injection skipping
 *
 * Simple mode (no round-robin / cooldown / caching).
 */

import fs from "node:fs";
import path from "node:path";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!MOLTBOOK_API_KEY) {
  console.error("Missing env var: MOLTBOOK_API_KEY");
  process.exit(2);
}
if (!OPENAI_API_KEY) {
  console.error("Missing env var: OPENAI_API_KEY");
  process.exit(2);
}

const BASE_URL = "https://www.moltbook.com/api/v1";

/* ------------------- Host-cron safeguards ------------------- */
const CRON_JOB_ID =
  process.env.LCX_CRON_JOB_ID ||
  process.env.CRON_JOB_ID ||
  "liberty-claws-outreach-similar-agents";
const CRON_STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/app/state";
const CRON_LOCKS_DIR = path.join(CRON_STATE_DIR, "cron", "locks");

/* ------------------- Outreach state ------------------- */
const OUTREACH_STATE_DIR = path.join(CRON_STATE_DIR, "outreach");
const OUTREACH_LEDGER = path.join(OUTREACH_STATE_DIR, "outreach.jsonl");

/* -------------------------- Knobs -------------------------- */
const DISCOVER_HANDLE_OVERRIDE = String(
  process.env.LCX_OUTREACH_DISCOVER_HANDLE || ""
).trim(); // optional, defaults to our own handle

const ENABLED =
  String(process.env.LCX_OUTREACH_ENABLE || "0").toLowerCase() !== "0";
const LOOKBACK_HOURS = Number(process.env.LCX_OUTREACH_LOOKBACK_HOURS || "24");
const MAX_PER_DAY = Number(process.env.LCX_OUTREACH_MAX_PER_DAY || "5");
const POSTS_SCAN_LIMIT = Number(process.env.LCX_OUTREACH_POSTS_SCAN_LIMIT || "200");
const DRY_RUN =
  String(process.env.LCX_OUTREACH_DRY_RUN || "").toLowerCase() === "1";
const DEBUG =
  String(process.env.LCX_OUTREACH_DEBUG || "").toLowerCase() === "1";

/* ------------------------- Helpers ------------------------- */
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fileExists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function truncate(s, maxChars) {
  const t = String(s ?? "");
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…";
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadJsonFile(p, fallback) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = safeJsonParse(raw);
    return j && typeof j === "object" ? j : fallback;
  } catch {
    return fallback;
  }
}

function saveJsonFile(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function unwrapList(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && Array.isArray(json.posts)) return json.posts;
  if (json && Array.isArray(json.comments)) return json.comments;
  return [];
}

function getId(obj) {
  return obj?.id ?? obj?._id ?? obj?.postId ?? obj?.commentId ?? null;
}

function getText(obj) {
  return obj?.content ?? obj?.text ?? obj?.body ?? obj?.message ?? "";
}

function getAuthorId(obj) {
  return obj?.author?.id ?? obj?.authorId ?? obj?.user?.id ?? null;
}

function getAuthorHandle(obj) {
  return (
    obj?.author?.handle ??
    obj?.author?.username ??
    obj?.user?.handle ??
    obj?.user?.username ??
    obj?.author?.name ??
    null
  );
}

function getCreatedAtMs(obj) {
  const v =
    obj?.createdAt ??
    obj?.created_at ??
    obj?.created ??
    obj?.ts ??
    obj?.timestamp ??
    null;
  if (!v) return null;
  const n = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function suspiciousReason(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const s = t.toLowerCase();

  if (/\bhttps?:\/\/|www\./i.test(t)) return "url";
  if (/\b[a-z0-9-]+\.(com|net|org|io|ai|cloud|app|dev|xyz|gg|me|info)\b/i.test(t))
    return "domain";
  if (/\b(curl|wget|powershell|invoke-webrequest|iwr)\b/i.test(t)) return "shell_cmd";
  if (/\b(pip\s+install|npm\s+(i|install)|apt(-get)?\s+install|brew\s+install)\b/i.test(t))
    return "install_cmd";
  if (/\|\s*(jq|sh|bash|zsh)\b/i.test(t)) return "pipe_exec";
  if (s.includes("mcp") && (s.includes("endpoint") || s.includes("server"))) return "mcp_spam";
  if (s.includes("api/v1/discover") || s.includes("free apis")) return "api_spam";

  return null;
}

function openExclusiveLock(lockPath) {
  return fs.openSync(lockPath, "wx");
}

async function moltbookGetJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}` },
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (!res.ok) {
    throw new Error(`Moltbook error: ${res.status} ${res.statusText} ${text}`);
  }
  return json ?? text;
}

async function moltbookDiscoverSimilarAgents(handle) {
  const json = await moltbookGetJson(
    `/agents/${encodeURIComponent(handle)}/discover`
  );
  const similar = Array.isArray(json?.similarAgents) ? json.similarAgents : [];
  return similar
    .map((a) => ({
      id: String(a?.id || "").trim(),
      name: String(a?.name || "").trim(), // usually the profile handle
      karma: typeof a?.karma === "number" ? a.karma : 0,
      followerCount: typeof a?.follower_count === "number" ? a.follower_count : 0,
    }))
    .filter((a) => a.name || a.id);
}

function pickMostRecentBestOfPost(discoverJson) {
  const last30 =
    Array.isArray(discoverJson?.bestOf?.last30Days) ? discoverJson.bestOf.last30Days : [];
  const allTime =
    Array.isArray(discoverJson?.bestOf?.allTime) ? discoverJson.bestOf.allTime : [];
  const candidates = [...last30, ...allTime]
    .map((p) => ({
      id: String(p?.id || "").trim(),
      title: String(p?.title || "").trim(),
      createdAtMs: Number.isFinite(Date.parse(p?.created_at))
        ? Date.parse(p.created_at)
        : 0,
    }))
    .filter((p) => p.id);

  candidates.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return candidates[0] || null;
}

async function moltbookGetPost(postId) {
  const json = await moltbookGetJson(`/posts/${encodeURIComponent(postId)}`);
  const p = json?.post ?? json?.data?.post ?? json;
  return {
    raw: p,
    id: String(getId(p) || postId),
    title: p?.title ?? "",
    content: getText(p),
    createdAtMs: getCreatedAtMs(p) ?? 0,
    authorId: getAuthorId(p),
    authorHandle: getAuthorHandle(p),
  };
}

async function moltbookPostJson(pathname, body) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MOLTBOOK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (!res.ok) {
    throw new Error(`Moltbook error: ${res.status} ${res.statusText} ${text}`);
  }
  return json ?? text;
}

function extractPostedCommentId(postResp) {
  if (!postResp) return null;
  return postResp?.id ?? postResp?.comment?.id ?? postResp?.data?.id ?? null;
}

function appendLedger(entry) {
  ensureDir(OUTREACH_STATE_DIR);
  fs.appendFileSync(OUTREACH_LEDGER, JSON.stringify(entry) + "\n", "utf8");
}

function loadLedgerState() {
  const repliedPostIds = new Set();
  let todayCount = 0;

  if (!fileExists(OUTREACH_LEDGER)) return { repliedPostIds, todayCount };

  const now = new Date();
  const todayStartUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const raw = fs.readFileSync(OUTREACH_LEDGER, "utf8");
  const lines = raw.split("\n");
  const len = lines.length;
  const idStart = Math.max(0, len - 5000);
  for (let i = 0; i < len; i++) {
    const line = lines[i];
    if (!line) continue;
    const j = safeJsonParse(line);
    if (!j) continue;
    if (i >= idStart && j.postId) repliedPostIds.add(String(j.postId));
    const ts = typeof j.ts === "number" ? j.ts : null;
    if (ts && ts >= todayStartUtc && j.action === "outreach" && j.dryRun !== true) {
      todayCount += 1;
    }
  }
  return { repliedPostIds, todayCount };
}

async function openaiGenerateOutreachComment({ postTitle, postContent, who }) {
  const system = [
    "You are LibertyClaws, the official LCX representative on Moltbook.",
    "Goal: leave a short, genuine engagement comment on another agent's post to increase reach.",
    "Voice: first-person, professional, compliance-first.",
    "",
    "Hard boundaries (must follow):",
    "- No price predictions.",
    "- No financial advice.",
    "- No disparaging competitors.",
    "- No unverified claims.",
    '- Never say \"TVTG licenses\" (say \"TVTG registrations\" or \"TVTG regulator approvals\").',
    "- Avoid hype and promotional language.",
    "",
    "Output rules (must follow):",
    "- Write ONE comment, 1 short paragraph.",
    "- <= 320 characters.",
    "- If mention is provided (like \"@alice\"), start with it.",
    "- Do NOT include links, commands, or calls to click external sites.",
    "- Prefer: ask a thoughtful question or add a small compliance/safety clarification.",
  ].join("\n");

  const user = [
    `Post title: ${postTitle || "(unknown)"}`,
    `Post content (excerpt): ${truncate(postContent || "", 650)}`,
    "",
    `Author: ${who || "(unknown)"}`,
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 140,
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
  return truncate(content, 320);
}

async function main() {
  if (!ENABLED) {
    console.log("Outreach disabled. Set LCX_OUTREACH_ENABLE=1 to enable.");
    return;
  }

  ensureDir(OUTREACH_STATE_DIR);

  const { repliedPostIds, todayCount } = loadLedgerState();
  const remainingToday = Math.max(0, MAX_PER_DAY - todayCount);
  if (remainingToday <= 0) {
    console.log(`Daily cap reached. today=${todayCount} maxPerDay=${MAX_PER_DAY}`);
    return;
  }

  const me = await moltbookGetJson("/agents/me");
  const myId = getId(me) ?? me?.agent?.id ?? null;
  const myHandle = getAuthorHandle(me) ?? me?.handle ?? me?.username ?? null;

  const lookbackMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  // Discover targets from Moltbook.
  const discoverHandle = DISCOVER_HANDLE_OVERRIDE || myHandle;
  if (!discoverHandle) {
    console.log(
      "Cannot discover similar agents (missing handle). Set LCX_OUTREACH_DISCOVER_HANDLE."
    );
    return;
  }
  const discovered = await moltbookDiscoverSimilarAgents(discoverHandle);
  const targets = discovered
    .map((a) => ({ id: a.id || "", handle: a.name || "" }))
    .filter((t) => t.id || t.handle)
    .filter((t) =>
      myHandle && t.handle
        ? t.handle.toLowerCase() !== String(myHandle).toLowerCase()
        : true
    );

  if (targets.length === 0) {
    console.log("No similar agents found from discover endpoint.");
    return;
  }

  // Use each agent's /discover bestOf posts (more reliable than guessing feed shape).

  let commentsMade = 0;
  let scannedAgents = 0;
  let skippedNoPost = 0;
  let skippedAlready = 0;
  let skippedOld = 0;
  let skippedSpam = 0;
  let skippedDailyCap = 0;
  let skippedLedger = 0;

  for (const target of targets) {
    const handle = String(target.handle || "").trim();
    const targetId = String(target.id || "").trim();
    scannedAgents += 1;
    if (commentsMade >= remainingToday) {
      skippedDailyCap += 1;
      continue;
    }

    if (!handle) {
      skippedNoPost += 1;
      continue;
    }

    const agentDiscover = await moltbookGetJson(
      `/agents/${encodeURIComponent(handle)}/discover`
    );
    const picked = pickMostRecentBestOfPost(agentDiscover);
    if (!picked) {
      skippedNoPost += 1;
      continue;
    }
    if (picked.createdAtMs && picked.createdAtMs < lookbackMs) {
      skippedOld += 1;
      continue;
    }
    if (repliedPostIds.has(String(picked.id))) {
      skippedLedger += 1;
      continue;
    }

    const post = await moltbookGetPost(picked.id);

    // Safety: ensure we don't accidentally comment on ourselves.
    if (myId && post.authorId && String(post.authorId) === String(myId)) continue;
    if (
      myHandle &&
      post.authorHandle &&
      String(post.authorHandle).toLowerCase() === String(myHandle).toLowerCase()
    ) {
      continue;
    }

    // If both IDs exist, enforce match to avoid mis-targeting.
    if (targetId && post.authorId && String(post.authorId) !== String(targetId)) {
      skippedNoPost += 1;
      continue;
    }

    if (suspiciousReason(post.title) || suspiciousReason(post.content)) {
      skippedSpam += 1;
      repliedPostIds.add(String(post.id));
      continue;
    }

    // Check comments to ensure we haven't already commented (server truth).
    const commentsJson = await moltbookGetJson(`/posts/${encodeURIComponent(post.id)}/comments`);
    const comments = unwrapList(commentsJson);
    const alreadyCommented = comments.some((c) => {
      const authorId = getAuthorId(c);
      const authorHandle = getAuthorHandle(c);
      if (myId && authorId && String(authorId) === String(myId)) return true;
      if (
        myHandle &&
        authorHandle &&
        String(authorHandle).toLowerCase() === String(myHandle).toLowerCase()
      ) {
        return true;
      }
      return false;
    });
    if (alreadyCommented) {
      repliedPostIds.add(String(post.id));
      skippedAlready += 1;
      continue;
    }

    const mention = post.authorHandle ? `@${post.authorHandle}` : `@${handle}`;
    const commentRaw = await openaiGenerateOutreachComment({
      postTitle: post.title,
      postContent: post.content,
      who: mention,
    });
    const comment = mention
      ? truncate(
          commentRaw.startsWith(mention) ? commentRaw : `${mention} ${commentRaw}`,
          320
        )
      : commentRaw;

    let postedCommentId = null;
    if (DRY_RUN) {
      console.log(`[dry-run] Would outreach ${handle} on post=${post.id}: ${comment}`);
    } else {
      const resp = await moltbookPostJson(`/posts/${encodeURIComponent(post.id)}/comments`, {
        content: comment,
        text: comment,
      });
      postedCommentId = extractPostedCommentId(resp);
    }

    appendLedger({
      ts: Date.now(),
      jobId: CRON_JOB_ID,
      action: "outreach",
      targetHandle: handle || post.authorHandle || null,
      targetId: targetId || null,
      postId: String(post.id),
      postedCommentId: postedCommentId ? String(postedCommentId) : null,
      comment: comment,
      dryRun: DRY_RUN,
    });

    repliedPostIds.add(String(post.id));
    commentsMade += 1;
    console.log(
      `Outreach posted. target=${handle || post.authorHandle || "?"} post=${post.id}`
    );
    await sleep(800);
  }

  console.log(
    `Done. outreach=${commentsMade} scannedAgents=${scannedAgents} targets=${targets.length} todayTotal=${todayCount + commentsMade}/${MAX_PER_DAY} skipped(noPost=${skippedNoPost} old=${skippedOld} already=${skippedAlready} ledger=${skippedLedger} spam=${skippedSpam} dailyCap=${skippedDailyCap})`
  );
  if (commentsMade === 0 && skippedOld > 0) {
    console.log(
      `Hint: ${skippedOld} target(s) have posts, but older than lookback (${LOOKBACK_HOURS}h). Increase LCX_OUTREACH_LOOKBACK_HOURS (e.g. 168 for 7d, 720 for 30d).`
    );
  }
}

async function runWithCronGuards() {
  const enableCronState = fileExists(CRON_STATE_DIR);
  let lockFd = null;
  const lockPath = path.join(CRON_LOCKS_DIR, `${CRON_JOB_ID}.lock`);
  let exitCode = 0;

  try {
    if (enableCronState) {
      ensureDir(CRON_LOCKS_DIR);
      lockFd = openExclusiveLock(lockPath);
      // Best-effort: record lock metadata.
      try {
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }) + "\n");
      } catch {}
    }

    await main();
  } catch (err) {
    console.error(err?.stack || String(err));
    exitCode = 1;
  } finally {
    if (lockFd) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  process.exitCode = exitCode;
}

runWithCronGuards();

