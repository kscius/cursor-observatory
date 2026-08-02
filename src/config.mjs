import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripBom } from "./parse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** Cap so Date.now() - days*864e5 stays a valid Date (avoids toISOString RangeError). */
const MAX_RETENTION_DAYS = 36500; // ~100 years

function normalizeRetentionDays(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_RETENTION_DAYS);
}

const DEFAULT_LLM_TIMEOUT_MS = 30_000;
/** Cap LLM request timeouts to a sane upper bound (2 minutes). */
const MAX_LLM_TIMEOUT_MS = 120_000;

function normalizeLlmTimeoutMs(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LLM_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(Math.floor(n), MAX_LLM_TIMEOUT_MS);
}

/** Prefer a non-blank string path; otherwise use fallback (may still be expanded). */
function normalizeConfigPath(value, fallback) {
  const selected = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return expandHome(selected);
}

export function expandHome(p) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Strip trailing slashes so cache keys and fetch URLs stay consistent. */
export function normalizeLlmBaseUrl(value) {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : "https://api.openai.com/v1";
  return raw.replace(/\/+$/, "") || "https://api.openai.com/v1";
}

export function loadConfig() {
  const candidates = [
    path.join(expandHome("~/.cursor/observatory"), "config.json"),
    path.join(REPO_ROOT, "config.json"),
    path.join(REPO_ROOT, "config.example.json"),
  ];

  let raw = {};
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`Cannot read config file ${file}: ${err.message}`);
    }
    try {
      raw = JSON.parse(stripBom(text));
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file ${file}: ${err.message}`);
      }
      throw err;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Config file ${file} must be a JSON object`);
    }
    break;
  }

  const cursorHome = normalizeConfigPath(raw.cursorHome, "~/.cursor");
  const dataDir = normalizeConfigPath(raw.dataDir, path.join(cursorHome, "observatory"));

  return {
    cursorHome,
    dataDir,
    dbPath: normalizeConfigPath(raw.dbPath, path.join(dataDir, "observatory.db")),
    reportsDir: normalizeConfigPath(raw.reportsDir, path.join(dataDir, "reports")),
    archiveDir: normalizeConfigPath(raw.archiveDir, path.join(dataDir, "archive")),
    projectsDir: path.join(cursorHome, "projects"),
    hooksLogsDir: path.join(cursorHome, "hooks", "logs"),
    ingest: {
      auditLogs: raw.ingest?.auditLogs !== false,
      sessionSummary: raw.ingest?.sessionSummary !== false,
      subagentAudit: raw.ingest?.subagentAudit !== false,
      toolFailures: raw.ingest?.toolFailures !== false,
      transcripts: raw.ingest?.transcripts !== false,
      // Opt-in: omit or false keeps collector ingest off (matches config.example.json).
      hookEvents: raw.ingest?.hookEvents === true,
      includeRotatedLogs: raw.ingest?.includeRotatedLogs !== false,
    },
    retention: {
      keepRawEventsDays: normalizeRetentionDays(raw.retention?.keepRawEventsDays),
    },
    recommendations: {
      enabled: raw.recommendations?.enabled !== false,
      llm: {
        enabled: raw.recommendations?.llm?.enabled === true,
        provider: raw.recommendations?.llm?.provider || "openai",
        model: raw.recommendations?.llm?.model || "gpt-4o-mini",
        apiKeyEnv: raw.recommendations?.llm?.apiKeyEnv || "OPENAI_API_KEY",
        baseUrl: normalizeLlmBaseUrl(raw.recommendations?.llm?.baseUrl),
        timeoutMs: normalizeLlmTimeoutMs(raw.recommendations?.llm?.timeoutMs),
        useCache: raw.recommendations?.llm?.useCache !== false,
        sections: normalizeLlmSections(raw.recommendations?.llm?.sections),
      },
    },
  };
}

const DEFAULT_LLM_SECTIONS = ["behavior", "overview", "usage", "sessions", "tools"];

/** Accept a string as a one-item list; ignore non-array non-string values. */
function normalizeLlmSections(sections) {
  if (Array.isArray(sections)) {
    const keys = sections.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    return keys.length > 0 ? keys : DEFAULT_LLM_SECTIONS;
  }
  if (typeof sections === "string" && sections.trim()) {
    return [sections.trim()];
  }
  return DEFAULT_LLM_SECTIONS;
}

export function ensureDataDirs(config) {
  for (const dir of [config.dataDir, config.reportsDir, config.archiveDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
