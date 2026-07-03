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
  cursor-observatory watch [--interval 30]
  cursor-observatory prune
  cursor-observatory status

Commands:
  ingest     Read ~/.cursor hooks logs + transcripts into SQLite
  rollup     Recompute sessions, time buckets, and behavior only
  report     Generate HTML + JSON reports
  dashboard  ingest + rollup + report (full refresh)
  watch      Auto-refresh on file changes (hooks + transcripts)
  prune      Apply retention policy from config (if enabled)
  status     Show database summary
`);
}

function openFile(target) {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32" ? ["/c", "start", "", target] : [target];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

function parseIntervalMs(rest, flag = "--interval") {
  const idx = rest.indexOf(flag);
  if (idx === -1 || !rest[idx + 1]) return 30000;
  const n = Number(rest[idx + 1]);
  return Number.isFinite(n) && n > 0 ? n * 1000 : 30000;
}

export async function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    return;
  }

  const config = loadConfig();
  ensureDataDirs(config);
  const db = openDatabase(config.dbPath);

  try {
  if (cmd === "status") {
    const totals = queryScalar(
      db,
      `SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM sessions) AS sessions,
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
      console.log("Full ingest: checkpoints cleared");
    }
    console.log("Ingesting from", config.cursorHome);
    const summary = ingestAll(db, config);
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
    if (full) db.exec(`DELETE FROM ingest_checkpoints`);
    console.log("Dashboard: ingest → rollup → report");
    const summary = ingestAll(db, config);
    console.log("Ingest:", JSON.stringify(summary));
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
    const stop = startWatch(config, db, {
      intervalMs,
      onRefresh: (paths) => {
        console.log(`  Report: ${paths.latestHtml}`);
      },
    });
    await new Promise((resolve) => {
      const onSignal = () => {
        stop();
        db.close();
        resolve();
      };
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    });
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
  } finally {
    if (cmd !== "watch") db.close();
  }
}
