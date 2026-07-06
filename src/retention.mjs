export function applyRetention(db, config) {
  const days = Number(config.retention?.keepRawEventsDays ?? 0);
  if (!Number.isFinite(days) || days <= 0) return { pruned: 0, reason: "retention disabled" };

  const result = db
    .prepare(
      `DELETE FROM events WHERE ts IS NOT NULL AND ts < datetime('now', '-' || ? || ' days')`
    )
    .run(days);

  return { pruned: result.changes ?? 0, days };
}
