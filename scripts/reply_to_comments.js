#!/usr/bin/env node
/**
 * reply_to_comments.js
 * - Fetch recent LibertyClaws posts from Moltbook
 * - Find new comments (not yet replied to)
 * - Generate short, compliance-safe replies using OpenAI
 * - Post replies back to Moltbook
 * - Persist a JSONL ledger under /app/state/comments/replies.jsonl to dedupe
 */

import fs from "node:fs";
import path from "node:path";

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
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

/* ------------------- Host-cron safeguards ------------------- */
const CRON_JOB_ID =
  process.env.LCX_CRON_JOB_ID ||
  process.env.CRON_JOB_ID ||
  "liberty-claws-reply-to-comments";
const CRON_STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/app/state";
const CRON_LOCKS_DIR = path.join(CRON_STATE_DIR, "cron", "locks");

/* ------------------- Comment reply state ------------------- */
const COMMENTS_STATE_DIR = path.join(CRON_STATE_DIR, "comments");
const REPLIES_LEDGER = path.join(COMMENTS_STATE_DIR, "replies.jsonl");
const POST_STATE_PATH = path.join(COMMENTS_STATE_DIR, "post_state.json");

/* -------------------------- Knobs -------------------------- */
const LOOKBACK_HOURS = Number(process.env.LCX_REPLY_LOOKBACK_HOURS || "24");
const MAX_POSTS = Number(process.env.LCX_REPLY_MAX_POSTS || "10");
// Reply to at most N newest *new* comments across the selected posts.
const MAX_REPLIES_PER_RUN = Number(process.env.LCX_REPLY_MAX_PER_RUN || "2");
const MAX_REPLIES_PER_DAY = Number(process.env.LCX_REPLY_MAX_PER_DAY || "10");
const DRY_RUN = String(process.env.LCX_REPLY_DRY_RUN || "").toLowerCase() === "1";
const STALE_LOCK_MINUTES = Number(process.env.LCX_REPLY_LOCK_STALE_MINUTES || "15");
// Fetch the last N recent posts to scan.
const POSTS_PER_RUN = Number(process.env.LCX_REPLY_POSTS_PER_RUN || "3");
// Optional behaviors (off by default).
const ENABLE_SEED =
  String(process.env.LCX_REPLY_ENABLE_SEED || "0").toLowerCase() !== "0";
const SEED_MAX_PER_RUN = Number(process.env.LCX_REPLY_SEED_MAX_PER_RUN || "1");
const ENABLE_POST_CACHE =
  String(process.env.LCX_REPLY_ENABLE_POST_CACHE || "0").toLowerCase() !== "0";
const QUIET_POST_RECHECK_MINUTES = Number(
  process.env.LCX_REPLY_QUIET_POST_RECHECK_MINUTES || "10"
);

const BASE_URL = "https://www.moltbook.com/api/v1";
const POSTS_LOG_DIR = process.env.LCX_POSTS_LOG_DIR || "/app/logs/posts";

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

function summarizeError(err) {
  const raw = err?.stack || err?.message || String(err);
  return truncate(raw.replace(/\s+/g, " ").trim(), 900);
}

function isMoltbookRateLimit(err) {
  const msg = String(err?.message || err || "");
  return msg.includes("Moltbook error: 429") || msg.includes("retry_after");
}

function suspiciousReason(commentText) {
  const t = String(commentText || "").trim();
  if (!t) return null;
  const s = t.toLowerCase();

  // Links / promo
  if (/\bhttps?:\/\/|www\./i.test(t)) return "url";
  if (/\b[a-z0-9-]+\.(com|net|org|io|ai|cloud|app|dev|xyz|gg|me|info)\b/i.test(t))
    return "domain";

  // Command-ish / prompt-injection bait
  if (/\b(curl|wget|powershell|invoke-webrequest|iwr)\b/i.test(t)) return "shell_cmd";
  if (/\b(pip\s+install|npm\s+(i|install)|apt(-get)?\s+install|brew\s+install)\b/i.test(t))
    return "install_cmd";
  if (/\|\s*(jq|sh|bash|zsh)\b/i.test(t)) return "pipe_exec";

  // “Agent / MCP endpoint” spam patterns
  if (s.includes("mcp") && (s.includes("endpoint") || s.includes("server"))) return "mcp_spam";
  if (s.includes("api/v1/discover") || s.includes("free apis")) return "api_spam";

  return null;
}

