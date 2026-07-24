import fs from "node:fs";
import { spawn } from "node:child_process";
import { loadConfig, ensureDataDirs } from "./config.mjs";
import { openDatabase, queryScalar } from "./db.mjs";
import { ingestAll } from "./ingest.mjs";
import { runAllRollups } from "./aggregate.mjs";
import { writeReports } from "./report.mjs";
import { applyRetention } from "./retention.mjs";
import { startWatch } from "./watch.mjs";

function printHelp() {
  console.log(`cursor-observatory — local Cursor usage analytics

Usage:
  cursor-observatory ingest [--full] [--no-rollup]
  cursor-observatory rollup
  cursor-observatory report [--json] [--with-llm]
  cursor-observatory dashboard [--full] [--no-open] [--with-llm]
  cursor-observatory watch [--interval 30] [--with-llm]   (interval in seconds)
  cursor-observatory prune
  cursor-observatory status

Commands:
  ingest     Read ~/.cursor hooks logs + transcripts into SQLite
  rollup     Recompute sessions, time buckets, and behavior only
  report     Generate HTML + JSON reports
  dashboard  ingest + retention + rollup + report (full refresh)
  watch      Auto-refresh on file changes (hooks + transcripts + collector events)
  prune      Apply retention policy from config (if enabled)
  status     Show database summary
`);
}

function openFile(target) {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", `"${target}"`] : [target];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const COMMANDS = new Set([
  "status",
  "rollup",
  "prune",
  "ingest",
  "report",
  "dashboard",
  "watch",
]);

/** Per-command allowed flags (valued flags listed by name; value skipped separately). */
const COMMAND_FLAGS = {
  status: new Set(),
  rollup: new Set(),
  prune: new Set(),
  ingest: new Set(["--full", "--no-rollup"]),
  report: new Set(["--json", "--with-llm"]),
  dashboard: new Set(["--full", "--no-open", "--with-llm"]),
  watch: new Set(["--interval", "--with-llm"]),
};

export function assertKnownFlags(cmd, rest) {
  const allowed = COMMAND_FLAGS[cmd];
  if (!allowed) return;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (typeof arg !== "string" || !arg.startsWith("-")) continue;
    if (!allowed.has(arg)) {
      throw new Error(`Unknown flag for ${cmd}: ${arg}`);
    }
    if (arg === "--interval") i += 1; // skip value; parseIntervalMs validates it
  }
}

