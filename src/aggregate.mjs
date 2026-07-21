import { queryAll, queryScalar, withTransaction } from "./db.mjs";
import { scoreBehaviorFromPrompts } from "./behavior.mjs";

export function rollupSessions(db) {
  db.exec(`DELETE FROM sessions`);

  const rows = queryAll(
    db,
    `SELECT
      conversation_id,
      MIN(ts) AS started_at,
      MAX(ts) AS ended_at,
      MAX(project) AS project,
      MAX(transcript_path) AS transcript_path,
      MAX(composer_mode) AS composer_mode,
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(input_tokens,0) ELSE 0 END) AS total_input_tokens,
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(output_tokens,0) ELSE 0 END) AS total_output_tokens,
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(cache_read_tokens,0) ELSE 0 END) AS total_cache_read,
      SUM(CASE WHEN event_type = 'stop' THEN 1 ELSE 0 END) AS generation_count,
      SUM(CASE WHEN event_type IN ('preToolUse','postToolUse','afterShellExecution') THEN 1 ELSE 0 END) AS tool_count,
      CASE
        WHEN SUM(CASE WHEN event_type = 'sessionEnd' THEN 1 ELSE 0 END) > 0
        THEN SUM(CASE WHEN event_type = 'sessionEnd' THEN COALESCE(duration_ms, 0) ELSE 0 END)
        ELSE NULL
      END AS duration_ms,
      SUM(CASE WHEN event_type = 'subagentStop' OR subagent_type IS NOT NULL THEN 1 ELSE 0 END) AS subagent_count
    FROM events
    WHERE NULLIF(conversation_id, '') IS NOT NULL
    GROUP BY conversation_id`
  );

  const modelStmt = db.prepare(
    `SELECT model, COUNT(*) AS c FROM events
     WHERE conversation_id = ? AND event_type = 'stop' AND model IS NOT NULL
     GROUP BY model ORDER BY c DESC LIMIT 1`
  );

  const promptStmt = db.prepare(
    `SELECT preview, detected_command FROM prompts
     WHERE conversation_id = ? ORDER BY prompt_idx ASC LIMIT 1`
  );

  const promptCountStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM prompts WHERE conversation_id = ?`
  );

  const insert = db.prepare(
    `INSERT INTO sessions (
      conversation_id, project, started_at, ended_at, duration_ms,
      model_primary, composer_mode, total_input_tokens, total_output_tokens,
      total_cache_read, generation_count, tool_count, prompt_count,
      subagent_count, first_prompt_preview, detected_command, transcript_path,
      archetype, fluency_score, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`
  );

  for (const r of rows) {
    const modelRow = modelStmt.get(r.conversation_id);
    const promptRow = promptStmt.get(r.conversation_id);
    const promptCountRow = promptCountStmt.get(r.conversation_id);

    const prompts = queryAll(
      db,
      `SELECT preview FROM prompts WHERE conversation_id = ? ORDER BY prompt_idx`,
      r.conversation_id
    );
    const behavior = scoreBehaviorFromPrompts(
      prompts.map((p) => p.preview),
      {
        toolCount: r.tool_count || 0,
        generationCount: r.generation_count || 0,
        subagentCount: r.subagent_count || 0,
      }
    );

    insert.run(
      r.conversation_id,
      r.project,
      r.started_at,
      r.ended_at,
      r.duration_ms,
      modelRow?.model || null,
      r.composer_mode,
      r.total_input_tokens || 0,
      r.total_output_tokens || 0,
      r.total_cache_read || 0,
      r.generation_count || 0,
      r.tool_count || 0,
      promptCountRow?.c || 0,
      r.subagent_count || 0,
      promptRow?.preview || null,
      promptRow?.detected_command || null,
      r.transcript_path,
      behavior.archetype,
      behavior.fluencyScore
    );
  }

  return rows.length;
}

export function rollupTimeBuckets(db) {
  db.exec(`DELETE FROM hourly_stats`);
  db.exec(`DELETE FROM daily_stats`);

  db.exec(`
    INSERT INTO hourly_stats (hour_key, project, model, event_count, generation_count, input_tokens, output_tokens, session_count)
    SELECT
      substr(ts, 1, 13) AS hour_key,
      COALESCE(project, '') AS project,
      COALESCE(model, '') AS model,
      COUNT(*) AS event_count,
      SUM(CASE WHEN event_type = 'stop' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(input_tokens,0) ELSE 0 END),
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(output_tokens,0) ELSE 0 END),
      COUNT(DISTINCT NULLIF(conversation_id, ''))
    FROM events
    WHERE ts IS NOT NULL
    GROUP BY hour_key, COALESCE(project,''), COALESCE(model,'')
  `);

  db.exec(`
    INSERT INTO daily_stats (day_key, project, model, event_count, generation_count, input_tokens, output_tokens, session_count, prompt_count)
    SELECT
      substr(ts, 1, 10) AS day_key,
      COALESCE(project, '') AS project,
      COALESCE(model, '') AS model,
      COUNT(*) AS event_count,
      SUM(CASE WHEN event_type = 'stop' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(input_tokens,0) ELSE 0 END),
      SUM(CASE WHEN event_type = 'stop' THEN COALESCE(output_tokens,0) ELSE 0 END),
      COUNT(DISTINCT NULLIF(conversation_id, '')),
      0
    FROM events
    WHERE ts IS NOT NULL
    GROUP BY day_key, COALESCE(project,''), COALESCE(model,'')
  `);

  db.exec(`
    UPDATE daily_stats SET prompt_count = (
      SELECT COUNT(*) FROM prompts p
      WHERE substr(COALESCE(p.ts, ''), 1, 10) = daily_stats.day_key
        AND COALESCE(p.project, '') = daily_stats.project
        AND EXISTS (
          SELECT 1 FROM events e
          WHERE e.conversation_id = p.conversation_id
            AND substr(COALESCE(e.ts, ''), 1, 10) = daily_stats.day_key
            AND COALESCE(e.project, '') = daily_stats.project
            AND COALESCE(e.model, '') = daily_stats.model
        )
    )
  `);
}

function aggregateToolCount(db, dayPrefix = null) {
  if (dayPrefix) {
    return (
      queryScalar(
        db,
        `SELECT COUNT(*) AS c FROM events
         WHERE event_type IN ('preToolUse','postToolUse','afterShellExecution')
           AND substr(COALESCE(ts,''),1,10) = ?`,
        dayPrefix
      )?.c || 0
    );
  }
  return (
    queryScalar(
      db,
      `SELECT COUNT(*) AS c FROM events
       WHERE event_type IN ('preToolUse','postToolUse','afterShellExecution')`
    )?.c || 0
  );
}

export function rollupBehavior(db) {
  db.exec(`DELETE FROM behavior_snapshots WHERE period = 'daily'`);

  const prompts = queryAll(db, `SELECT preview FROM prompts ORDER BY id`);
  // Match daily snapshots: distinct stop conversations (not tool-only sessions rows).
  const sessions =
    queryScalar(
      db,
      `SELECT COUNT(DISTINCT conversation_id) AS c
       FROM events
       WHERE event_type = 'stop'
         AND NULLIF(conversation_id, '') IS NOT NULL`
    )?.c || 0;
  const toolCount = aggregateToolCount(db);
  const overall = scoreBehaviorFromPrompts(
    prompts.map((p) => p.preview),
    { sessionCount: sessions, toolCount }
  );

  db.prepare(
    `INSERT INTO behavior_snapshots (
      period, period_key, fluency_score, archetype, briefing, verification,
      context_setting, iteration, toolcraft, real_prompt_count, session_count, computed_at
    ) VALUES ('all-time', 'all', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(period, period_key) DO UPDATE SET
      fluency_score = excluded.fluency_score,
      archetype = excluded.archetype,
      briefing = excluded.briefing,
      verification = excluded.verification,
      context_setting = excluded.context_setting,
      iteration = excluded.iteration,
      toolcraft = excluded.toolcraft,
      real_prompt_count = excluded.real_prompt_count,
      session_count = excluded.session_count,
      computed_at = excluded.computed_at`
  ).run(
    overall.fluencyScore,
    overall.archetype,
    overall.dimensions.briefing,
    overall.dimensions.verification,
    overall.dimensions.contextSetting,
    overall.dimensions.iteration,
    overall.dimensions.toolcraft,
    overall.realPromptCount,
    sessions
  );

  const days = queryAll(
    db,
    `SELECT DISTINCT substr(ts,1,10) AS day FROM prompts WHERE ts IS NOT NULL ORDER BY day DESC LIMIT 90`
  );

  for (const { day } of days) {
    const dayPrompts = queryAll(
      db,
      `SELECT preview FROM prompts WHERE substr(COALESCE(ts,''),1,10) = ?`,
      day
    );
    const dayTools = aggregateToolCount(db, day);
    const daySessions =
      queryScalar(
        db,
        `SELECT COUNT(DISTINCT conversation_id) AS c
         FROM events
         WHERE event_type = 'stop'
           AND NULLIF(conversation_id, '') IS NOT NULL
           AND substr(COALESCE(ts, ''), 1, 10) = ?`,
        day
      )?.c || 0;
    const b = scoreBehaviorFromPrompts(dayPrompts.map((p) => p.preview), {
      toolCount: dayTools,
      sessionCount: daySessions,
    });
    db.prepare(
      `INSERT INTO behavior_snapshots (
        period, period_key, fluency_score, archetype, briefing, verification,
        context_setting, iteration, toolcraft, real_prompt_count, session_count, computed_at
      ) VALUES ('daily', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(period, period_key) DO UPDATE SET
        fluency_score = excluded.fluency_score,
        archetype = excluded.archetype,
        briefing = excluded.briefing,
        verification = excluded.verification,
        context_setting = excluded.context_setting,
        iteration = excluded.iteration,
        toolcraft = excluded.toolcraft,
        real_prompt_count = excluded.real_prompt_count,
        session_count = excluded.session_count,
        computed_at = excluded.computed_at`
    ).run(
      day,
      b.fluencyScore,
      b.archetype,
      b.dimensions.briefing,
      b.dimensions.verification,
      b.dimensions.contextSetting,
      b.dimensions.iteration,
      b.dimensions.toolcraft,
      b.realPromptCount,
      daySessions
    );
  }
}

export function runAllRollups(db) {
  return withTransaction(db, () => {
    const sessions = rollupSessions(db);
    rollupTimeBuckets(db);
    rollupBehavior(db);
    return { sessions };
  });
}
