import { withTransaction } from "./db.mjs";

export function applyRetention(db, config) {
  const days = Number(config.retention?.keepRawEventsDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return { pruned: 0, reason: "retention disabled" };

  // Compare as ISO-8601 strings. SQLite datetime() returns 'YYYY-MM-DD HH:MM:SS',
  // which sorts incorrectly against stored 'YYYY-MM-DDTHH:MM:SS.sssZ' values.
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) {
    return { pruned: 0, reason: "invalid retention window" };
  }
  const cutoffDate = new Date(cutoffMs);
  if (Number.isNaN(cutoffDate.getTime())) {
    return { pruned: 0, reason: "invalid retention window" };
  }

  return withTransaction(db, () => {
    const cutoff = cutoffDate.toISOString();
    // Also drop null-timestamp rows: they never age out via ts < cutoff otherwise.
    const prunedEvents =
      db
        .prepare(`DELETE FROM events WHERE ts IS NULL OR ts < ?`)
        .run(cutoff).changes ?? 0;
    // Drop transcript fingerprints for conversations losing transcript prompts so
    // ingest can re-parse unchanged files after retention (mtime/size skip otherwise).
    db.prepare(
      `DELETE FROM transcripts
       WHERE conversation_id IN (
         SELECT DISTINCT conversation_id FROM prompts
         WHERE source = 'transcript' AND (ts IS NULL OR ts < ?)
       )`
    ).run(cutoff);
    const prunedPrompts =
      db
        .prepare(`DELETE FROM prompts WHERE ts IS NULL OR ts < ?`)
        .run(cutoff).changes ?? 0;

    return { pruned: prunedEvents + prunedPrompts, prunedEvents, prunedPrompts, days };
  });
}
