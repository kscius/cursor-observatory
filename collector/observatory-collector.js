#!/usr/bin/env node
/**
 * Optional Cursor hook collector — writes normalized events for observatory.
 * Install in ~/.cursor/hooks.json on beforeSubmitPrompt, stop, sessionStart,
 * sessionEnd, and optionally preToolUse / postToolUse / afterShellExecution
 * (needed for tool_count when not using agent-audit.jsonl).
 *
 * Output dir resolution (first match wins):
 *   1. OBSERVATORY_DATA_DIR env → <dir>/events
 *   2. dataDir from ~/.cursor/observatory/config.json (or %USERPROFILE%\.cursor\...)
 *   3. cursorHome from that config → <cursorHome>/observatory/events
 *   4. ~/.cursor/observatory/events
 *
 * Primary ingest still reads agent-audit.jsonl; this is a cleaner parallel stream.
 * If you enable hookEvents ingest, set auditLogs to false to avoid double-counting.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

function expandHome(p) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveLogDir() {
  if (process.env.OBSERVATORY_DATA_DIR) {
    return path.join(expandHome(process.env.OBSERVATORY_DATA_DIR), "events");
  }
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir() || ".";
  const configPath = path.join(home, ".cursor", "observatory", "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (raw && typeof raw.dataDir === "string" && raw.dataDir.trim()) {
        return path.join(expandHome(raw.dataDir), "events");
      }
      // Match loadConfig(): derive dataDir from cursorHome when dataDir is omitted.
      if (raw && typeof raw.cursorHome === "string" && raw.cursorHome.trim()) {
        return path.join(expandHome(raw.cursorHome), "observatory", "events");
      }
    }
  } catch {
    /* fall through to default */
  }
  return path.join(home, ".cursor", "observatory", "events");
}

/** First non-empty timestamp candidate (skips null/undefined/blank strings). */
function pickTs(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    if (typeof c === "string" && !c.trim()) continue;
    return c;
  }
  return null;
}

/** First non-blank string candidate (trimmed). Skips non-strings and whitespace-only. */
function pickNonBlankString(...candidates) {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const trimmed = c.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/** Normalize hook timestamps to ISO-8601 so ingest ordering stays consistent. */
function normalizeTs(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof ts === "string" && ts.trim()) {
    const trimmed = ts.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n)) {
        const ms = n < 1e12 ? n * 1000 : n;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
      }
    }
    // Naive "YYYY-MM-DD HH:MM[:SS]" (or T separator) without offset → UTC (match src/parse.mjs).
    let candidate = trimmed;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(candidate)) {
      candidate = candidate.replace(" ", "T");
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)) candidate += "Z";
    }
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return trimmed;
  }
  return new Date().toISOString();
}

const LOG_DIR = resolveLogDir();
const LOG_FILE = path.join(LOG_DIR, "hook-events.jsonl");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let payload;
  try {
    payload = JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    process.stdout.write("{}\n");
    return;
  }

  const eventName = pickNonBlankString(payload.hook_event_name, payload.event);
  if (!eventName) {
    process.stdout.write("{}\n");
    return;
  }

  const conversationId = pickNonBlankString(payload.conversation_id, payload.session_id);
  const transcriptPath = pickNonBlankString(
    payload.transcript_path,
    payload.agent_transcript_path
  );
  const prompt = pickNonBlankString(payload.prompt, payload.user_message);

  const entry = {
    // Blank `timestamp: ""` must fall through to `ts` (?? would keep "").
    ts: normalizeTs(pickTs(payload.timestamp, payload.ts)),
    hook_event_name: eventName,
    conversation_id: conversationId,
    generation_id: payload.generation_id || null,
    model: payload.model || null,
    input_tokens: payload.input_tokens ?? null,
    output_tokens: payload.output_tokens ?? null,
    cache_read_tokens: payload.cache_read_tokens ?? null,
    cache_write_tokens: payload.cache_write_tokens ?? null,
    workspace_roots: Array.isArray(payload.workspace_roots)
      ? payload.workspace_roots
      : typeof payload.workspace_roots === "string" && payload.workspace_roots.trim()
        ? [payload.workspace_roots.trim()]
        : [],
    transcript_path: transcriptPath,
    tool_name: payload.tool_name || null,
    command: payload.command || null,
    duration_ms: payload.duration_ms ?? null,
    prompt: prompt ? prompt.slice(0, 4000) : null,
    composer_mode: payload.composer_mode || null,
    cursor_version: payload.cursor_version || null,
    status: pickNonBlankString(payload.status, payload.final_status, payload.reason),
    subagent_type: payload.subagent_type || null,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  process.stdout.write("{}\n");
}

main().catch(() => process.stdout.write("{}\n"));