export function parseIntervalMs(rest, flag = "--interval") {
  const idx = rest.indexOf(flag);
  if (idx === -1) return 30000;
  const raw = rest[idx + 1];
  if (!raw || raw.startsWith("-")) {
    throw new Error(`${flag} requires a positive number of seconds`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid ${flag} value: ${raw} (expected positive seconds)`);
  }
  return n * 1000;
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }
  if (!COMMANDS.has(cmd)) {
    throw new Error(`Unknown command: ${cmd}`);
  }
  assertKnownFlags(cmd, rest);

  const config = loadConfig();
  ensureDataDirs(config);
  const db = openDatabase(config.dbPath);

  try {
  if (cmd === "status") {
    const totals = queryScalar(
      db,
      `SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(DISTINCT NULLIF(conversation_id, '')) FROM events) AS sessions,
        (SELECT COUNT(*) FROM prompts) AS prompts,
        (SELECT COUNT(*) FROM transcripts) AS transcripts,
        (SELECT SUM(CASE WHEN event_type='toolFailure' THEN 1 ELSE 0 END) FROM events) AS tool_failures,
        (SELECT SUM(CASE WHEN event_type='stop' THEN COALESCE(cache_read_tokens,0) ELSE 0 END) FROM events) AS cache_read`
    );
    console.log("Cursor Observatory status");
    console.log(`  DB: ${config.dbPath}`);
    console.log(`  Events: ${totals?.events ?? 0}`);
    console.log(`  Sessions: ${totals?.sessions ?? 0}`);
    console.log(`  Prompts: ${totals?.prompts ?? 0}`);
    console.log(`  Transcripts: ${totals?.transcripts ?? 0}`);
    console.log(`  Tool failures: ${totals?.tool_failures ?? 0}`);
    console.log(`  Cache read tokens: ${totals?.cache_read ?? 0}`);
    const behavior = queryScalar(
      db,
      `SELECT fluency_score, archetype, real_prompt_count FROM behavior_snapshots WHERE period='all-time'`
    );
    if (behavior) {
      const conf =
        behavior.real_prompt_count < 10
          ? "low"
          : behavior.real_prompt_count < 40
            ? "medium"
            : "high";
      console.log(
        `  Fluency: ${behavior.fluency_score}/100 (${behavior.archetype}, ${conf} confidence)`
      );
    }
    return;
  }

  if (cmd === "rollup") {
    const roll = runAllRollups(db);
    console.log(`Rollups complete: ${roll.sessions} sessions`);
    return;
  }

  if (cmd === "prune") {
    const result = applyRetention(db, config);
    console.log("Retention:", JSON.stringify(result));
    if (result.pruned > 0) {
      const roll = runAllRollups(db);
      console.log(`Rollups: ${roll.sessions} sessions after prune`);
    }
    return;
  }

  if (cmd === "ingest") {
    const full = rest.includes("--full");
    const noRollup = rest.includes("--no-rollup");
    if (full) {
      db.exec(`DELETE FROM ingest_checkpoints`);
      console.log("Full ingest: checkpoints cleared; transcripts will be re-parsed");
    }
    console.log("Ingesting from", config.cursorHome);
    const summary = ingestAll(db, config, { full });
    console.log("Ingest summary:", JSON.stringify(summary, null, 2));
    if (!noRollup) {
      const roll = runAllRollups(db);
      console.log(`Rollups: ${roll.sessions} sessions aggregated`);
    }
    return;
  }

  if (cmd === "report") {
    runAllRollups(db);
    const withLlm = rest.includes("--with-llm") || config.recommendations?.llm?.enabled;
    const paths = await writeReports(db, config.reportsDir, config, { withLlm });
    console.log(`Report HTML: ${paths.latestHtml}`);
    console.log(`Report JSON: ${paths.latestJson}`);
    if (withLlm) console.log("  LLM recommendations: enabled");
    if (rest.includes("--json")) {
      console.log(JSON.stringify(paths, null, 2));
    }
    return;
  }

  if (cmd === "dashboard") {
    const full = rest.includes("--full");
    const withLlm = rest.includes("--with-llm") || config.recommendations?.llm?.enabled;
    if (full) {
      db.exec(`DELETE FROM ingest_checkpoints`);
      console.log("Full ingest: checkpoints cleared; transcripts will be re-parsed");
    }
    console.log("Dashboard: ingest → retention → rollup → report");
    const summary = ingestAll(db, config, { full });
    console.log("Ingest:", JSON.stringify(summary, null, 2));
    applyRetention(db, config);
    const roll = runAllRollups(db);
    console.log(`Sessions: ${roll.sessions}`);
    const paths = await writeReports(db, config.reportsDir, config, { withLlm });
    console.log(`Report: ${paths.latestHtml}`);
    if (withLlm) console.log("  LLM recommendations: enabled");
    if (!rest.includes("--no-open") && fs.existsSync(paths.latestHtml)) {
      openFile(paths.latestHtml);
    }
    return;
  }

  if (cmd === "watch") {
    const intervalMs = parseIntervalMs(rest);
    const withLlm = rest.includes("--with-llm") || config.recommendations?.llm?.enabled;
    const stop = startWatch(config, db, {
      intervalMs,
      withLlm,
      onRefresh: (paths) => {
        console.log(`  Report: ${paths.latestHtml}`);
      },
    });
    await new Promise((resolve) => {
      const onSignal = async () => {
        try {
          await stop();
        } finally {
          db.close();
          resolve();
        }
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    });
    return;
  }
  } finally {
    if (cmd !== "watch") db.close();
  }
}
