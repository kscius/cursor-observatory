export function applyRetention(db, config) {
  const days = Number(config.retention?.keepRawEventsDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return { pruned: 0, reason: "retention disabled" };

  const cutoff = `datetime('now', '-' || ? || ' days')`;
  const prunedEvents =
    db
      .prepare(`DELETE FROM events WHERE ts IS NOT NULL AND ts < ${cutoff}`)
      .run(days).changes ?? 0;
  const prunedPrompts =
    db
      .prepare(`DELETE FROM prompts WHERE ts IS NOT NULL AND ts < ${cutoff}`)
      .run(days).changes ?? 0;

  return { pruned: prunedEvents + prunedPrompts, prunedEvents, prunedPrompts, days };
}
