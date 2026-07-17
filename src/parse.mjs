import path from "node:path";

const BOM = "\uFEFF";

export function stripBom(s) {
  return typeof s === "string" && s.startsWith(BOM) ? s.slice(1) : s;
}

export function decodeProjectSlug(slug) {
  if (!slug) return null;
  if (/^\d+$/.test(slug)) return `project-${slug}`;
  const m = slug.match(/^([a-z])-(.+)$/i);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = m[2].replace(/-/g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }
  return slug;
}

export function projectFromTranscriptPath(transcriptPath) {
  if (!transcriptPath) return null;
  const norm = transcriptPath.replace(/\\/g, "/");
  const m = norm.match(/\/projects\/([^/]+)\/agent-transcripts\//i);
  return m ? decodeProjectSlug(m[1]) : null;
}

export function primaryWorkspace(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const first = roots.find((r) => typeof r === "string" && r.length > 0);
  if (!first) return null;
  const m = first.match(/^\/([a-z]):\//i);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = first.slice(m[0].length).replace(/\//g, path.sep);
    return `${drive}:${path.sep}${rest}`;
  }
  return first.replace(/\//g, path.sep);
}

export function unwrapAuditEntry(outer) {
  if (!outer || typeof outer !== "object") return null;

  let inner = { ...outer };
  const raw = outer.data?.raw;
  if (typeof raw === "string") {
    try {
      inner = { ...outer, ...JSON.parse(stripBom(raw.trim())) };
    } catch {
      inner = outer;
    }
  } else if (outer.data && typeof outer.data === "object" && !outer.data.raw) {
    inner = { ...outer, ...outer.data };
  }

  const eventType =
    inner.hook_event_name ||
    inner.event ||
    outer.event ||
    outer.hook_event_name ||
    "unknown";

  const ts = outer.timestamp || inner.timestamp || null;

  return {
    ts,
    eventType,
    conversationId:
      inner.conversation_id || inner.session_id || outer.conversation_id || null,
    generationId: inner.generation_id || null,
    model: inner.model || outer.model || null,
    modelId: inner.model_id || null,
    status: inner.status || null,
    loopCount: inner.loop_count ?? null,
    inputTokens: num(inner.input_tokens),
    outputTokens: num(inner.output_tokens),
    cacheReadTokens: num(inner.cache_read_tokens),
    cacheWriteTokens: num(inner.cache_write_tokens),
    toolName: inner.tool_name || null,
    toolInput: inner.tool_input || null,
    command: inner.command || null,
    output: typeof inner.output === "string" ? inner.output.slice(0, 2000) : null,
    durationMs: num(inner.duration_ms),
    workspaceRoots: inner.workspace_roots || [],
    project: primaryWorkspace(inner.workspace_roots) ||
      projectFromTranscriptPath(inner.transcript_path),
    transcriptPath: inner.transcript_path || null,
    cursorVersion: inner.cursor_version || null,
    composerMode: inner.composer_mode || null,
    prompt: inner.prompt || inner.user_message || null,
    subagentType: inner.subagent_type || null,
    reason: inner.reason || null,
    finalStatus: inner.final_status || null,
    errorMessage: inner.error_message || null,
  };
}

export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function extractUserText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function extractUserQuery(text) {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  return (m ? m[1] : text).trim();
}

export function sanitizePreview(text, maxLen = 120) {
  if (!text) return "";
  let s = String(text)
    .replace(/<user_query>\s*/gi, "")
    .replace(/<\/user_query>/gi, "")
    .replace(/<cursor_commands>[\s\S]*?<\/cursor_commands>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

export function normalizeProjectPath(p) {
  if (!p) return p;
  const m = p.match(/^([a-zA-Z]):[\\/]?(.*)$/);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest = m[2].replace(/[\\/]/g, path.sep);
    return rest ? `${drive}:${path.sep}${rest}` : `${drive}:${path.sep}`;
  }
  return p;
}

/** Folder name only — e.g. C:\Development\AGORA → AGORA */
export function shortProjectName(p) {
  if (!p) return "—";
  const norm = normalizeProjectPath(p).replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (!parts.length) return "—";
  return parts[parts.length - 1];
}

/** Parent path for context line under short name */
export function projectPathContext(p) {
  if (!p) return "";
  const norm = normalizeProjectPath(p).replace(/\\/g, "/");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 1) return norm;
  return parts.slice(0, -1).join("/");
}

export function detectSlashCommand(text) {
  const q = extractUserQuery(text);
  const m = q.match(/^\/([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function isInjectedPrompt(text) {
  if (!text) return true;
  if (text.length > 6000) return true;
  if (text.includes("<cursor_commands>")) return true;
  if (text.startsWith("[MUST]") || text.startsWith("<system_reminder>")) return true;
  return false;
}

export function hashPrompt(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function parseTranscriptRecords(lines, meta) {
  const records = [];
  let promptIdx = 0;
  let toolCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }

    const role = e.role;
    const content = e.message?.content ?? e.content;

    if (role === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use") toolCount++;
      }
      continue;
    }

    if (role !== "user") continue;

    const text = extractUserText(content).trim();
    if (!text || isInjectedPrompt(text)) continue;

    promptIdx++;
    records.push({
      ...meta,
      promptIdx,
      text,
      preview: sanitizePreview(text, 200),
      hash: hashPrompt(text),
      command: detectSlashCommand(text),
    });
  }

  return { records, promptCount: promptIdx, toolCount };
}
