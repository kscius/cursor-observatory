#!/usr/bin/env node
/**
 * Optional Cursor hook collector — writes normalized events for observatory.
 * Install in ~/.cursor/hooks.json on beforeSubmitPrompt, stop, sessionStart, sessionEnd.
 * Primary ingest still reads agent-audit.jsonl; this is a cleaner parallel stream.
 */
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || ".",
  ".cursor",
  "observatory",
  "events"
);
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

  const entry = {
    ts: payload.timestamp || payload.ts || new Date().toISOString(),
    hook_event_name: payload.hook_event_name || "unknown",
    conversation_id: payload.conversation_id || payload.session_id || null,
    generation_id: payload.generation_id || null,
    model: payload.model || null,
    input_tokens: payload.input_tokens ?? null,
    output_tokens: payload.output_tokens ?? null,
    cache_read_tokens: payload.cache_read_tokens ?? null,
    cache_write_tokens: payload.cache_write_tokens ?? null,
    workspace_roots: payload.workspace_roots || [],
    transcript_path: payload.transcript_path || null,
    tool_name: payload.tool_name || null,
    command: payload.command || null,
    duration_ms: payload.duration_ms ?? null,
    prompt: typeof payload.prompt === "string" ? payload.prompt.slice(0, 4000) : null,
    composer_mode: payload.composer_mode || null,
    cursor_version: payload.cursor_version || null,
  };

  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  process.stdout.write("{}\n");
}

main().catch(() => process.stdout.write("{}\n"));
