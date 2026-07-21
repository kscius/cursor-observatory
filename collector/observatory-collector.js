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
 *   3. ~/.cursor/observatory/events
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
    }
  } catch {
    /* fall through to default */
  }
  return path.join(home, ".cursor", "observatory", "events");
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
    return ts;
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

  const eventName = payload.hook_event_name || payload.event;
  if (typeof eventName !== "string" || !eventName.trim()) {
    process.stdout.write("{}\n");
    return;
  }

  const entry = {
    ts: normalizeTs(payload.timestamp ?? payload.ts),
    hook_event_name: eventName.trim(),
    conversation_id: payload.conversation_id || payload.session_id || null,
    generation_id: payload.generation_id || null,
    model: payload.model || null,
    input_tokens: payload.input_tokens ?? null,
    output_tokens: payload.output_tokens ?? null,
    cache_read_tokens: payload.cache_read_tokens ?? null,
    cache_write_tokens: payload.cache_write_tokens ?? null,
    workspace_roots: Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [],
    transcript_path: payload.transcript_path || null,
    tool_name: payload.tool_name || null,
    command: payload.command || null,
    duration_ms: payload.duration_ms ?? null,
    prompt:
      typeof payload.prompt === "string"
        ? payload.prompt.slice(0, 4000)
        : typeof payload.user_message === "string"
          ? payload.user_message.slice(0, 4000)
          : null,
    composer_mode: payload.composer_mode || null,
    cursor_version: payload.cursor_version || null,
    status: payload.status || payload.final_status || payload.reason || null,
    subagent_type: payload.subagent_type || null,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  process.stdout.write("{}\n");
}

main().catch(() => process.stdout.write("{}\n"));
