import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ingest_checkpoints (
  source_path TEXT PRIMARY KEY,
  last_line INTEGER NOT NULL DEFAULT 0,
  last_size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  event_type TEXT NOT NULL,
  conversation_id TEXT,
  generation_id TEXT,
  model TEXT,
  project TEXT,
  workspace_roots TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  tool_name TEXT,
  command TEXT,
  duration_ms INTEGER,
  transcript_path TEXT,
  cursor_version TEXT,
  composer_mode TEXT,
  prompt_preview TEXT,
  subagent_type TEXT,
  status TEXT,
  source_file TEXT,
  source_line INTEGER,
  payload_json TEXT,
  UNIQUE(source_file, source_line)
);

CREATE TABLE IF NOT EXISTS sessions (
  conversation_id TEXT PRIMARY KEY,
  project TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  model_primary TEXT,
  composer_mode TEXT,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cache_read INTEGER DEFAULT 0,
  generation_count INTEGER DEFAULT 0,
  tool_count INTEGER DEFAULT 0,
  prompt_count INTEGER DEFAULT 0,
  subagent_count INTEGER DEFAULT 0,
  first_prompt_preview TEXT,
  detected_command TEXT,
  transcript_path TEXT,
  archetype TEXT,
  fluency_score REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  project TEXT,
  prompt_idx INTEGER NOT NULL,
  ts TEXT,
  preview TEXT NOT NULL,
  prompt_hash TEXT,
  detected_command TEXT,
  char_count INTEGER,
  source TEXT,
  UNIQUE(conversation_id, prompt_idx, source)
);

CREATE TABLE IF NOT EXISTS transcripts (
  path TEXT PRIMARY KEY,
  conversation_id TEXT,
  project TEXT,
  file_size INTEGER,
  mtime_ms INTEGER,
  line_count INTEGER,
  prompt_count INTEGER,
  tool_count INTEGER,
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS hourly_stats (
  hour_key TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  event_count INTEGER DEFAULT 0,
  generation_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  PRIMARY KEY (hour_key, project, model)
);

CREATE TABLE IF NOT EXISTS daily_stats (
  day_key TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  event_count INTEGER DEFAULT 0,
  generation_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  prompt_count INTEGER DEFAULT 0,
  PRIMARY KEY (day_key, project, model)
);

CREATE TABLE IF NOT EXISTS behavior_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  period_key TEXT NOT NULL,
  fluency_score REAL,
  archetype TEXT,
  briefing REAL,
  verification REAL,
  context_setting REAL,
  iteration REAL,
  toolcraft REAL,
  real_prompt_count INTEGER,
  session_count INTEGER,
  computed_at TEXT NOT NULL,
  UNIQUE(period, period_key)
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_prompts_conversation ON prompts(conversation_id);
CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(ts);
CREATE INDEX IF NOT EXISTS idx_events_conv_type ON events(conversation_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_type_tool ON events(event_type, tool_name);
`;

export function getTranscriptMtime(db, filePath) {
  const row = queryScalar(db, `SELECT mtime_ms FROM transcripts WHERE path = ?`, filePath);
  return row?.mtime_ms ?? null;
}

/** Returns stored mtime + size so ingest can detect same-mtime rewrites. */
export function getTranscriptMetadata(db, filePath) {
  return (
    queryScalar(db, `SELECT mtime_ms, file_size FROM transcripts WHERE path = ?`, filePath) ?? null
  );
}

export function deletePromptsForConversation(db, conversationId, source = "transcript") {
  db.prepare(`DELETE FROM prompts WHERE conversation_id = ? AND source = ?`).run(
    conversationId,
    source
  );
}

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // WAL + busy_timeout help when watch and a one-shot CLI share the same DB.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function getCheckpoint(db, sourcePath) {
  const row = db
    .prepare("SELECT last_line, last_size FROM ingest_checkpoints WHERE source_path = ?")
    .get(sourcePath);
  return row || { last_line: 0, last_size: 0 };
}

export function setCheckpoint(db, sourcePath, lastLine, lastSize) {
  db.prepare(
    `INSERT INTO ingest_checkpoints (source_path, last_line, last_size, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(source_path) DO UPDATE SET
       last_line = excluded.last_line,
       last_size = excluded.last_size,
       updated_at = excluded.updated_at`
  ).run(sourcePath, lastLine, lastSize);
}

export function insertEvent(db, ev) {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events (
      ts, event_type, conversation_id, generation_id, model, project,
      workspace_roots, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, tool_name, command, duration_ms, transcript_path,
      cursor_version, composer_mode, prompt_preview, subagent_type, status,
      source_file, source_line, payload_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      ev.ts,
      ev.eventType,
      ev.conversationId,
      ev.generationId,
      ev.model,
      ev.project,
      JSON.stringify(ev.workspaceRoots || []),
      ev.inputTokens,
      ev.outputTokens,
      ev.cacheReadTokens,
      ev.cacheWriteTokens,
      ev.toolName,
      ev.command,
      ev.durationMs,
      ev.transcriptPath,
      ev.cursorVersion,
      ev.composerMode,
      ev.promptPreview || null,
      ev.subagentType,
      ev.status,
      ev.sourceFile,
      ev.sourceLine,
      ev.payloadJson
    );
  return result.changes ?? 0;
}

export function upsertTranscript(db, row) {
  db.prepare(
    `INSERT INTO transcripts (
      path, conversation_id, project, file_size, mtime_ms, line_count,
      prompt_count, tool_count, ingested_at
    ) VALUES (?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(path) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      project = excluded.project,
      file_size = excluded.file_size,
      mtime_ms = excluded.mtime_ms,
      line_count = excluded.line_count,
      prompt_count = excluded.prompt_count,
      tool_count = excluded.tool_count,
      ingested_at = excluded.ingested_at`
  ).run(
    row.path,
    row.conversationId,
    row.project,
    row.fileSize,
    row.mtimeMs,
    row.lineCount,
    row.promptCount,
    row.toolCount
  );
}

export function upsertPrompt(db, p) {
  db.prepare(
    `INSERT OR IGNORE INTO prompts (
      conversation_id, project, prompt_idx, ts, preview, prompt_hash,
      detected_command, char_count, source
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    p.conversationId,
    p.project,
    p.promptIdx,
    p.ts,
    p.preview,
    p.hash,
    p.command,
    p.charCount,
    p.source
  );
}

export function queryScalar(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function queryAll(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** Run fn inside a single SQLite transaction (BEGIN/COMMIT/ROLLBACK). */
export function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection may already be closed or rolled back */
    }
    throw err;
  }
}
