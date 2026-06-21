import fs from "node:fs";
import path from "node:path";
import { ingestAll } from "./ingest.mjs";
import { runAllRollups } from "./aggregate.mjs";
import { writeReports } from "./report.mjs";
import { applyRetention } from "./retention.mjs";

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function startWatch(config, db, { intervalMs = 30000, onRefresh } = {}) {
  const refresh = async () => {
    try {
      ingestAll(db, config);
      runAllRollups(db);
      applyRetention(db, config);
      const withLlm = config.recommendations?.llm?.enabled;
      const paths = await writeReports(db, config.reportsDir, config, { withLlm });
      onRefresh?.(paths);
      console.log(`[watch] refreshed ${new Date().toISOString()}`);
    } catch (err) {
      console.error("[watch] error:", err.message || err);
    }
  };

  const debounced = debounce(refresh, 2000);
  const watchers = [];

  const watchDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, { recursive: true }, debounced);
      watchers.push(w);
    } catch {
      /* non-recursive fallback on some platforms */
      const w = fs.watch(dir, debounced);
      watchers.push(w);
    }
  };

  watchDir(config.hooksLogsDir);
  watchDir(config.projectsDir);
  watchDir(path.join(config.dataDir, "events"));

  refresh();
  const timer = setInterval(refresh, intervalMs);

  console.log(`Watching hooks + transcripts (refresh every ${intervalMs / 1000}s)`);
  console.log("Press Ctrl+C to stop.");

  return () => {
    clearInterval(timer);
    for (const w of watchers) w.close();
  };
}
