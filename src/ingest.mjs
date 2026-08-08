import fs from "node:fs";
import path from "node:path";
import {
  getCheckpoint,
  getTranscriptMetadata,
  deletePromptsForConversation,
  insertEvent,
  setCheckpoint,
  upsertPrompt,
  upsertTranscript,
  withTransaction,
} from "./db.mjs";
import {
  decodeProjectSlug,
  parseTranscriptRecords,
  primaryWorkspace,
  projectFromTranscriptPath,
  normalizeWorkspaceRoots,
  stripBom,
  unwrapAuditEntry,
  normalizeTs,
  pickTs,
  pickNonBlankString,
  num,
} from "./parse.mjs";

/** Count newline-terminated physical lines (matches checkpoint line numbers). */
function countCompleteLines(content) {
  let n = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") n++;
  }
  return n;
}

/** True when every JSONL record is newline-terminated (ignore trailing whitespace). */
function hasCompleteTrailingLine(content) {
  if (content.endsWith("\n")) return true;
  const lastNl = content.lastIndexOf("\n");
  // No newline at all → single incomplete (or unterminated) physical line.
  if (lastNl === -1) return false;
  // Whitespace after the final newline is not a mid-append partial JSON record.
  return !content.slice(lastNl + 1).trim();
}

function* readLinesFromContent(content, startLine = 0) {
  const completeTrailing = hasCompleteTrailingLine(content);
  const lines = content.split(/\r?\n/);
  let lastNonEmptyIndex = -1;
  for (let i = startLine; i < lines.length; i++) {
    if (stripBom(lines[i]).trim()) lastNonEmptyIndex = i;
  }
  for (let i = startLine; i < lines.length; i++) {
    const line = stripBom(lines[i]);
    if (!line.trim()) continue;
    yield {
      line,
      lineNo: i + 1,
      // Incomplete trailing write (collector mid-append) — do not checkpoint past it.
      isTrailingPartialLine: !completeTrailing && i === lastNonEmptyIndex,
    };
  }
}

function ingestJsonlFile(db, filePath, mapFn, { replaceOnRead = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    // Watch/rotation races: file may disappear between discovery and read.
    if (err && err.code === "ENOENT") return { lines: 0, inserted: 0, skipped: 0 };
    throw err;
  }

  const cp = getCheckpoint(db, filePath);
  // Append-only JSONL with unchanged size has no new bytes — skip full-file reads
  // on watch/interval refreshes (same-size in-place rewrites need ingest --full).
  if (!replaceOnRead && stat.size === cp.last_size) {
    return { lines: 0, inserted: 0, skipped: 0 };
  }

  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { lines: 0, inserted: 0, skipped: 0 };
    throw err;
  }
  const completeLineCount = countCompleteLines(content);
  let startLine = cp.last_line;
  // Rotated snapshots (*.old) are wholesale replacements, not append-only logs.
  // Same/larger size must still reset — size-shrink detection alone misses replacements.
  // Also reset when the checkpoint points past the current complete line count
  // (same/larger rewrite with fewer lines; no schema change required).
  if (
    replaceOnRead ||
    stat.size < cp.last_size ||
    cp.last_line > completeLineCount
  ) {
    // Log rotation or truncate: line numbers collide with the previous file.
    db.prepare(`DELETE FROM events WHERE source_file = ?`).run(filePath);
    startLine = 0;
  }
  let inserted = 0;
  let skipped = 0;
  let maxLine = startLine;

  for (const { line, lineNo, isTrailingPartialLine } of readLinesFromContent(
    content,
    startLine
  )) {
    // Incomplete trailing write (even if currently valid JSON) — wait for a newline
    // before inserting or checkpointing so a mid-append cannot be locked in.
    if (isTrailingPartialLine) {
      skipped++;
      continue;
    }
    let outer;
    try {
      outer = JSON.parse(line);
    } catch {
      // Only malformed JSON is skippable. Mapper/DB errors must not advance the
      // checkpoint or append-only rows would be permanently lost.
      skipped++;
      maxLine = lineNo;
      continue;
    }
    const mapped = mapFn(outer, filePath, lineNo);
    if (!mapped) {
      skipped++;
    } else if (Array.isArray(mapped)) {
      for (const item of mapped) {
        if (insertEvent(db, item) > 0) inserted++;
      }
    } else if (insertEvent(db, mapped) > 0) {
      inserted++;
    }
    // Advance past complete records once a trailing newline confirms the line.
    maxLine = lineNo;
  }

  setCheckpoint(db, filePath, maxLine, stat.size);
  return { lines: maxLine - startLine, inserted, skipped };
}

