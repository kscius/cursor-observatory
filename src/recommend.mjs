/**
 * Deterministic + optional LLM recommendations per dashboard section.
 * Privacy-first: deterministic always runs offline; LLM is opt-in via config.
 */

function pct(n, d) {
  if (!d) return 0;
  return Math.round((n / d) * 100);
}

function topEntry(list, key = "input_tokens") {
  if (!list?.length) return null;
  return list.reduce((best, item) =>
    (Number(item?.[key]) || 0) > (Number(best?.[key]) || 0) ? item : best
  );
}

export function buildDeterministicRecommendations(report) {
  const t = report.totals || {};
  const b = report.behavior || {};
  const dims = b.dimensions || {};
  const input = t.input_tokens || 0;
  const output = t.output_tokens || 0;
  const cache = t.cache_read_tokens || 0;
  const sessions = t.sessions || 0;
  const events = t.events || 0;
  const failures = t.tool_failures || 0;
  const score = Math.round(b.fluency_score ?? 50);
  const conf = b.confidence || "low";
  const cacheRatio = input > 0 ? cache / input : 0;
  const outRatio = output > 0 ? input / output : 0;

  const topProject = topEntry(report.topProjects);
  const topModel = topEntry(report.topModels, "input_tokens");
  const topTool = topEntry(report.topTools, "uses");

  const overview = {
    title: "Overview",
    explain:
      "Aggregate token volume, session count, and cache usage from Cursor hook `stop` events. Numbers are approximate vs official billing but useful for trends.",
    metrics: [
      { label: "Total events ingested", value: events, hint: "All hook + audit rows in DB" },
      { label: "Distinct chat sessions", value: sessions, hint: "Unique conversation_id values" },
      { label: "Cache hit ratio", value: `${pct(cache, input)}%`, hint: "cache_read ÷ input tokens" },
      { label: "Input:output ratio", value: outRatio ? `${outRatio.toFixed(1)}:1` : "—", hint: "High ratio = heavy context re-reads" },
    ],
    insights: [],
    actions: [],
  };

  if (cacheRatio > 0.5) {
    overview.insights.push(
      `${pct(cache, input)}% of input tokens came from cache — Cursor is reusing context efficiently.`
    );
  } else if (input > 1_000_000) {
    overview.insights.push(
      "Cache read is low relative to input — you may be starting fresh chats often or hitting context limits."
    );
    overview.actions.push("Reuse existing chats for related tasks to improve cache efficiency.");
  }

  if (outRatio > 100) {
    overview.insights.push(
      `Input:output ratio is ${outRatio.toFixed(0)}:1 — typical for agent-heavy work with large context.`
    );
  }

  if (failures > 0) {
    overview.insights.push(`${failures} tool failure(s) recorded — check the Tools section.`);
    overview.actions.push("Review failed tool calls; add verification steps after fixes.");
  }

  const usage = {
    title: "Usage",
    explain:
      "Shows where tokens go: projects (workspace roots) and models. Click a project row to filter sessions.",
    metrics: [
      {
        label: "Top project",
        value: topProject?.project?.split(/[\\/]/).pop() || "—",
        hint: topProject ? `${pct(topProject.input_tokens, input)}% of input tokens` : "",
      },
      {
        label: "Top model",
        value: topModel?.model || "—",
        hint: topModel ? `${fmtN(topModel.input_tokens)} input tokens` : "",
      },
      { label: "Projects tracked", value: report.topProjects?.length ?? 0, hint: "Top 20 by input" },
      { label: "Models used", value: report.topModels?.length ?? 0, hint: "From stop events" },
    ],
    insights: [],
    actions: [],
  };

  if (topProject && pct(topProject.input_tokens, input) > 40) {
    usage.insights.push(
      `"${topProject.project?.split(/[\\/]/).pop()}" dominates usage (${pct(topProject.input_tokens, input)}% of input).`
    );
    usage.actions.push("Consider dedicated rules/hooks per heavy project to reduce repeated context.");
  }

  if (report.topModels?.length > 2) {
    usage.insights.push(`${report.topModels.length} models in use — compare cost/quality per model in the table.`);
  }

  const behavior = {
    title: "Behavior / AI Fluency",
    explain:
      "Heuristic score (0–100) from your real prompts: briefing, verification, context-setting, iteration, toolcraft. Inspired by claude-insight; not a grade — a coaching signal.",
    metrics: [
      { label: "Fluency score", value: `${score}/100`, hint: `Confidence: ${conf} (${b.real_prompt_count ?? 0} prompts)` },
      { label: "Archetype", value: b.archetype || "—", hint: "Dominant interaction style" },
      { label: "Briefing", value: `${Math.round((dims.briefing ?? b.briefing ?? 0) * 100)}%`, hint: "Clear goals + constraints" },
      { label: "Verification", value: `${Math.round((dims.verification ?? b.verification ?? 0) * 100)}%`, hint: "Ask to test/lint/build" },
      { label: "Context", value: `${Math.round((dims.context_setting ?? b.context_setting ?? dims.contextSetting ?? 0) * 100)}%`, hint: "Mention files/modules" },
      { label: "Iteration", value: `${Math.round((dims.iteration ?? b.iteration ?? 0) * 100)}%`, hint: "Precise corrections" },
      { label: "Toolcraft", value: `${Math.round((dims.toolcraft ?? b.toolcraft ?? 0) * 100)}%`, hint: "Tool use vs prompts" },
    ],
    insights: [],
    actions: [],
  };

  if (score < 45) {
    behavior.insights.push(
      "Score is below 45 — prompts tend to be terse or correction-heavy rather than structured briefs."
    );
    behavior.actions.push(
      "Start prompts with: goal + constraints + how to verify (e.g. 'fix X, run tests, minimal diff')."
    );
  } else if (score >= 70) {
    behavior.insights.push("Strong fluency — you consistently brief with structure and verification language.");
  }

  if ((dims.verification ?? b.verification ?? 0) < 0.2) {
    behavior.insights.push("Verification dimension is low — few prompts mention tests, lint, or build.");
    behavior.actions.push("Add 'run npm test' or acceptance criteria to prompts before merging.");
  }

  if ((dims.briefing ?? b.briefing ?? 0) < 0.35) {
    behavior.actions.push("Name the target file/module and the expected outcome in the first sentence.");
  }

  if (b.archetype === "Debugger") {
    behavior.insights.push(
      "Archetype Debugger: many correction phrases ('wrong', 'try again') — consider fuller initial briefs to reduce loops."
    );
  }

  if (conf === "low") {
    behavior.insights.push("Low confidence — fewer than 10 real prompts analyzed; score will stabilize with more data.");
  }

  const sessionsSec = {
    title: "Sessions",
    explain:
      "Each row is a Cursor chat (conversation_id). Click for trace details; filter by project from Usage table.",
    metrics: [
      { label: "Recent sessions shown", value: report.recentSessions?.length ?? 0, hint: "Last 50 by activity" },
      {
        label: "Avg prompts/session",
        value: avgPromptsPerSession(report.recentSessions),
        hint: "Higher = more back-and-forth",
      },
      { label: "Archetypes", value: report.archetypeMix?.length ?? 0, hint: "Session style mix" },
    ],
    insights: [],
    actions: [],
  };

  const highTokenSessions = (report.recentSessions || []).filter(
    (s) => (s.total_input_tokens || 0) > 500_000
  );
  if (highTokenSessions.length) {
    sessionsSec.insights.push(
      `${highTokenSessions.length} recent session(s) exceeded 500K input tokens — possible context bloat.`
    );
    sessionsSec.actions.push("Start a fresh chat when switching tasks; use @file instead of pasting large dumps.");
  }

  const tools = {
    title: "Tools",
    explain: "Tool calls from hooks (Read, Shell, Grep, etc.) and failure events from tool-failure logs.",
    metrics: [
      { label: "Top tool", value: topTool?.tool_name || "—", hint: topTool ? `${topTool.uses} uses` : "" },
      { label: "Tool failures", value: failures, hint: "From tool-failures.jsonl" },
      { label: "Distinct tools", value: report.topTools?.length ?? 0, hint: "Top 15 ranked" },
    ],
    insights: [],
    actions: [],
  };

  if (topTool?.tool_name === "Shell") {
    tools.insights.push("Shell is the top tool — ensure commands are scoped and verified.");
  }

  if (failures === 0) {
    tools.insights.push("No tool failures recorded — clean tool execution in the ingested period.");
  } else {
    const worst = report.toolFailures?.[0];
    if (worst) {
      tools.insights.push(`Most failures: ${worst.tool_name} (${worst.failures}x).`);
      tools.actions.push(`Inspect last error for ${worst.tool_name} in the failures table.`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "deterministic",
    sections: { overview, usage, behavior, sessions: sessionsSec, tools },
  };
}

function fmtN(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US");
}

function avgPromptsPerSession(sessions) {
  if (!sessions?.length) return "—";
  const avg = sessions.reduce((a, s) => a + (s.prompt_count || 0), 0) / sessions.length;
  return avg.toFixed(1);
}

function normalizeLlmActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.filter((a) => typeof a === "string" && a.trim());
}

export function mergeLlmRecommendations(det, llmSections) {
  if (!llmSections) return det;
  const out = { ...det, sections: { ...det.sections } };
  let merged = false;
  for (const [key, llm] of Object.entries(llmSections)) {
    if (!out.sections[key] || !llm) continue;
    const llmSummary = typeof llm.summary === "string" ? llm.summary : null;
    const llmActions = normalizeLlmActions(llm.actions);
    out.sections[key] = {
      ...out.sections[key],
      llmSummary,
      llmActions,
    };
    if (llmSummary || llmActions.length > 0) merged = true;
  }
  if (merged) out.source = "hybrid";
  return out;
}
