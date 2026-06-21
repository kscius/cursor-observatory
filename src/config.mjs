import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

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
    if (fs.existsSync(file)) {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
      break;
    }
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
      includeRotatedLogs: raw.ingest?.includeRotatedLogs !== false,
    },
    retention: {
      keepRawEventsDays: raw.retention?.keepRawEventsDays ?? 0,
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
