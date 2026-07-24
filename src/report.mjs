import fs from "node:fs";
import path from "node:path";
import { queryAll, queryScalar } from "./db.mjs";
import { scoreBehaviorFromPrompts } from "./behavior.mjs";
import { normalizeProjectPath, sanitizePreview, shortProjectName, projectPathContext } from "./parse.mjs";
import { buildDeterministicRecommendations } from "./recommend.mjs";
import { enrichWithLlm } from "./llm.mjs";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US");
}

function fmtCompact(n) {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 10_000) return (v / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return fmt(v);
}

function projectCell(project) {
  const full = normalizeProjectPath(project);
  const short = shortProjectName(project);
  const ctx = projectPathContext(project);
  return `<div class="project-cell">
    <span class="project-name" title="${esc(full)}">${esc(short)}</span>
    ${ctx ? `<span class="project-ctx" title="${esc(full)}">${esc(ctx)}</span>` : ""}
  </div>`;
}

function numCell(v, { compact = false } = {}) {
  const text = compact ? fmtCompact(v) : fmt(v);
  return `<td class="num" title="${esc(fmt(v))}">${text}</td>`;
}

function fluencyBand(score) {
  if (score >= 85) return "Expert";
  if (score >= 70) return "Advanced";
  if (score >= 55) return "Proficient";
  if (score >= 40) return "Developing";
  return "Operator";
}

function fluencyColor(band) {
  const map = {
    Expert: "#34d399",
    Advanced: "#5b9fff",
    Proficient: "#a78bfa",
    Developing: "#fbbf24",
    Operator: "#f87171",
  };
  return map[band] || "#5b9fff";
}

function confidenceLabel(n) {
  if (n < 10) return "low";
  if (n < 40) return "medium";
  return "high";
}

const SESSION_EVENT_CAP = 80;

export function buildSessionEventMap(db, sessions) {
  const ids = (sessions || []).map((s) => s.conversation_id).filter(Boolean);
  if (!ids.length) return {};

  const placeholders = ids.map(() => "?").join(",");
  const rows = queryAll(
    db,
    `SELECT conversation_id, ts, event_type, tool_name, model,
            input_tokens, output_tokens, command, prompt_preview, status, duration_ms
     FROM events
     WHERE conversation_id IN (${placeholders})
     ORDER BY ts IS NULL, ts ASC, id ASC`,
    ...ids
  );

  const map = Object.fromEntries(ids.map((id) => [id, []]));
  for (const row of rows) {
    const list = map[row.conversation_id];
    if (!list || list.length >= SESSION_EVENT_CAP) continue;
    list.push({
      ts: row.ts,
      type: row.event_type,
      tool: row.tool_name,
      model: row.model,
      input: row.input_tokens,
      output: row.output_tokens,
      command: row.command,
      preview: row.prompt_preview ? sanitizePreview(row.prompt_preview, 80) : null,
      status: row.status,
      duration_ms: row.duration_ms,
    });
  }
  return map;
}

export function buildJsonReport(db) {
  const totals = queryScalar(
    db,
    `SELECT
      COUNT(DISTINCT NULLIF(conversation_id, '')) AS sessions,
      COUNT(*) AS events,
      SUM(CASE WHEN event_type='stop' THEN COALESCE(input_tokens,0) ELSE 0 END) AS input_tokens,
      SUM(CASE WHEN event_type='stop' THEN COALESCE(output_tokens,0) ELSE 0 END) AS output_tokens,
      SUM(CASE WHEN event_type='stop' THEN COALESCE(cache_read_tokens,0) ELSE 0 END) AS cache_read_tokens,
      SUM(CASE WHEN event_type='stop' THEN COALESCE(cache_write_tokens,0) ELSE 0 END) AS cache_write_tokens,
      SUM(CASE WHEN event_type='toolFailure' THEN 1 ELSE 0 END) AS tool_failures,
      SUM(CASE WHEN subagent_type IS NOT NULL OR event_type='subagentStop' THEN 1 ELSE 0 END) AS subagent_events
    FROM events`
  );

  const behavior = queryScalar(
    db,
    `SELECT * FROM behavior_snapshots WHERE period='all-time' AND period_key='all'`
  );

  const liveBehavior = scoreBehaviorFromPrompts(
    queryAll(db, `SELECT preview FROM prompts ORDER BY id`).map((p) => p.preview),
    {
      toolCount:
        queryScalar(
          db,
          `SELECT COUNT(*) AS c FROM events
           WHERE event_type IN ('preToolUse','postToolUse','afterShellExecution')`
        )?.c || 0,
    }
  );

  const recentSessions = queryAll(
    db,
    `SELECT conversation_id, project, started_at, ended_at, model_primary,
            total_input_tokens, total_output_tokens, total_cache_read, prompt_count,
            generation_count, subagent_count, duration_ms,
            detected_command, archetype, fluency_score, first_prompt_preview,
            transcript_path
     FROM sessions
     ORDER BY COALESCE(ended_at, started_at) DESC
     LIMIT 50`
  );

  return {
    generatedAt: new Date().toISOString(),
    totals,
    behavior: {
      ...behavior,
      // Prefer rolled-up snapshot scores; fall back to live scoring when none yet.
      fluency_score: behavior?.fluency_score ?? liveBehavior.fluencyScore,
      archetype: behavior?.archetype ?? liveBehavior.archetype,
      confidence: liveBehavior.confidence,
      dimensions: liveBehavior.dimensions,
    },
    topProjects: queryAll(
      db,
      `SELECT project,
              COUNT(DISTINCT conversation_id) AS sessions,
              SUM(total_input_tokens) AS input_tokens,
              SUM(total_output_tokens) AS output_tokens,
              SUM(total_cache_read) AS cache_read
       FROM sessions
       WHERE project IS NOT NULL
       GROUP BY project
       ORDER BY input_tokens DESC
       LIMIT 20`
    ),
    topModels: queryAll(
      db,
      `SELECT model,
              COUNT(*) AS generations,
              SUM(COALESCE(input_tokens,0)) AS input_tokens,
              SUM(COALESCE(output_tokens,0)) AS output_tokens
       FROM events
       WHERE event_type='stop' AND model IS NOT NULL
       GROUP BY model
       ORDER BY input_tokens DESC`
    ),
    daily: queryAll(
      db,
      `SELECT day_key, input_tokens, output_tokens, sessions FROM (
         SELECT d.day_key,
                SUM(d.input_tokens) AS input_tokens,
                SUM(d.output_tokens) AS output_tokens,
                (SELECT COUNT(DISTINCT e.conversation_id)
                 FROM events e
                 WHERE e.event_type = 'stop'
                   AND e.conversation_id IS NOT NULL
                   AND substr(e.ts, 1, 10) = d.day_key) AS sessions
         FROM daily_stats d
         GROUP BY d.day_key
         ORDER BY d.day_key DESC
         LIMIT 30
       ) ORDER BY day_key ASC`
    ),
    hourlyToday: queryAll(
      db,
      `SELECT hour_key, SUM(input_tokens) AS input_tokens, SUM(event_count) AS events
       FROM hourly_stats
       WHERE hour_key LIKE ?
       GROUP BY hour_key
       ORDER BY hour_key`,
      `${new Date().toISOString().slice(0, 10)}%`
    ),
    behaviorTrend: queryAll(
      db,
      `SELECT day, fluency_score, archetype, real_prompt_count FROM (
         SELECT period_key AS day, fluency_score, archetype, real_prompt_count
         FROM behavior_snapshots
         WHERE period='daily'
         ORDER BY period_key DESC
         LIMIT 90
       ) ORDER BY day ASC`
    ),
    recentSessions,
    topTools: queryAll(
      db,
      `SELECT tool_name, COUNT(*) AS uses
       FROM events
       WHERE tool_name IS NOT NULL
         AND event_type != 'toolFailure'
       GROUP BY tool_name
       ORDER BY uses DESC
       LIMIT 15`
    ),
    toolFailures: queryAll(
      db,
      `SELECT tool_name, COUNT(*) AS failures,
              (
                SELECT e2.prompt_preview
                FROM events e2
                WHERE e2.event_type = 'toolFailure'
                  AND e2.tool_name IS e.tool_name
                ORDER BY e2.ts IS NULL, e2.ts DESC, e2.id DESC
                LIMIT 1
              ) AS last_error
       FROM events e
       WHERE event_type='toolFailure'
       GROUP BY tool_name
       ORDER BY failures DESC
       LIMIT 15`
    ),
    archetypeMix: queryAll(
      db,
      `SELECT archetype, COUNT(*) AS count
       FROM sessions
       WHERE archetype IS NOT NULL
       GROUP BY archetype
       ORDER BY count DESC`
    ),
    sessionEvents: buildSessionEventMap(db, recentSessions),
  };
}

