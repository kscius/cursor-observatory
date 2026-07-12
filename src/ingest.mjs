import fs from "node:fs";
import path from "node:path";
import {
  getCheckpoint,
  getTranscriptMtime,
  deletePromptsForConversation,
  insertEvent,
  setCheckpoint,
  upsertPrompt,
  upsertTranscript,
} from "./db.mjs";
import {
  decodeProjectSlug,
  parseTranscriptRecords,
  primaryWorkspace,
  projectFromTranscriptPath,
  stripBom,
  unwrapAuditEntry,
  num,
} from "./parse.mjs";

function* readLinesFrom(filePath, startLine = 0) {
  const content = fs.readFileSync(filePath, "utf8");
  const endsWithNewline = content.endsWith("\n");
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
      isTrailingPartialLine: !endsWithNewline && i === lastNonEmptyIndex,
    };
  }
}

function ingestJsonlFile(db, filePath, mapFn) {
  if (!fs.existsSync(filePath)) return { lines: 0, inserted: 0, skipped: 0 };

  const stat = fs.statSync(filePath);
  const cp = getCheckpoint(db, filePath);
  let startLine = cp.last_line;
  if (stat.size < cp.last_size) {
    // Log rotation or truncate: line numbers collide with the previous file.
    db.prepare(`DELETE FROM events WHERE source_file = ?`).run(filePath);
    startLine = 0;
  }
  let inserted = 0;
  let skipped = 0;
  let maxLine = startLine;

  for (const { line, lineNo, isTrailingPartialLine } of readLinesFrom(filePath, startLine)) {
    let parsed = false;
    try {
      const outer = JSON.parse(line);
      parsed = true;
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
    } catch {
      skipped++;
    }
    // Advance past corrupt middle lines; hold checkpoint on a trailing partial line.
    if (parsed || !isTrailingPartialLine) {
      maxLine = lineNo;
    }
  }

  setCheckpoint(db, filePath, maxLine, stat.size);
  return { lines: maxLine - startLine, inserted, skipped };
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
  return {
    ts: outer.timestamp || null,
    eventType: outer.event || "subagentStop",
    conversationId: null,
    generationId: null,
    model: null,
    project: null,
    workspaceRoots: [],
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    toolName: null,
    command: null,
    durationMs: outer.duration_ms ?? null,
    transcriptPath: outer.agent_transcript_path || null,
    cursorVersion: outer.cursor_version || null,
    composerMode: null,
    promptPreview: String(outer.task || outer.description || "").slice(0, 300),
    subagentType: outer.subagent_type || null,
    status: outer.status || null,
    sourceFile,
    sourceLine,
    payloadJson: JSON.stringify(outer).slice(0, 8000),
  };
}

function sessionSummaryToEvent(outer, sourceFile, sourceLine) {
  return {
    ts: outer.timestamp || null,
    eventType: "sessionEnd",
    conversationId: outer.conversation_id || null,
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
    durationMs: outer.duration_ms ?? null,
    transcriptPath: null,
    cursorVersion: outer.cursor_version || null,
    composerMode: outer.composer_mode || null,
    promptPreview: null,
    subagentType: null,
    status: outer.final_status || outer.reason || null,
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
    const r = ingestJsonlFile(db, f, auditToEvent);
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
    ts: outer.timestamp || null,
    eventType: "toolFailure",
    conversationId: outer.conversation_id || null,
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
    promptPreview: String(outer.error || outer.message || "").slice(0, 300),
    subagentType: null,
    status: outer.status || "failed",
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

export function ingestTranscripts(db, projectsDir) {
  const files = findTranscriptFiles(projectsDir);
  let transcripts = 0;
  let prompts = 0;

  for (const filePath of files) {
    const stat = fs.statSync(filePath);
    const conversationId = path.basename(filePath, ".jsonl");
    const prevMtime = getTranscriptMtime(db, filePath);
    if (prevMtime !== null && prevMtime === stat.mtimeMs) continue;

    if (prevMtime !== null && prevMtime !== stat.mtimeMs) {
      deletePromptsForConversation(db, conversationId, "transcript");
    }

    const project =
      projectFromTranscriptPath(filePath) ||
      decodeProjectSlug(
        filePath.replace(/\\/g, "/").match(/\/projects\/([^/]+)\//)?.[1]
      );

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const { records, promptCount, toolCount } = parseTranscriptRecords(lines, {
      conversationId,
      project,
      ts: new Date(stat.mtimeMs).toISOString(),
      source: "transcript",
    });

    upsertTranscript(db, {
      path: filePath,
      conversationId,
      project,
      fileSize: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount: lines.filter((l) => l.trim()).length,
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
      prompts++;
    }
    transcripts++;
  }

  return { files: files.length, transcripts, prompts };
}

export function ingestHookEvents(db, dataDir) {
  const f = path.join(dataDir, "events", "hook-events.jsonl");
  return ingestJsonlFile(db, f, (outer, sourceFile, sourceLine) => {
    const roots = Array.isArray(outer.workspace_roots) ? outer.workspace_roots : [];
    const prompt = outer.prompt || outer.user_message || null;
    const ev = {
      ts: outer.ts || outer.timestamp || null,
      eventType: outer.hook_event_name || outer.event || "unknown",
      conversationId: outer.conversation_id || outer.session_id || null,
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
      transcriptPath: outer.transcript_path || null,
      cursorVersion: outer.cursor_version || null,
      composerMode: outer.composer_mode || null,
      prompt,
      project: primaryWorkspace(roots) || projectFromTranscriptPath(outer.transcript_path),
    };
    return {
      ...ev,
      promptPreview: ev.prompt ? String(ev.prompt).slice(0, 300) : null,
      subagentType: outer.subagent_type || null,
      status: outer.status || outer.final_status || null,
      sourceFile,
      sourceLine,
      payloadJson: JSON.stringify(outer).slice(0, 8000),
    };
  });
}

export function ingestAll(db, config) {
  const summary = { audit: null, session: null, subagent: null, tools: null, hookEvents: null, transcripts: null };

  if (config.ingest.auditLogs && config.ingest.hookEvents) {
    console.warn(
      "[observatory] auditLogs and hookEvents are both enabled; the same stop events may be counted twice. Disable one in ~/.cursor/observatory/config.json (see README)."
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
    summary.transcripts = ingestTranscripts(db, config.projectsDir);
  }

  return summary;
}