/** Prefer ISO `timestamp`, then collector-style `ts`; coerce epoch values. */
function eventTs(outer) {
  return normalizeTs(pickTs(outer?.timestamp, outer?.ts));
}

/** Align with audit unwrap: status → final_status → reason (skip whitespace-only). */
function eventStatus(outer, fallback = null) {
  return pickNonBlankString(outer?.status, outer?.final_status, outer?.reason) || fallback;
}

function auditToEvent(outer, sourceFile, sourceLine) {
  const ev = unwrapAuditEntry(outer);
  if (!ev) return null;
  return {
    ...ev,
    promptPreview: ev.prompt ? String(ev.prompt).slice(0, 300) : null,
    sourceFile,
    sourceLine,
    payloadJson: JSON.stringify(outer).slice(0, 8000),
  };
}

function subagentToEvent(outer, sourceFile, sourceLine) {
  // Mirror hook-event ingest: skip rows without a usable event name (do not invent).
  const eventName = pickNonBlankString(outer.hook_event_name, outer.event);
  if (!eventName) return null;
  const transcriptPath = pickNonBlankString(outer.transcript_path, outer.agent_transcript_path);
  return {
    ts: eventTs(outer),
    eventType: eventName,
    conversationId: pickNonBlankString(outer.conversation_id, outer.session_id),
    generationId: outer.generation_id || null,
    model: outer.model || null,
    project: projectFromTranscriptPath(transcriptPath),
    workspaceRoots: [],
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    toolName: null,
    command: null,
    durationMs: num(outer.duration_ms),
    transcriptPath,
    cursorVersion: outer.cursor_version || null,
    composerMode: null,
    promptPreview: (pickNonBlankString(outer.task, outer.description) || "").slice(0, 300),
    subagentType: outer.subagent_type || null,
    status: eventStatus(outer),
    sourceFile,
    sourceLine,
    payloadJson: JSON.stringify(outer).slice(0, 8000),
  };
}

function sessionSummaryToEvent(outer, sourceFile, sourceLine) {
  return {
    ts: eventTs(outer),
    eventType: "sessionEnd",
    // Collector/hooks may emit session_id instead of conversation_id.
    conversationId: pickNonBlankString(outer.conversation_id, outer.session_id),
    generationId: outer.generation_id || null,
    model: null,
    project: null,
    workspaceRoots: [],
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    toolName: null,
    command: null,
    durationMs: num(outer.duration_ms),
    transcriptPath: null,
    cursorVersion: outer.cursor_version || null,
    composerMode: outer.composer_mode || null,
    promptPreview: null,
    subagentType: null,
    status: eventStatus(outer),
    sourceFile,
    sourceLine,
    payloadJson: JSON.stringify(outer).slice(0, 4000),
  };
}

export function ingestAuditLogs(db, hooksLogsDir, includeRotated = true) {
  const files = [path.join(hooksLogsDir, "agent-audit.jsonl")];
  if (includeRotated) files.push(path.join(hooksLogsDir, "agent-audit.jsonl.old"));

  const totals = { files: 0, inserted: 0, skipped: 0 };
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    totals.files++;
    const replaceOnRead = path.basename(f) === "agent-audit.jsonl.old";
    const r = ingestJsonlFile(db, f, auditToEvent, { replaceOnRead });
    totals.inserted += r.inserted;
    totals.skipped += r.skipped;
  }
  return totals;
}

