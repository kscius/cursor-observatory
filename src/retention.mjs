export function applyRetention(db, config) {
  const days = Number(config.retention?.keepRawEventsDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return { pruned: 0, reason: "retention disabled" };

  // Compare as ISO-8601 strings. SQLite datetime() returns 'YYYY-MM-DD HH:MM:SS',
  // which sorts incorrectly against stored 'YYYY-MM-DDTHH:MM:SS.sssZ' values.
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const prunedEvents =
    db
      .prepare(`DELETE FROM events WHERE ts IS NOT NULL AND ts < ?`)
      .run(cutoff).changes ?? 0;
  const prunedPrompts =
    db
      .prepare(`DELETE FROM prompts WHERE ts IS NOT NULL AND ts < ?`)
      .run(cutoff).changes ?? 0;

  return { pruned: prunedEvents + prunedPrompts, prunedEvents, prunedPrompts, days };
}
