import fs from "node:fs";
import path from "node:path";
import { ingestAll } from "./ingest.mjs";
import { runAllRollups } from "./aggregate.mjs";
import { writeReports } from "./report.mjs";
import { applyRetention } from "./retention.mjs";

function debounce(fn, ms) {
  let t;
  const debounced = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => {
    clearTimeout(t);
    t = undefined;
  };
  return debounced;
}

export function startWatch(config, db, { intervalMs = 30000, onRefresh, withLlm = false } = {}) {
  let inFlight = false;
  let pending = false;
  let refreshPromise = null;

  const refresh = async () => {
    if (inFlight) {
      pending = true;
      return refreshPromise;
    }
    inFlight = true;
    refreshPromise = (async () => {
      try {
        do {
          pending = false;
          try {
            ingestAll(db, config);
            applyRetention(db, config);
            runAllRollups(db);
            const llmOn = withLlm || config.recommendations?.llm?.enabled;
            // Watch refreshes often; only update latest.* to avoid unbounded report-* growth.
            const paths = await writeReports(db, config.reportsDir, config, {
              withLlm: llmOn,
              keepReportSnapshots: false,
            });
            await onRefresh?.(paths);
            console.log(`[watch] refreshed ${new Date().toISOString()}`);
          } catch (err) {
            console.error("[watch] error:", err.message || err);
          }
        } while (pending);
      } finally {
        inFlight = false;
        refreshPromise = null;
      }
    })();
    return refreshPromise;
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

  return async () => {
    debounced.cancel();
    clearInterval(timer);
    for (const w of watchers) w.close();
    // Wait for an in-flight refresh so CLI can close SQLite safely.
    if (refreshPromise) await refreshPromise;
  };
}