function openExclusiveLock(lockPath) {
  // Atomic lock: succeeds only if the file does not already exist.
  return fs.openSync(lockPath, "wx");
}

function tryReadLockInfo(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const j = safeJsonParse(raw);
    if (j && typeof j === "object") return j;
    return { raw: truncate(raw, 200) };
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath, info) {
  const lockTs = typeof info?.ts === "number" ? info.ts : null;
  if (lockTs) return Date.now() - lockTs;
  // Back-compat: older locks were empty / non-JSON; fall back to file mtime.
  try {
    const st = fs.statSync(lockPath);
    const m = typeof st.mtimeMs === "number" ? st.mtimeMs : Date.parse(String(st.mtime));
    if (!Number.isFinite(m)) return null;
    return Date.now() - m;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.replace(/\0/g, " ").trim();
  } catch {
    return null;
  }
}

function isReplyScriptPid(pid) {
  const cmd = readProcCmdline(pid);
  if (!cmd) return false;
  return cmd.includes("reply_to_comments.js");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  // Accept either an array or a common envelope shape.
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.data)) return json.data;
  if (json && Array.isArray(json.items)) return json.items;
  if (json && Array.isArray(json.results)) return json.results;
  // Moltbook commonly wraps lists like: { success: true, posts: [...] }
  if (json && Array.isArray(json.posts)) return json.posts;
  if (json && Array.isArray(json.comments)) return json.comments;
  return [];
}

function listJsonlFilesNewestFirst(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => path.join(dir, e.name))
      .map((p) => {
        try {
          const st = fs.statSync(p);
          return { p, mtimeMs: st.mtimeMs || 0 };
        } catch {
          return { p, mtimeMs: 0 };
        }
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((x) => x.p);
    return files;
  } catch {
    return [];
  }
}

function extractPostIdFromLogEntry(entry) {
  // post_moltbook.js stores: { moltbook: { status, body } }
  const b = entry?.moltbook?.body ?? null;
  return (
    b?.id ??
    b?.post?.id ??
    b?.data?.id ??
    entry?.postId ??
    entry?.id ??
    null
  );
}

function loadRecentPostsFromLocalLogs({ lookbackMs, maxPosts }) {
  // Best-effort: uses our own posting logs so we don't depend on /posts listing.
  const files = listJsonlFilesNewestFirst(POSTS_LOG_DIR);
  const out = [];
  const seen = new Set();

  for (const f of files) {
    if (out.length >= maxPosts) break;
    let raw = "";
    try {
      raw = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter(Boolean);
    // Read from the end (newest first).
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= maxPosts) break;
      const j = safeJsonParse(lines[i]);
      if (!j) continue;
      const tsMs = Number.isFinite(Date.parse(j?.ts)) ? Date.parse(j.ts) : null;
      if (tsMs && tsMs < lookbackMs) continue;
      const postId = extractPostIdFromLogEntry(j);
      if (!postId) continue;
      if (seen.has(String(postId))) continue;
      seen.add(String(postId));

      out.push({
        id: String(postId),
        // We may not have a title from logs; keep a helpful fallback.
        title: j?.pillar ? `${MOLTBOOK_TITLE_PREFIX}${j.pillar}` : "",
        content: j?.content ?? "",
        createdAtMs: tsMs,
      });
    }
  }

  return out;
}

function getId(obj) {
  return obj?.id ?? obj?._id ?? obj?.commentId ?? obj?.postId ?? null;
}

function getText(obj) {
  return obj?.content ?? obj?.text ?? obj?.body ?? obj?.message ?? "";
}

function getAuthorId(obj) {
  return (
    obj?.author?.id ??
    obj?.authorId ??
    obj?.user?.id ??
    obj?.agent?.id ??
    null
  );
}