export function ingestSessionSummary(db, hooksLogsDir) {
  const f = path.join(hooksLogsDir, "session-summary.jsonl");
  return ingestJsonlFile(db, f, sessionSummaryToEvent);
}

export function ingestSubagentAudit(db, hooksLogsDir) {
  const f = path.join(hooksLogsDir, "subagent-audit.jsonl");
  return ingestJsonlFile(db, f, subagentToEvent);
}

export function ingestToolFailures(db, hooksLogsDir) {
  const f = path.join(hooksLogsDir, "tool-failures.jsonl");
  return ingestJsonlFile(db, f, (outer, sourceFile, sourceLine) => ({
    ts: eventTs(outer),
    eventType: "toolFailure",
    // Match other secondary logs: session_id is an accepted conversation alias.
    conversationId: pickNonBlankString(outer.conversation_id, outer.session_id),
    generationId: outer.generation_id || null,
    model: outer.model || null,
    project: null,
    workspaceRoots: [],
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    toolName: outer.tool_name || null,
    command: null,
    durationMs: null,
    transcriptPath: null,
    cursorVersion: outer.cursor_version || null,
    composerMode: null,
    promptPreview: (pickNonBlankString(outer.error, outer.message) || "").slice(0, 300),
    subagentType: null,
    status: eventStatus(outer, "failed"),
    sourceFile,
    sourceLine,
    payloadJson: JSON.stringify(outer).slice(0, 4000),
  }));
}

function findTranscriptFiles(projectsDir) {
  const results = [];
  if (!fs.existsSync(projectsDir)) return results;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        if (full.includes(`${path.sep}agent-transcripts${path.sep}`)) {
          results.push(full);
        }
      }
    }
  };

  walk(projectsDir);
  return results;
}

