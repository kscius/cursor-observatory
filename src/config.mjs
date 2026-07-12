import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function normalizeRetentionDays(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function expandHome(p) {
  if (!p || typeof p !== "string") return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
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
      raw = JSON.parse(text);
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

  const cursorHome = expandHome(raw.cursorHome || "~/.cursor");
  const dataDir = expandHome(raw.dataDir || path.join(cursorHome, "observatory"));

  return {
    cursorHome,
    dataDir,
    dbPath: expandHome(raw.dbPath || path.join(dataDir, "observatory.db")),
    reportsDir: expandHome(raw.reportsDir || path.join(dataDir, "reports")),
    archiveDir: expandHome(raw.archiveDir || path.join(dataDir, "archive")),
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
        baseUrl: raw.recommendations?.llm?.baseUrl || "https://api.openai.com/v1",
        useCache: raw.recommendations?.llm?.useCache !== false,
        sections: raw.recommendations?.llm?.sections || [
          "behavior",
          "overview",
          "usage",
          "sessions",
          "tools",
        ],
      },
    },
  };
}

export function ensureDataDirs(config) {
  for (const dir of [config.dataDir, config.reportsDir, config.archiveDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