function getAuthorHandle(obj) {
  return (
    obj?.author?.handle ??
    obj?.author?.username ??
    obj?.user?.handle ??
    obj?.user?.username ??
    obj?.agent?.handle ??
    obj?.agent?.username ??
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

async function moltbookGetJson(pathname) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${MOLTBOOK_API_KEY}` },
  });
  const text = await res.text();
  const json = safeJsonParse(text);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Moltbook unauthorized (${res.status}) on GET ${pathname}. Check MOLTBOOK_API_KEY. Body: ${truncate(
        text,
        300
      )}`
    );
  }
  if (!res.ok) {
    throw new Error(`Moltbook error: ${res.status} ${res.statusText} ${text}`);
  }
  return json ?? text;
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
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Moltbook unauthorized (${res.status}) on POST ${pathname}. Check MOLTBOOK_API_KEY. Body: ${truncate(
        text,
        300
      )}`
    );
  }
  if (!res.ok) {
    throw new Error(`Moltbook error: ${res.status} ${res.statusText} ${text}`);
  }
  return json ?? text;
}

function extractPostedCommentId(postResp) {
  if (!postResp) return null;
  return (
    postResp?.id ??
    postResp?.comment?.id ??
    postResp?.data?.id ??
    postResp?.comment_id ??
    null
  );
}

/**
 * Single-pass ledger loader: reads replies.jsonl once and extracts all needed data.
 * Returns { repliedIds: Set, postedIds: Set, repliesToday: number }
 */
function loadLedgerState() {
  const repliedIds = new Set();
  const postedIds = new Set();
  let repliesToday = 0;

  if (!fileExists(REPLIES_LEDGER)) {
    return { repliedIds, postedIds, repliesToday };
  }

  const now = new Date();
  const todayStartUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const raw = fs.readFileSync(REPLIES_LEDGER, "utf8");
  const lines = raw.split("\n");
  // Process last 5000 lines for IDs, all recent for today count.
  const len = lines.length;
  const idStart = Math.max(0, len - 5000);

  for (let i = 0; i < len; i++) {
    const line = lines[i];
    if (!line) continue;
    const j = safeJsonParse(line);
    if (!j) continue;

    // Collect IDs from recent entries only.
    if (i >= idStart) {
      if (j.commentId) repliedIds.add(String(j.commentId));
      if (j.postedCommentId) postedIds.add(String(j.postedCommentId));
    }

    // Count today's non-dry-run replies.
    const ts = typeof j.ts === "number" ? j.ts : null;
    if (ts && ts >= todayStartUtc && j.reply && j.dryRun !== true) {
      repliesToday++;
    }
  }

  return { repliedIds, postedIds, repliesToday };
}

function appendReplyLedger(entry) {
  ensureDir(COMMENTS_STATE_DIR);
  fs.appendFileSync(REPLIES_LEDGER, JSON.stringify(entry) + "\n", "utf8");
}

async function openaiGenerateReply({ postTitle, postContent, commentText, who }) {
  const system = [
    "You are LibertyClaws, the official LCX representative on Moltbook.",
    "Voice: first-person, professional but approachable. Keep it concise.",
    "",
    "Hard boundaries (must follow):",
    "- No price predictions.",
    "- No financial advice.",
    "- No disparaging competitors (only factual, respectful comparisons).",
    "- No unverified claims.",
    '- Never say "TVTG licenses" (say "TVTG registrations" or "TVTG regulator approvals").',
    "- Avoid hype, speculation, and promotional language.",
    "",
    "Reply rules (must follow):",
    "- Write a single reply comment (1 short paragraph).",
    "- <= 420 characters.",
    '- If a mention is provided (like "@alice"), start your reply with it.',
    "- If the user asks for prices, trading signals, or investment advice: politely refuse and pivot to compliance/education.",
    "- If asked something uncertain: say what you can verify and offer a safe next step.",
  ].join("\n");

  const user = [
    `Post title: ${postTitle || "(unknown)"}`,
    `Post content (excerpt): ${truncate(postContent || "", 650)}`,
    "",
    `Comment author: ${who || "(unknown)"}`,
    "Comment:",
    commentText,
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
      max_tokens: 160,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `OpenAI unauthorized (${res.status}). Check OPENAI_API_KEY. Body: ${truncate(
          t,
          300
        )}`
      );
    }
    throw new Error(`OpenAI error: ${res.status} ${res.statusText} ${t}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("OpenAI returned empty content.");
  return truncate(content, 420);
}