export function ingestTranscripts(db, projectsDir, { force = false } = {}) {
  const files = findTranscriptFiles(projectsDir);
  let transcripts = 0;
  let prompts = 0;

  for (const filePath of files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    const conversationId = path.basename(filePath, ".jsonl");
    const prevTranscript = getTranscriptMetadata(db, filePath);
    if (
      !force &&
      prevTranscript &&
      prevTranscript.mtime_ms === stat.mtimeMs &&
      prevTranscript.file_size === stat.size
    ) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
    // Mid-write transcript: wait for a trailing newline before ingesting or
    // fingerprinting so a partial last line cannot be locked in (audit JSONL parity).
    if (!hasCompleteTrailingLine(content)) continue;

    const lines = content.split(/\r?\n/);

    const project =
      projectFromTranscriptPath(filePath) ||
      decodeProjectSlug(
        filePath.replace(/\\/g, "/").match(/\/projects\/([^/]+)\//)?.[1]
      );

    // Parse before mutating DB so a read/parse failure cannot wipe prompts
    // while leaving fingerprint metadata that would skip future re-ingest.
    const { records, promptCount, toolCount } = parseTranscriptRecords(lines, {
      conversationId,
      project,
      ts: new Date(stat.mtimeMs).toISOString(),
      source: "transcript",
    });

    withTransaction(db, () => {
      if (prevTranscript) {
        deletePromptsForConversation(db, conversationId, "transcript");
      }
      upsertTranscript(db, {
        path: filePath,
        conversationId,
        project,
        fileSize: stat.size,
        mtimeMs: stat.mtimeMs,
        lineCount: lines.filter((l) => stripBom(l).trim()).length,
        promptCount,
        toolCount,
      });
      for (const rec of records) {
        upsertPrompt(db, {
          conversationId: rec.conversationId,
          project: rec.project,
          promptIdx: rec.promptIdx,
          ts: rec.ts,
          preview: rec.preview,
          hash: rec.hash,
          command: rec.command,
          charCount: rec.text.length,
          source: rec.source,
        });
      }
    });
    prompts += records.length;
    transcripts++;
  }

  return { files: files.length, transcripts, prompts };
}

export function ingestHookEvents(db, dataDir) {
  const f = path.join(dataDir, "events", "hook-events.jsonl");
  return ingestJsonlFile(db, f, (outer, sourceFile, sourceLine) => {
    // Mirror collector: skip rows without a usable event name (do not invent "unknown").
    // Blank/whitespace hook_event_name must fall through to event alias.
    const eventName = pickNonBlankString(outer.hook_event_name, outer.event);
    if (!eventName) return null;
    const roots = normalizeWorkspaceRoots(outer.workspace_roots);
    const prompt = pickNonBlankString(outer.prompt, outer.user_message);
    const transcriptPath = pickNonBlankString(
      outer.transcript_path,
      outer.agent_transcript_path
    );
    const ev = {
      ts: eventTs(outer),
      eventType: eventName,
      conversationId: pickNonBlankString(outer.conversation_id, outer.session_id),
      generationId: outer.generation_id || null,
      model: outer.model || null,
      workspaceRoots: roots,
      inputTokens: num(outer.input_tokens),
      outputTokens: num(outer.output_tokens),
      cacheReadTokens: num(outer.cache_read_tokens),
      cacheWriteTokens: num(outer.cache_write_tokens),
      toolName: outer.tool_name || null,
      command: outer.command || null,
      durationMs: num(outer.duration_ms),
      transcriptPath,
      cursorVersion: outer.cursor_version || null,
      composerMode: outer.composer_mode || null,
      prompt,
      project: primaryWorkspace(roots) || projectFromTranscriptPath(transcriptPath),
    };
    return {
      ...ev,
      promptPreview: ev.prompt ? String(ev.prompt).slice(0, 300) : null,
      subagentType: outer.subagent_type || null,
      status: eventStatus(outer),
      sourceFile,
      sourceLine,
      payloadJson: JSON.stringify(outer).slice(0, 8000),
    };
  });
}

export function ingestAll(db, config, { full = false } = {}) {
  const summary = { audit: null, session: null, subagent: null, tools: null, hookEvents: null, transcripts: null };

  if (config.ingest.auditLogs && config.ingest.hookEvents) {
    console.warn(
      "[observatory] auditLogs and hookEvents are both enabled; the same stop events may be counted twice. Disable one in ~/.cursor/observatory/config.json (see README)."
    );
  }
  if (config.ingest.sessionSummary && config.ingest.hookEvents) {
    console.warn(
      "[observatory] sessionSummary and hookEvents are both enabled; collector sessionEnd events may double-count durations with session-summary.jsonl. Set ingest.sessionSummary to false when using the collector (see README)."
    );
  }
  if (config.ingest.subagentAudit && config.ingest.hookEvents) {
    console.warn(
      "[observatory] subagentAudit and hookEvents are both enabled; collector subagentStop events may double-count with subagent-audit.jsonl. Set ingest.subagentAudit to false when using the collector (see README)."
    );
  }

  if (config.ingest.auditLogs) {
    summary.audit = ingestAuditLogs(
      db,
      config.hooksLogsDir,
      config.ingest.includeRotatedLogs
    );
  }
  if (config.ingest.sessionSummary) {
    summary.session = ingestSessionSummary(db, config.hooksLogsDir);
  }
  if (config.ingest.subagentAudit) {
    summary.subagent = ingestSubagentAudit(db, config.hooksLogsDir);
  }
  if (config.ingest.toolFailures) {
    summary.tools = ingestToolFailures(db, config.hooksLogsDir);
  }
  if (config.ingest.hookEvents) {
    summary.hookEvents = ingestHookEvents(db, config.dataDir);
  }
  if (config.ingest.transcripts) {
    // --full clears JSONL checkpoints and also forces transcript re-parse
    // (mtime/size fingerprint would otherwise skip unchanged files).
    summary.transcripts = ingestTranscripts(db, config.projectsDir, { force: full });
  }

  return summary;
}