function tableRows(rows, cols, emptyCols, rowAttrs) {
  if (!rows.length) {
    return `<tr><td colspan="${emptyCols}">No data</td></tr>`;
  }
  return rows
    .map((r, i) => {
      const attrs = rowAttrs ? rowAttrs(r, i) : "";
      const cells = cols.map((c) => (typeof c === "function" ? c(r, i) : c)).join("");
      return `<tr ${attrs}>${cells}</tr>`;
    })
    .join("");
}

function archetypePill(name) {
  if (!name || name === "—") return "—";
  const slug = String(name).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  return `<span class="pill pill-${slug}">${esc(name)}</span>`;
}

function recoSlug(title) {
  return String(title || "section")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function renderRecommendationCard(section) {
  if (!section) return "";
  const slug = recoSlug(section.title);
  const metricsHtml = (section.metrics || [])
    .map(
      (m) =>
        `<div class="reco-metric" title="${esc(m.hint || "")}">
          <span class="reco-metric-label">${esc(m.label)}</span>
          <span class="reco-metric-value">${esc(String(m.value ?? "—"))}</span>
          ${m.hint ? `<span class="reco-metric-hint">${esc(m.hint)}</span>` : ""}
        </div>`
    )
    .join("");
  const insights = (Array.isArray(section.insights) ? section.insights : [])
    .filter((i) => typeof i === "string")
    .map((i) => `<li>${esc(i)}</li>`)
    .join("");
  const actions = (Array.isArray(section.actions) ? section.actions : [])
    .filter((a) => typeof a === "string")
    .map((a) => `<li>${esc(a)}</li>`)
    .join("");
  const llmActions = (Array.isArray(section.llmActions) ? section.llmActions : [])
    .filter((a) => typeof a === "string")
    .map((a) => `<li>${esc(a)}</li>`)
    .join("");

  return `<aside class="reco-card" aria-labelledby="reco-${slug}">
    <div class="reco-header">
      <h3 id="reco-${slug}">Guide &amp; recommendations</h3>
      <button type="button" class="reco-toggle" aria-expanded="true" aria-controls="reco-body-${slug}">Hide</button>
    </div>
    <div class="reco-body" id="reco-body-${slug}">
      <p class="reco-explain">${esc(section.explain || "")}</p>
      ${metricsHtml ? `<div class="reco-metrics" role="list">${metricsHtml}</div>` : ""}
      ${insights ? `<div class="reco-block"><strong>Insights</strong><ul class="reco-list">${insights}</ul></div>` : ""}
      ${actions ? `<div class="reco-block"><strong>Suggested actions</strong><ul class="reco-list reco-actions">${actions}</ul></div>` : ""}
      ${
        section.llmSummary
          ? `<div class="reco-block reco-llm-wrap"><strong>AI coach</strong><p class="reco-llm">${esc(section.llmSummary)}</p>${llmActions ? `<ul class="reco-list reco-actions llm">${llmActions}</ul>` : ""}</div>`
          : ""
      }
    </div>
  </aside>`;
}

export async function buildFullReport(db, config = {}, { withLlm = false } = {}) {
  const data = buildJsonReport(db);
  const llmOn = Boolean(withLlm || config.recommendations?.llm?.enabled);
  // `--with-llm` / llm.enabled still produce coaching even when guide cards are disabled
  if (config.recommendations?.enabled === false && !llmOn) return data;

  let recs = buildDeterministicRecommendations(data);
  if (llmOn) {
    const llmConfig = {
      ...(config.recommendations?.llm || {}),
      enabled: true,
      cacheDir: config.dataDir,
    };
    recs = await enrichWithLlm(data, recs, llmConfig);
  }
  data.recommendations = recs;
  return data;
}

export function buildHtmlReport(data) {
  const b = data.behavior || {};
  const rec = data.recommendations?.sections || {};
  const recoOverview = renderRecommendationCard(rec.overview);
  const recoUsage = renderRecommendationCard(rec.usage);
  const recoBehavior = renderRecommendationCard(rec.behavior);
  const recoSessions = renderRecommendationCard(rec.sessions);
  const recoTools = renderRecommendationCard(rec.tools);
  const score = Math.round(b.fluency_score ?? liveScore(data) ?? 50);
  const band = fluencyBand(score);
  const scoreColor = fluencyColor(band);
  const conf = b.confidence || confidenceLabel(b.real_prompt_count || 0);

  const inputTok = data.totals?.input_tokens || 0;
  const outputTok = data.totals?.output_tokens || 0;
  const cacheRead = data.totals?.cache_read_tokens || 0;
  const ratioLabel = outputTok > 0 ? `${(inputTok / outputTok).toFixed(1)}:1` : "—";

  const projectRows = tableRows(
    data.topProjects,
    [
      (p) => `<td class="project-col">${projectCell(p.project)}</td>`,
      (p) => numCell(p.sessions),
      (p) => numCell(p.input_tokens, { compact: true }),
      (p) => numCell(p.output_tokens, { compact: true }),
      (p) => numCell(p.cache_read, { compact: true }),
    ],
    5,
    (p, i) => `class="project-row" data-index="${i}" data-project="${esc(normalizeProjectPath(p.project || ""))}" tabindex="0" title="Filter sessions by this project"`
  );

  const modelRows = tableRows(
    data.topModels,
    [
      (m) => `<td><span class="model-name" title="${esc(m.model)}">${esc(m.model)}</span></td>`,
      (m) => numCell(m.generations),
      (m) => numCell(m.input_tokens, { compact: true }),
      (m) => numCell(m.output_tokens, { compact: true }),
    ],
    4
  );

  const sessionRowsDesktop = tableRows(
    data.recentSessions,
    [
      (s) => {
        const id = s.conversation_id || "";
        return `<td><button type="button" class="id-btn" data-copy="${esc(id)}" title="Copy ${esc(id)}">${esc(id.slice(0, 8))}</button></td>`;
      },
      (s) => `<td class="project-col">${projectCell(s.project)}</td>`,
      (s) => `<td class="nowrap">${esc((s.started_at || "").slice(0, 10))}</td>`,
      (s) => `<td><span class="model-name" title="${esc(s.model_primary)}">${esc((s.model_primary || "—").slice(0, 22))}</span></td>`,
      (s) => numCell(s.total_input_tokens, { compact: true }),
      (s) => numCell(s.total_output_tokens, { compact: true }),
      (s) => numCell(s.prompt_count),
      (s) => `<td class="num">${esc(s.fluency_score != null ? Math.round(s.fluency_score) : "—")}</td>`,
      (s) => `<td>${archetypePill(s.archetype)}</td>`,
      (s) => `<td class="hide-mobile">${s.detected_command ? `<span class="cmd">/${esc(s.detected_command)}</span>` : "—"}</td>`,
      (s) => `<td class="preview-col">${esc(sanitizePreview(s.first_prompt_preview, 50))}</td>`,
    ],
    11,
    (s, i) =>
      `class="session-row" data-index="${i}" data-project="${esc(normalizeProjectPath(s.project || ""))}" tabindex="0"`
  );

  const toolRows = tableRows(
    data.topTools,
    [(t) => `<td>${esc(t.tool_name)}</td>`, (t) => numCell(t.uses)],
    2
  );

  const failRows = tableRows(
    data.toolFailures,
    [
      (t) => `<td>${esc(t.tool_name || "unknown")}</td>`,
      (t) => numCell(t.failures),
      (t) => `<td class="preview-col">${esc(sanitizePreview(t.last_error, 80))}</td>`,
    ],
    3
  );

  const dim = (v) => Math.round((v || 0) * 100);
  const dims = b.dimensions || {};
  const dimBars = [
    ["Briefing", dims.briefing ?? b.briefing],
    ["Verification", dims.verification ?? b.verification],
    ["Context", dims.context_setting ?? b.context_setting ?? dims.contextSetting],
    ["Iteration", dims.iteration ?? b.iteration],
    ["Toolcraft", dims.toolcraft ?? b.toolcraft],
  ]
    .map(
      ([label, val]) =>
        `<div class="bar" role="group" aria-label="${label}">
          <span>${label}</span>
          <div role="progressbar" aria-valuenow="${dim(val)}" aria-valuemin="0" aria-valuemax="100">
            <i style="width:${dim(val)}%;background:${scoreColor}"></i>
          </div>
          <span>${dim(val)}%</span>
        </div>`
    )
    .join("");

  const jsonEmbed = JSON.stringify(data).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cursor Observatory</title>
<script>(function(){var t=localStorage.getItem('observatory-theme');if(t)document.documentElement.setAttribute('data-theme',t);})();</script>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg:#080c16; --surface:#0f1525; --surface-2:#161e32; --surface-hover:#1c2640;
  --border:#2a3555; --text:#e8ecff; --muted:#94a3c4; --accent:#5b9fff; --accent-dim:#3d6fbf;
  --nav-bg:rgba(8,12,22,0.94); --row-stripe:rgba(255,255,255,0.02); --danger:#f87171; --ok:#34d399;
}
[data-theme="light"] {
  --bg:#f1f5f9; --surface:#ffffff; --surface-2:#eef2f8; --surface-hover:#e2e8f0;
  --border:#cbd5e1; --text:#0f172a; --muted:#475569; --accent:#2563eb; --accent-dim:#1d4ed8;
  --nav-bg:rgba(241,245,249,0.96); --row-stripe:rgba(0,0,0,0.025); --danger:#dc2626; --ok:#059669;
}
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body {
  margin:0; font:15px/1.6 "DM Sans",system-ui,sans-serif;
  background:var(--bg); color:var(--text);
  background-image:radial-gradient(ellipse 80% 50% at 50% -20%, rgba(91,159,255,0.08), transparent);
}
[data-theme="light"] body {
  background-image:radial-gradient(ellipse 80% 50% at 50% -20%, rgba(37,99,235,0.06), transparent);
}
a { color:var(--accent); }
.wrap { max-width:1280px; margin:0 auto; padding:24px; }
nav.top {
  position:sticky; top:0; z-index:50;
  background:var(--nav-bg); backdrop-filter:blur(10px);
  border-bottom:1px solid var(--border);
  margin:-24px -24px 24px; padding:12px 24px;
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
}
nav.top h1 { font-size:17px; font-weight:700; margin:0; flex:1; min-width:160px; letter-spacing:-0.02em; }
nav.top a {
  color:var(--muted); text-decoration:none; font-size:13px; font-weight:500;
  padding:6px 12px; border-radius:6px; transition:background .15s,color .15s; cursor:pointer;
}
nav.top a:hover, nav.top a:focus-visible, nav.top a.active {
  background:var(--surface-2); color:var(--text); outline:none;
}
nav.top a.active { color:var(--accent); box-shadow:inset 0 -2px 0 var(--accent); }
.theme-toggle {
  font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid var(--border);
  background:var(--surface-2); color:var(--muted); cursor:pointer; transition:background .15s,color .15s;
}
.theme-toggle:hover, .theme-toggle:focus-visible {
  background:var(--surface-hover); color:var(--text); outline:2px solid var(--accent); outline-offset:1px;
}
.meta-bar { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin-bottom:8px; }
.mut { color:var(--muted); font-size:13px; }
.grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); margin:16px 0; }
.grid-2 { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); margin:16px 0; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; }
.card h2 { margin:0 0 4px; font-size:15px; font-weight:600; letter-spacing:-0.01em; }
.card .card-desc { margin:0 0 14px; font-size:12px; color:var(--muted); }
.section-head { margin:0 0 16px; padding-bottom:12px; border-bottom:1px solid var(--border); }
.section-head h2 { font-size:20px; font-weight:700; margin:0 0 4px; letter-spacing:-0.02em; }
.section-head p { margin:0; font-size:13px; color:var(--muted); }
.score { font-size:38px; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; }
.score-sub { font-size:13px; color:var(--muted); margin-top:4px; }
.badge { display:inline-block; font-size:10px; text-transform:uppercase; letter-spacing:.05em; padding:2px 7px; border-radius:4px; background:var(--surface-2); color:var(--muted); margin-left:6px; }
table.data { width:100%; border-collapse:collapse; font-size:13px; }
.table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; max-height:480px; overflow-y:auto; border-radius:8px; border:1px solid var(--border); }
table.data th, table.data td { padding:10px 14px; border-bottom:1px solid var(--border); vertical-align:middle; }
table.data th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; white-space:nowrap; position:sticky; top:0; background:var(--surface-2); z-index:1; text-align:left; }
table.data th.sortable { cursor:pointer; user-select:none; transition:color .15s; }
table.data th.sortable:hover, table.data th.sortable:focus-visible { color:var(--text); outline:none; }
table.data th.sortable.sort-asc::after { content:' ↑'; color:var(--accent); }
table.data th.sortable.sort-desc::after { content:' ↓'; color:var(--accent); }
table.data th.num, table.data td.num { text-align:right; font-variant-numeric:tabular-nums; font-family:"JetBrains Mono",monospace; font-size:12px; }
table.data tbody tr:nth-child(even) { background:var(--row-stripe); }
table.data tbody tr:hover { background:var(--surface-hover); }
table.data tbody tr.selected { background:rgba(91,159,255,0.12); outline:1px solid var(--accent-dim); }
.project-col { max-width:220px; min-width:140px; }
.project-cell { display:flex; flex-direction:column; gap:2px; }
.project-name { font-weight:600; font-size:13px; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; display:block; }
.project-ctx { font-size:11px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px; display:block; font-family:"JetBrains Mono",monospace; }
.model-name { font-size:12px; font-family:"JetBrains Mono",monospace; }
.preview-col { max-width:200px; font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.nowrap { white-space:nowrap; }
.num { text-align:right; font-variant-numeric:tabular-nums; font-family:"JetBrains Mono",monospace; font-size:12px; }
.id-btn {
  font-family:"JetBrains Mono",monospace; font-size:11px; background:var(--surface-2);
  border:1px solid var(--border); color:var(--accent); padding:3px 8px; border-radius:4px;
  cursor:pointer; transition:background .15s,border-color .15s;
}
.id-btn:hover, .id-btn:focus-visible { background:var(--surface-hover); border-color:var(--accent); outline:none; }
.pill { display:inline-block; font-size:11px; font-weight:500; padding:2px 8px; border-radius:999px; background:var(--surface-2); border:1px solid var(--border); white-space:nowrap; }
.pill-debugger { border-color:#f8717144; color:#fca5a5; }
.pill-collaborator { border-color:#5b9fff44; color:#93c5fd; }
.pill-architect { border-color:#a78bfa44; color:#c4b5fd; }
.pill-sprinter { border-color:#fbbf2444; color:#fcd34d; }
.pill-autonomous-agent { border-color:#34d39944; color:#6ee7b7; }
.cmd { font-family:"JetBrains Mono",monospace; font-size:11px; color:var(--accent); background:rgba(91,159,255,0.1); padding:2px 6px; border-radius:4px; }
.bar { display:flex; gap:10px; align-items:center; margin:10px 0; }
.bar > span:first-child { width:90px; color:var(--muted); font-size:12px; flex-shrink:0; }
.bar > span:last-child { width:36px; text-align:right; font-size:12px; color:var(--muted); font-family:"JetBrains Mono",monospace; }
.bar > div { flex:1; height:8px; background:var(--border); border-radius:4px; overflow:hidden; }
.bar > div > i { display:block; height:100%; border-radius:4px; transition:width .3s; }
.chart-box { position:relative; height:240px; }
section { scroll-margin-top:80px; margin-bottom:40px; }
.toolbar { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:12px; align-items:center; }
.toolbar input {
  flex:1; min-width:180px; max-width:320px; padding:8px 12px; border-radius:6px;
  border:1px solid var(--border); background:var(--surface-2); color:var(--text); font-size:13px;
}
.toolbar input:focus { outline:2px solid var(--accent); outline-offset:0; border-color:var(--accent); }
.toolbar input::placeholder { color:var(--muted); }
.toolbar .filter-tag {
  font-size:12px; padding:4px 10px; border-radius:999px; background:rgba(91,159,255,0.15);
  color:var(--accent); border:1px solid var(--accent-dim); cursor:pointer;
}
.toolbar .filter-tag:hover { background:rgba(91,159,255,0.25); }
.detail-panel {
  display:none; margin-top:16px; padding:16px; border-radius:8px;
  background:var(--surface-2); border:1px solid var(--border);
}
.detail-panel.open { display:block; }
.detail-panel h3 { margin:0 0 12px; font-size:14px; font-weight:600; }
.detail-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:12px; }
.detail-item label { display:block; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin-bottom:2px; }
.detail-item span, .detail-item code { font-size:13px; word-break:break-all; }
.detail-preview { font-size:13px; line-height:1.5; color:var(--muted); padding:12px; background:var(--surface); border-radius:6px; border:1px solid var(--border); margin-top:8px; }
.timeline-wrap { margin-top:16px; }
.timeline-wrap h4 { margin:0 0 8px; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
.timeline {
  max-height:320px; overflow-y:auto; border:1px solid var(--border); border-radius:8px;
  background:var(--surface);
}
.timeline-item {
  display:grid; grid-template-columns:72px 100px 1fr auto; gap:10px; align-items:start;
  padding:10px 14px; border-bottom:1px solid var(--border); font-size:12px;
}
.timeline-item:last-child { border-bottom:none; }
.timeline-time { font-family:"JetBrains Mono",monospace; color:var(--muted); font-size:11px; white-space:nowrap; }
.timeline-type { font-weight:600; color:var(--accent); text-transform:capitalize; }
.timeline-type.type-toolFailure { color:var(--danger); }
.timeline-type.type-stop { color:var(--ok); }
.timeline-detail { color:var(--muted); line-height:1.4; word-break:break-word; }
.timeline-meta { font-family:"JetBrains Mono",monospace; font-size:10px; color:var(--muted); white-space:nowrap; }
.timeline-empty { padding:16px; text-align:center; color:var(--muted); font-size:13px; }
.detail-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
.btn {
  font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid var(--border);
  background:var(--surface); color:var(--text); cursor:pointer; transition:background .15s;
}
.btn:hover, .btn:focus-visible { background:var(--surface-hover); outline:2px solid var(--accent); outline-offset:1px; }
.btn-primary { background:var(--accent-dim); border-color:var(--accent); color:#fff; }
footer { margin-top:48px; padding-top:16px; border-top:1px solid var(--border); color:var(--muted); font-size:12px; }
.collapsible summary { cursor:pointer; font-weight:600; font-size:15px; padding:4px 0; list-style:none; display:flex; align-items:center; gap:8px; }
.collapsible summary::-webkit-details-marker { display:none; }
.collapsible summary::before { content:"▸"; color:var(--muted); transition:transform .15s; }
.collapsible[open] summary::before { transform:rotate(90deg); }
.reco-card {
  margin:0 0 20px; padding:16px 18px; border-radius:10px;
  background:linear-gradient(135deg, rgba(91,159,255,0.08), rgba(22,30,50,0.95));
  border:1px solid rgba(91,159,255,0.25);
}
.reco-header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
.reco-header h3 { margin:0; font-size:14px; font-weight:600; color:var(--accent); letter-spacing:-0.01em; }
.reco-toggle {
  font-size:11px; padding:4px 10px; border-radius:6px; border:1px solid var(--border);
  background:var(--surface); color:var(--muted); cursor:pointer; transition:background .15s,color .15s;
}
.reco-toggle:hover, .reco-toggle:focus-visible { background:var(--surface-hover); color:var(--text); outline:2px solid var(--accent); outline-offset:1px; }
.reco-body.collapsed { display:none; }
.reco-explain { margin:0 0 12px; font-size:13px; line-height:1.55; color:var(--muted); }
.reco-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-bottom:12px; }
.reco-metric {
  padding:10px 12px; border-radius:8px; background:var(--surface); border:1px solid var(--border);
  display:flex; flex-direction:column; gap:2px;
}
.reco-metric-label { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.reco-metric-value { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--text); }
.reco-metric-hint { font-size:11px; color:var(--muted); line-height:1.35; }
.reco-block { margin-top:12px; }
.reco-block strong { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:6px; }
.reco-list { margin:0; padding-left:18px; font-size:13px; line-height:1.55; color:var(--text); }
.reco-list li { margin:4px 0; }
.reco-list.reco-actions li { color:#93c5fd; }
.reco-llm-wrap { padding-top:12px; border-top:1px dashed var(--border); margin-top:14px; }
.reco-llm { margin:6px 0 0; font-size:13px; line-height:1.55; color:var(--text); font-style:italic; }
@media (max-width:768px) {
  .hide-mobile { display:none; }
  .score { font-size:28px; }
  .project-col { max-width:120px; }
  .timeline-item { grid-template-columns:1fr; gap:4px; }
  .timeline-meta { grid-column:1; }
}
@media (prefers-reduced-motion:reduce) {
  html { scroll-behavior:auto; }
  .bar > div > i { transition:none; }
}
</style>
</head>
<body>
<div class="wrap">
  <nav class="top" aria-label="Dashboard sections">
    <h1>Cursor Observatory</h1>
    <a href="#overview">Overview</a>
    <a href="#usage">Usage</a>
    <a href="#behavior">Behavior</a>
    <a href="#sessions">Sessions</a>
    <a href="#tools">Tools</a>
    <button type="button" class="theme-toggle" id="themeToggle" aria-label="Toggle light or dark theme">Theme</button>
  </nav>

  <div class="meta-bar">
    <p class="mut">Local analytics — how much, where, and how you work.</p>
    <span class="mut">Updated ${esc(new Date(data.generatedAt).toLocaleString())}</span>
  </div>

  <section id="overview">
    <div class="section-head">
      <h2>Overview</h2>
      <p>Token volume, sessions, and today's activity at a glance.</p>
    </div>
    ${recoOverview}
    <div class="grid">
      <div class="card">
        <div class="mut">AI Fluency</div>
        <div class="score" style="color:${scoreColor}">${score}</div>
        <div class="score-sub">${band} · ${esc(b.archetype || "—")}<span class="badge">${esc(conf)} confidence</span></div>
      </div>
      <div class="card"><div class="mut">Sessions</div><div class="score" style="font-size:28px;color:var(--accent)">${fmt(data.totals?.sessions)}</div></div>
      <div class="card"><div class="mut">Events</div><div class="score" style="font-size:28px;color:var(--accent)">${fmt(data.totals?.events)}</div></div>
      <div class="card"><div class="mut">Input tokens</div><div class="score" style="font-size:28px" title="${fmt(inputTok)}">${fmtCompact(inputTok)}</div></div>
      <div class="card"><div class="mut">Output tokens</div><div class="score" style="font-size:28px" title="${fmt(outputTok)}">${fmtCompact(outputTok)}</div></div>
      <div class="card"><div class="mut">Cache read</div><div class="score" style="font-size:28px" title="${fmt(cacheRead)}">${fmtCompact(cacheRead)}</div></div>
      <div class="card"><div class="mut">In:Out ratio</div><div class="score" style="font-size:28px">${ratioLabel}</div></div>
      <div class="card"><div class="mut">Tool failures</div><div class="score" style="font-size:28px;color:${(data.totals?.tool_failures||0)>0?'#f87171':'var(--accent)'}">${fmt(data.totals?.tool_failures)}</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Today by hour</h2>
        <div class="chart-box"><canvas id="chartHourly" aria-label="Hourly token usage today"></canvas></div>
      </div>
      <div class="card">
        <h2>Daily usage (30 days)</h2>
        <div class="chart-box"><canvas id="chartDaily" aria-label="Daily token usage"></canvas></div>
      </div>
    </div>
  </section>

  <section id="usage">
    <div class="section-head">
      <h2>Usage</h2>
      <p>Where tokens go — projects and models. Click a project row to filter sessions below.</p>
    </div>
    ${recoUsage}
    <div class="grid-2">
      <div class="card">
        <h2>Top projects</h2>
        <p class="card-desc">By input tokens — hover for full path</p>
        <div class="chart-box" style="height:280px"><canvas id="chartProjects"></canvas></div>
      </div>
      <div class="card">
        <h2>Models</h2>
        <p class="card-desc">Token share by model</p>
        <div class="chart-box" style="height:280px"><canvas id="chartModels"></canvas></div>
      </div>
    </div>
    <details class="card collapsible" open style="margin-top:16px">
      <summary>Project breakdown (table)</summary>
      <div class="table-wrap" style="margin-top:12px">
        <table class="data" id="projectTable">
          <thead><tr>
            <th scope="col" class="sortable" data-sort="project">Project</th>
            <th scope="col" class="sortable num" data-sort="sessions">Sessions</th>
            <th scope="col" class="sortable num" data-sort="input_tokens">Input</th>
            <th scope="col" class="sortable num" data-sort="output_tokens">Output</th>
            <th scope="col" class="sortable num" data-sort="cache_read">Cache</th>
          </tr></thead>
          <tbody>${projectRows}</tbody>
        </table>
      </div>
    </details>
    <details class="card collapsible" style="margin-top:16px">
      <summary>Model breakdown (table)</summary>
      <div class="table-wrap" style="margin-top:12px">
        <table class="data">
          <thead><tr>
            <th scope="col">Model</th>
            <th scope="col" class="num">Generations</th>
            <th scope="col" class="num">Input</th>
            <th scope="col" class="num">Output</th>
          </tr></thead>
          <tbody>${modelRows}</tbody>
        </table>
      </div>
    </details>
  </section>

  <section id="behavior">
    <div class="section-head">
      <h2>Behavior</h2>
      <p>How you brief, verify, and iterate — fluency dimensions over time.</p>
    </div>
    ${recoBehavior}
    <div class="grid-2">
      <div class="card">
        <h2>Behavior dimensions</h2>
        ${dimBars}
        <p class="mut">${fmt(b.real_prompt_count)} real prompts analyzed</p>
      </div>
      <div class="card">
        <h2>Fluency trend</h2>
        <div class="chart-box"><canvas id="chartBehavior"></canvas></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Session archetypes</h2>
      <div class="chart-box" style="height:200px"><canvas id="chartArchetypes"></canvas></div>
    </div>
  </section>

  <section id="sessions">
    <div class="section-head">
      <h2>Sessions</h2>
      <p>Recent chats — click a row for full trace. Use search or filter by project.</p>
    </div>
    ${recoSessions}
    <div class="card">
      <div class="toolbar">
        <input type="search" id="sessionSearch" placeholder="Search project, model, prompt…" aria-label="Filter sessions"/>
        <span class="filter-tag" id="clearFilter" style="display:none" title="Clear project filter">Clear filter</span>
        <button type="button" class="btn" id="exportSessionsCsv">Export CSV</button>
      </div>
      <div class="table-wrap">
        <table class="data" id="sessionTable">
          <thead><tr>
            <th scope="col" class="sortable" data-sort="conversation_id">Chat</th>
            <th scope="col" class="sortable" data-sort="project">Project</th>
            <th scope="col" class="sortable" data-sort="started_at">Date</th>
            <th scope="col" class="sortable" data-sort="model_primary">Model</th>
            <th scope="col" class="sortable num" data-sort="total_input_tokens">In</th>
            <th scope="col" class="sortable num" data-sort="total_output_tokens">Out</th>
            <th scope="col" class="sortable num" data-sort="prompt_count">Prompts</th>
            <th scope="col" class="sortable num" data-sort="fluency_score">Score</th>
            <th scope="col" class="sortable" data-sort="archetype">Archetype</th>
            <th scope="col" class="hide-mobile sortable" data-sort="detected_command">Cmd</th>
            <th scope="col" class="sortable" data-sort="first_prompt_preview">Preview</th>
          </tr></thead>
          <tbody>${sessionRowsDesktop}</tbody>
        </table>
      </div>
      <div class="detail-panel" id="sessionDetail" aria-live="polite">
        <h3>Session trace</h3>
        <div class="detail-grid" id="detailGrid"></div>
        <div class="detail-preview" id="detailPreview"></div>
        <div class="timeline-wrap" id="timelineWrap">
          <h4>Event timeline</h4>
          <div class="timeline" id="sessionTimeline" role="log" aria-live="polite"></div>
        </div>
        <div class="detail-actions">
          <button type="button" class="btn btn-primary" id="copyIdBtn">Copy chat ID</button>
          <button type="button" class="btn" id="copyTranscriptBtn" style="display:none">Copy transcript path</button>
        </div>
      </div>
    </div>
  </section>

  <section id="tools">
    <div class="section-head">
      <h2>Tools</h2>
      <p>Agent tool usage and failure rates.</p>
    </div>
    ${recoTools}
    <div class="grid-2">
      <div class="card">
        <h2>Top tools</h2>
        <div class="table-wrap">
          <table class="data"><thead><tr><th scope="col">Tool</th><th scope="col" class="num">Uses</th></tr></thead><tbody>${toolRows}</tbody></table>
        </div>
      </div>
      <div class="card">
        <h2>Tool failures</h2>
        <div class="table-wrap">
          <table class="data"><thead><tr><th scope="col">Tool</th><th scope="col" class="num">Failures</th><th scope="col">Last error</th></tr></thead><tbody>${failRows}</tbody></table>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h2>Tool usage chart</h2>
      <div class="chart-box"><canvas id="chartTools"></canvas></div>
    </div>
  </section>

  <footer>Generated locally by cursor-observatory. Telemetry stays on this machine; the report may load Chart.js/fonts from public CDNs.</footer>
</div>
<script>
window.__REPORT__ = ${jsonEmbed};
(function(){
  const d = window.__REPORT__;
  const grid = '#2a3555';
  const muted = '#8b9bc4';
  const accent = '#5b9fff';
  const ok = '#34d399';
  const purple = '#a78bfa';

  // Charts are optional — CDN may be blocked offline; keep tables/filters working.
  const hasChart = typeof Chart !== 'undefined';
  if (hasChart) {
    Chart.defaults.color = muted;
    Chart.defaults.borderColor = grid;
    Chart.defaults.font.family = '"DM Sans", system-ui, sans-serif';

    const hourly = d.hourlyToday || [];
    new Chart(document.getElementById('chartHourly'), {
      type: 'bar',
      data: {
        labels: hourly.map(h => (h.hour_key || '').slice(11, 13) + ':00'),
        datasets: [{ label: 'Input tokens', data: hourly.map(h => h.input_tokens || 0), backgroundColor: accent }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    const daily = d.daily || [];
    new Chart(document.getElementById('chartDaily'), {
      type: 'line',
      data: {
        labels: daily.map(x => x.day_key),
        datasets: [
          { label: 'Input', data: daily.map(x => x.input_tokens || 0), borderColor: accent, tension: 0.3, fill: false },
          { label: 'Output', data: daily.map(x => x.output_tokens || 0), borderColor: ok, tension: 0.3, fill: false },
          { label: 'Sessions', data: daily.map(x => x.sessions || 0), borderColor: purple, tension: 0.3, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { beginAtZero: true }, y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false } } }
      }
    });

    const projects = (d.topProjects || []).slice(0, 10);
    new Chart(document.getElementById('chartProjects'), {
      type: 'bar',
      data: {
        labels: projects.map(p => (p.project || '').split(/[\\\\/]/).pop() || '?'),
        datasets: [{ label: 'Input tokens', data: projects.map(p => p.input_tokens || 0), backgroundColor: accent }]
      },
      options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    const models = d.topModels || [];
    new Chart(document.getElementById('chartModels'), {
      type: 'doughnut',
      data: {
        labels: models.map(m => m.model),
        datasets: [{ data: models.map(m => m.input_tokens || 0), backgroundColor: [accent, ok, purple, '#fbbf24', '#f87171'] }]
      },
      options: { responsive: true, maintainAspectRatio: false }
    });

    const trend = d.behaviorTrend || [];
    new Chart(document.getElementById('chartBehavior'), {
      type: 'line',
      data: {
        labels: trend.map(t => t.day),
        datasets: [{ label: 'Fluency', data: trend.map(t => t.fluency_score || 0), borderColor: ok, tension: 0.3, fill: false }]
      },
      options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } }
    });

    const arch = d.archetypeMix || [];
    new Chart(document.getElementById('chartArchetypes'), {
      type: 'bar',
      data: {
        labels: arch.map(a => a.archetype),
        datasets: [{ label: 'Sessions', data: arch.map(a => a.count), backgroundColor: purple }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });

    const tools = (d.topTools || []).slice(0, 10);
    new Chart(document.getElementById('chartTools'), {
      type: 'bar',
      data: {
        labels: tools.map(t => t.tool_name),
        datasets: [{ label: 'Uses', data: tools.map(t => t.uses), backgroundColor: accent }]
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }

  // ——— Interactivity: nav, filter, session trace ———
  const sessions = d.recentSessions || [];
  const sessionEvents = d.sessionEvents || {};
  let projectFilter = '';
  let selectedIdx = -1;

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next === 'light' ? 'light' : '');
    localStorage.setItem('observatory-theme', next);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = next === 'light' ? 'Dark' : 'Light';
    if (hasChart) {
      const muted = next === 'light' ? '#475569' : '#8b9bc4';
      const grid = next === 'light' ? '#cbd5e1' : '#2a3555';
      Chart.defaults.color = muted;
      Chart.defaults.borderColor = grid;
      document.querySelectorAll('canvas').forEach(canvas => {
        const chart = Chart.getChart(canvas);
        if (chart) chart.update();
      });
    }
  }

  applyTheme(getTheme());
  document.getElementById('themeToggle').addEventListener('click', () => {
    applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  });

  const navLinks = document.querySelectorAll('nav.top a');
  const sections = [...navLinks].map(a => document.querySelector(a.getAttribute('href'))).filter(Boolean);
  const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
      }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });
  sections.forEach(s => obs.observe(s));

  function fmtN(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    const t = String(ts);
    return t.length >= 16 ? t.slice(11, 16) : t.slice(0, 8);
  }

  function eventDetail(ev) {
    const parts = [];
    if (ev.tool) parts.push(ev.tool);
    if (ev.command) parts.push(ev.command.slice(0, 60));
    if (ev.preview) parts.push(ev.preview);
    if (ev.model && ev.type === 'stop') parts.push(ev.model);
    return parts.join(' · ') || '—';
  }

  function eventMeta(ev) {
    const bits = [];
    if (ev.input != null) bits.push('in ' + fmtN(ev.input));
    if (ev.output != null) bits.push('out ' + fmtN(ev.output));
    if (ev.duration_ms != null) bits.push(ev.duration_ms + 'ms');
    return bits.join(' ');
  }

  function renderTimeline(convId) {
    const el = document.getElementById('sessionTimeline');
    const events = sessionEvents[convId] || [];
    if (!events.length) {
      el.innerHTML = '<div class="timeline-empty">No hook events ingested for this chat yet.</div>';
      return;
    }
    el.innerHTML = events.map(ev => {
      const slug = (ev.type || 'event').replace(/[^a-zA-Z0-9]/g, '');
      return '<div class="timeline-item">' +
        '<span class="timeline-time" title="' + escHtml(ev.ts || '') + '">' + escHtml(fmtTime(ev.ts)) + '</span>' +
        '<span class="timeline-type type-' + slug + '">' + escHtml(ev.type || 'event') + '</span>' +
        '<span class="timeline-detail">' + escHtml(eventDetail(ev)) + '</span>' +
        '<span class="timeline-meta">' + escHtml(eventMeta(ev)) + '</span>' +
      '</div>';
    }).join('');
  }

  function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportSessionsCsv() {
    const visible = [...document.querySelectorAll('.session-row')].filter(r => r.style.display !== 'none');
    const columns = [
      ['conversation_id', 'conversation_id'],
      ['project', 'project'],
      ['started_at', 'started_at'],
      ['model', 'model_primary'],
      ['input_tokens', 'total_input_tokens'],
      ['output_tokens', 'total_output_tokens'],
      ['prompt_count', 'prompt_count'],
      ['fluency_score', 'fluency_score'],
      ['archetype', 'archetype'],
      ['first_prompt_preview', 'first_prompt_preview'],
    ];
    const lines = [columns.map(([h]) => h).join(',')];
    visible.forEach(row => {
      const s = sessions[Number(row.dataset.index)];
      if (!s) return;
      lines.push(columns.map(([, key]) => csvEscape(s[key])).join(','));
    });
    const blob = new Blob([lines.join('\\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'observatory-sessions-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function sortTable(tableId, key, dir, rowSelector, getRowData) {
    const tbody = document.querySelector('#' + tableId + ' tbody');
    if (!tbody) return;
    const rows = [...tbody.querySelectorAll(rowSelector)];
    const mult = dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = getRowData(a, key);
      const vb = getRowData(b, key);
      const na = Number(va);
      const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== '' && vb !== '') return (na - nb) * mult;
      return String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true }) * mult;
    });
    rows.forEach(r => tbody.appendChild(r));
  }

  function bindSortableTable(tableId, rowSelector, getRowData) {
    const table = document.getElementById(tableId);
    if (!table) return;
    let sortKey = '';
    let sortDir = 'asc';
    table.querySelectorAll('th.sortable').forEach(th => {
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      const activate = () => {
        const key = th.dataset.sort;
        if (!key) return;
        sortDir = sortKey === key && sortDir === 'asc' ? 'desc' : 'asc';
        sortKey = key;
        table.querySelectorAll('th.sortable').forEach(h => {
          h.classList.remove('sort-asc', 'sort-desc');
          if (h === th) h.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        });
        sortTable(tableId, key, sortDir, rowSelector, getRowData);
      };
      th.addEventListener('click', activate);
      th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
    });
  }

  bindSortableTable('sessionTable', '.session-row', (row, key) => {
    const s = sessions[Number(row.dataset.index)];
    return s ? s[key] : '';
  });

  bindSortableTable('projectTable', '.project-row', (row, key) => {
    const p = (d.topProjects || [])[Number(row.dataset.index)];
    if (!p) return '';
    if (key === 'project') return (p.project || '').split(/[\\\\/]/).pop();
    return p[key];
  });

  document.getElementById('exportSessionsCsv').addEventListener('click', exportSessionsCsv);

  function showSession(idx) {
    const s = sessions[idx];
    if (!s) return;
    selectedIdx = idx;
    document.querySelectorAll('.session-row').forEach((r) =>
      r.classList.toggle('selected', Number(r.dataset.index) === idx)
    );
    const panel = document.getElementById('sessionDetail');
    const grid = document.getElementById('detailGrid');
    const prev = document.getElementById('detailPreview');
    const copyT = document.getElementById('copyTranscriptBtn');
    panel.classList.add('open');
    grid.innerHTML = [
      ['Chat ID', '<code>' + escHtml(s.conversation_id || '—') + '</code>'],
      ['Project', escHtml(s.project || '—')],
      ['Date', escHtml((s.started_at || '').slice(0, 10))],
      ['Model', escHtml(s.model_primary || '—')],
      ['Input', fmtN(s.total_input_tokens)],
      ['Output', fmtN(s.total_output_tokens)],
      ['Prompts', fmtN(s.prompt_count)],
      ['Score', s.fluency_score != null ? Math.round(s.fluency_score) : '—'],
      ['Archetype', escHtml(s.archetype || '—')],
    ].map(([l,v]) => '<div class="detail-item"><label>' + l + '</label><span>' + v + '</span></div>').join('');
    prev.textContent = s.first_prompt_preview ? s.first_prompt_preview.replace(/<[^>]+>/g, ' ').trim().slice(0, 500) : 'No prompt preview';
    renderTimeline(s.conversation_id);
    copyT.style.display = s.transcript_path ? 'inline-block' : 'none';
    copyT.dataset.path = s.transcript_path || '';
    document.getElementById('copyIdBtn').dataset.id = s.conversation_id || '';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function applySessionFilter() {
    const q = (document.getElementById('sessionSearch').value || '').toLowerCase();
    document.querySelectorAll('.session-row').forEach((row) => {
      const s = sessions[Number(row.dataset.index)];
      if (!s) return;
      const hay = [s.project, s.model_primary, s.archetype, s.first_prompt_preview, s.conversation_id].join(' ').toLowerCase();
      const filterProject = (projectFilter || '').toLowerCase();
      const sessionProject = (row.dataset.project || (s.project || '')).toLowerCase();
      // Empty session project must not match every filter: ''.includes is always true for the reverse clause.
      const matchProject =
        !filterProject ||
        (Boolean(sessionProject) &&
          (sessionProject.includes(filterProject) || filterProject.includes(sessionProject)));
      const matchQ = !q || hay.includes(q);
      row.style.display = matchProject && matchQ ? '' : 'none';
    });
  }

  document.getElementById('sessionSearch').addEventListener('input', applySessionFilter);

  document.getElementById('clearFilter').addEventListener('click', () => {
    projectFilter = '';
    document.getElementById('clearFilter').style.display = 'none';
    document.querySelectorAll('.project-row').forEach(r => r.classList.remove('selected'));
    applySessionFilter();
  });

  document.querySelectorAll('.project-row').forEach(row => {
    row.addEventListener('click', () => {
      projectFilter = row.dataset.project || '';
      document.getElementById('clearFilter').style.display = projectFilter ? 'inline-block' : 'none';
      document.querySelectorAll('.project-row').forEach(r => r.classList.toggle('selected', r === row));
      document.getElementById('sessions').scrollIntoView({ behavior: 'smooth' });
      applySessionFilter();
    });
  });

  document.querySelectorAll('.session-row').forEach(row => {
    const open = () => showSession(Number(row.dataset.index));
    row.addEventListener('click', e => { if (!e.target.closest('.id-btn')) open(); });
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* fall through to execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }

  document.querySelectorAll('.id-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const value = btn.dataset.copy || '';
      copyText(value).then((ok) => {
        if (!ok) return;
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = value.slice(0, 8); }, 1200);
      });
    });
  });

  document.getElementById('copyIdBtn').addEventListener('click', () => {
    const id = document.getElementById('copyIdBtn').dataset.id;
    if (id) copyText(id);
  });
  document.getElementById('copyTranscriptBtn').addEventListener('click', () => {
    const p = document.getElementById('copyTranscriptBtn').dataset.path;
    if (p) copyText(p);
  });

  document.querySelectorAll('.reco-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.closest('.reco-card')?.querySelector('.reco-body');
      if (!body) return;
      const collapsed = body.classList.toggle('collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed ? 'Show' : 'Hide';
    });
  });
})();
</script>
</body>
</html>`;
}

function liveScore(data) {
  return data.behavior?.fluency_score;
}

export async function writeReports(db, reportsDir, config = {}, options = {}) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const keepSnapshots = options.keepReportSnapshots !== false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const htmlPath = keepSnapshots ? path.join(reportsDir, `report-${stamp}.html`) : null;
  const jsonPath = keepSnapshots ? path.join(reportsDir, `report-${stamp}.json`) : null;
  const latestHtml = path.join(reportsDir, "latest.html");
  const latestJson = path.join(reportsDir, "latest.json");

  const data = await buildFullReport(db, config, options);
  const html = buildHtmlReport(data);
  const json = JSON.stringify(data, null, 2);

  if (keepSnapshots) {
    fs.writeFileSync(htmlPath, html, "utf8");
    fs.writeFileSync(jsonPath, json, "utf8");
  }
  atomicWriteFile(latestHtml, html);
  atomicWriteFile(latestJson, json);

  return { htmlPath, jsonPath, latestHtml, latestJson };
}

function atomicWriteFile(targetPath, contents) {
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, contents, "utf8");
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Windows may refuse rename over an existing file; fall back to copy.
    if (process.platform !== "win32" || !fs.existsSync(targetPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
    try {
      fs.copyFileSync(tmpPath, targetPath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}