function seedCommentText({ postTitle }) {
  const t = String(postTitle || "").trim();
  const subject = t.startsWith(MOLTBOOK_TITLE_PREFIX)
    ? t.slice(MOLTBOOK_TITLE_PREFIX.length).trim()
    : t;
  const topic = subject ? `on ${subject}` : "here";
  return truncate(
    `If you have questions ${topic}—or want sources on LCX’s compliance-first approach—I’m happy to clarify. What would you like to dig into?`,
    420
  );
}

async function main() {
  ensureDir(COMMENTS_STATE_DIR);

  // Single-pass ledger read (was 3 separate reads before).
  const { repliedIds: replied, postedIds: postedCommentIds, repliesToday } = loadLedgerState();
  const postState = (ENABLE_POST_CACHE || ENABLE_SEED)
    ? loadJsonFile(POST_STATE_PATH, {})
    : {};
  const lookbackMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;

  const remainingToday = Math.max(0, MAX_REPLIES_PER_DAY - repliesToday);
  if (remainingToday <= 0) {
    console.log(
      `Daily cap reached. repliesToday=${repliesToday} maxPerDay=${MAX_REPLIES_PER_DAY}`
    );
    return;
  }

  const me = await moltbookGetJson("/agents/me");
  const myId = getId(me) ?? me?.agent?.id ?? null;
  const myHandle = getAuthorHandle(me) ?? me?.handle ?? me?.username ?? null;

  // Pull recent posts and filter to ours (title prefix + lookback).
  const postsJson = await moltbookGetJson(`/posts?limit=${MAX_POSTS}`);
  const posts = unwrapList(postsJson);

  let myPosts = posts
    .map((p) => ({
      raw: p,
      id: getId(p),
      title: p?.title ?? "",
      content: getText(p),
      createdAtMs: getCreatedAtMs(p),
      authorId: getAuthorId(p),
      authorHandle: getAuthorHandle(p),
    }))
    .filter((p) => p.id)
    .filter((p) =>
      String(p.title || "").startsWith(String(MOLTBOOK_TITLE_PREFIX || ""))
    )
    .filter((p) => (p.createdAtMs ? p.createdAtMs >= lookbackMs : true))
    .filter((p) => {
      if (myId && p.authorId) return String(p.authorId) === String(myId);
      if (myHandle && p.authorHandle)
        return String(p.authorHandle).toLowerCase() ===
          String(myHandle).toLowerCase();
      // Fallback: if we can't identify author, keep prefix-filtered posts.
      return true;
    })
    .slice(0, MAX_POSTS);

  // Fallback: if our posts aren't present in the "recent posts" list, use our local posting logs.
  if (myPosts.length === 0) {
    const fromLogs = loadRecentPostsFromLocalLogs({
      lookbackMs,
      maxPosts: MAX_POSTS,
    });
    if (fromLogs.length > 0) {
      myPosts = fromLogs.map((p) => ({
        raw: null,
        id: p.id,
        title: p.title,
        content: p.content,
        createdAtMs: p.createdAtMs,
        authorId: myId,
        authorHandle: myHandle,
      }));
    }
  }

  // Only process the newest N posts per run.
  myPosts = myPosts
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))
    .slice(0, Math.max(1, POSTS_PER_RUN));

  const maxThisRun = Math.min(MAX_REPLIES_PER_RUN, remainingToday);

  const candidates = [];
  let seedsMade = 0;
  let skippedSuspicious = 0;

  for (const post of myPosts) {
    const st = postState[String(post.id)] || {};
    const nextCheckAtMs = typeof st.nextCheckAtMs === "number" ? st.nextCheckAtMs : 0;
    if (ENABLE_POST_CACHE && nextCheckAtMs && Date.now() < nextCheckAtMs) continue;

    const commentsJson = await moltbookGetJson(
      `/posts/${encodeURIComponent(post.id)}/comments`
    );

    // Sort comments newest-first in a single pass.
    const comments = unwrapList(commentsJson).sort(
      (a, b) => (getCreatedAtMs(b) ?? 0) - (getCreatedAtMs(a) ?? 0)
    );

    // Single pass: collect candidates and count external comments.
    let externalCount = 0;
    for (const c of comments) {
      const commentId = getId(c);
      const authorId = getAuthorId(c);
      const authorHandle = getAuthorHandle(c);
      const commentText = String(getText(c) || "").trim();

      // Check if this is an external comment (not ours).
      const isOurs =
        (commentId && postedCommentIds.has(String(commentId))) ||
        (myId && authorId && String(authorId) === String(myId)) ||
        (myHandle && authorHandle &&
          String(authorHandle).toLowerCase() === String(myHandle).toLowerCase());

      if (!isOurs) externalCount++;

      // Skip if already replied, no content, or is our comment.
      if (!commentId || !commentText) continue;
      if (replied.has(String(commentId))) continue;
      if (isOurs) continue;

      const sus = suspiciousReason(commentText);
      if (sus) {
        skippedSuspicious += 1;
        continue;
      }

      candidates.push({
        postId: String(post.id),
        postTitle: post.title,
        postContent: post.content,
        commentId: String(commentId),
        commentText,
        authorHandle,
        createdAtMs: getCreatedAtMs(c) ?? 0,
      });
    }

    // Seed once per post if there are no external comments.
    const alreadySeeded = st.seeded === true;
    if (
      ENABLE_SEED &&
      !DRY_RUN &&
      !alreadySeeded &&
      seedsMade < SEED_MAX_PER_RUN &&
      externalCount === 0 &&
      (remainingToday - seedsMade) > 0
    ) {
      const seed = seedCommentText({ postTitle: post.title });
      const resp = await moltbookPostJson(`/posts/${encodeURIComponent(post.id)}/comments`, {
        content: seed,
        text: seed,
      });
      const postedCommentId = extractPostedCommentId(resp);
      if (postedCommentId) postedCommentIds.add(String(postedCommentId));

      appendReplyLedger({
        ts: Date.now(),
        jobId: CRON_JOB_ID,
        action: "seed",
        postId: String(post.id),
        commentId: null,
        postedCommentId: postedCommentId ? String(postedCommentId) : null,
        commentAuthor: null,
        reply: seed,
        dryRun: false,
      });

      seedsMade += 1;
      postState[String(post.id)] = { ...st, seeded: true };
    }

    // Cache quiet posts so we don't hit the API every run.
    if (ENABLE_POST_CACHE) {
      postState[String(post.id)] = {
        ...(postState[String(post.id)] || st),
        lastCheckedAtMs: Date.now(),
        nextCheckAtMs:
          externalCount === 0
            ? Date.now() + Math.max(1, QUIET_POST_RECHECK_MINUTES) * 60 * 1000
            : 0,
      };
    }
  }

  candidates.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  const selected = candidates.slice(0, Math.max(0, maxThisRun));

  let repliedCount = 0;
  for (const x of selected) {
    const mention = x.authorHandle ? `@${x.authorHandle}` : null;
    const replyRaw = await openaiGenerateReply({
      postTitle: x.postTitle,
      postContent: x.postContent,
      commentText: x.commentText,
      who: mention,
    });

    // Force mention prefix when we have a handle.
    const reply = mention
      ? truncate(
          replyRaw.startsWith(mention) ? replyRaw : `${mention} ${replyRaw}`,
          420
        )
      : replyRaw;

    let postedCommentId = null;
    if (DRY_RUN) {
      console.log(
        `[dry-run] Would reply post=${x.postId} comment=${x.commentId}: ${reply}`
      );
    } else {
      const resp = await moltbookPostJson(`/posts/${encodeURIComponent(x.postId)}/comments`, {
        content: reply,
        text: reply,
      });
      postedCommentId = extractPostedCommentId(resp);
    }

    appendReplyLedger({
      ts: Date.now(),
      jobId: CRON_JOB_ID,
      action: "reply",
      postId: x.postId,
      commentId: x.commentId,
      postedCommentId: postedCommentId ? String(postedCommentId) : null,
      commentAuthor: x.authorHandle ?? null,
      reply,
      dryRun: DRY_RUN,
    });

    replied.add(String(x.commentId));
    if (postedCommentId) postedCommentIds.add(String(postedCommentId));
    repliedCount += 1;
    console.log(`Replied. post=${x.postId} comment=${x.commentId}`);
    // Brief pause to avoid rate limits (only if more replies pending).
    if (repliedCount < selected.length) await sleep(800);
  }

  if (ENABLE_POST_CACHE || ENABLE_SEED) {
    saveJsonFile(POST_STATE_PATH, postState);
  }

  console.log(
    `Done. replies=${repliedCount} maxThisRun=${maxThisRun} todayTotal=${repliesToday + repliedCount}/${MAX_REPLIES_PER_DAY} posts=${myPosts.length} skippedSuspicious=${skippedSuspicious}`
  );
}

async function runWithCronGuards() {
  const enableCronState = fileExists(CRON_STATE_DIR);
  let lockFd = null;
  const lockPath = path.join(CRON_LOCKS_DIR, `${CRON_JOB_ID}.lock`);
  let exitCode = 0;

  try {
    if (enableCronState) {
      ensureDir(CRON_LOCKS_DIR);
      try {
        lockFd = openExclusiveLock(lockPath);
      } catch (e) {
        // Another run is in progress (or a stale lock exists).
        // Treat as a soft outcome so cron doesn't report "error".
        if (e && (e.code === "EEXIST" || String(e?.message || "").includes("EEXIST"))) {
          const info = tryReadLockInfo(lockPath);
          const lockPid = typeof info?.pid === "number" ? info.pid : null;
          const ageMs = lockAgeMs(lockPath, info);

          const staleAfterMs = Math.max(1, STALE_LOCK_MINUTES) * 60 * 1000;
          const pidAlive = lockPid ? isPidAlive(lockPid) : false;
          const pidLooksLikeUs = lockPid ? isReplyScriptPid(lockPid) : false;

          // Consider the lock stale if:
          // - it's older than STALE_LOCK_MINUTES, OR
          // - the PID is gone, OR
          // - the PID exists but doesn't look like our script (PID reuse / unrelated process).
          const isStale =
            (typeof ageMs === "number" && ageMs > staleAfterMs) ||
            (lockPid && !pidAlive) ||
            (lockPid && pidAlive && !pidLooksLikeUs) ||
            (!lockPid && typeof ageMs === "number" && ageMs > staleAfterMs);

          if (isStale) {
            try {
              fs.unlinkSync(lockPath);
              // Re-attempt lock acquisition once.
              lockFd = openExclusiveLock(lockPath);
            } catch (e2) {
              console.error(
                `Skipped: stale lock cleanup failed (${lockPath}). info=${JSON.stringify(
                  info ?? null
                )}`
              );
              exitCode = 0;
              return;
            }
          } else {
            console.error(
              `Skipped: lock exists (${lockPath}). pid=${lockPid ?? "?"} pidAlive=${
                lockPid ? String(pidAlive) : "?"
              } ageMs=${ageMs ?? "?"} staleAfterMs=${staleAfterMs}`
            );
            exitCode = 0;
            return;
          }
        }
        throw e;
      }

      // Record who holds the lock (helps stale-lock recovery).
      try {
        fs.writeFileSync(
          lockPath,
          JSON.stringify({ pid: process.pid, ts: Date.now(), jobId: CRON_JOB_ID }) + "\n",
          "utf8"
        );
      } catch {
        // Best-effort only; lock still works even if metadata write fails.
      }
    }

    await main();
  } catch (err) {
    const soft = isMoltbookRateLimit(err);
    const summary = soft ? `Skipped (rate limit): ${summarizeError(err)}` : summarizeError(err);
    console.error(summary);
    exitCode = soft ? 0 : 1;
  } finally {
    // Cleanup lock.
    if (lockFd) {
      try {
        fs.closeSync(lockFd);
      } catch {}
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }

  // Let the process exit naturally so `finally` always runs.
  process.exitCode = exitCode;
}

runWithCronGuards();

