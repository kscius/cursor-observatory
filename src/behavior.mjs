const ACTION_VERB =
  /\b(fix|add|implement|create|update|remove|refactor|debug|test|verify|run|deploy|migrate|search|find|explain|review)\b/i;
const CONSTRAINT =
  /\b(must|should|only|without|never|before|after|ensure|do not|don't|exactly|minimal)\b/i;
const ARTIFACT = /\b(file|function|class|module|api|endpoint|schema|migration|test|hook|rule)\b/i;
const VERIFY =
  /\b(tests?|verify|validate|lint|typecheck|build|rspec|jest|vitest|pytest|npm test|cargo test)\b/i;
const PRECISE_REJECT = /\b(wrong|incorrect|not working|still fails|try again|instead)\b/i;

function squash(rate, target) {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, rate / target));
}

function avg(nums) {
  const v = nums.filter((n) => Number.isFinite(n));
  if (!v.length) return 0;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

export function scoreBehaviorFromPrompts(prompts, meta = {}) {
  const real = (prompts || []).map((p) => String(p || "").trim()).filter(Boolean);
  const n = real.length;

  if (n === 0) {
    return {
      fluencyScore: 50,
      archetype: "Sprinter",
      realPromptCount: 0,
      dimensions: {
        briefing: 0.5,
        verification: 0.5,
        contextSetting: 0.5,
        iteration: 0.5,
        toolcraft: 0.5,
      },
      confidence: "low",
    };
  }

  let action = 0;
  let constraint = 0;
  let artifact = 0;
  let verify = 0;
  let precise = 0;
  let terse = 0;
  let delegate = 0;

  for (const text of real) {
    if (ACTION_VERB.test(text)) action++;
    if (CONSTRAINT.test(text)) constraint++;
    if (ARTIFACT.test(text)) artifact++;
    if (VERIFY.test(text)) verify++;
    if (PRECISE_REJECT.test(text)) precise++;
    if (text.length < 120) terse++;
    if (/\b(subagent|parallel|end-to-end|full pipeline|autonomous)\b/i.test(text)) delegate++;
    if (/^\/[a-z0-9-]+/i.test(text)) delegate++;
  }

  const briefing = squash(
    avg([action / n, constraint / n, artifact / n]),
    0.35
  );
  const verification = squash(verify / n, 0.15);
  const contextSetting = squash(artifact / n, 0.25);
  const iteration = squash(precise / n, 0.12);
  const toolcraft = squash(
    Math.min(1, (meta.toolCount || 0) / Math.max(1, n * 3)),
    0.6
  );

  const weights = {
    briefing: 0.24,
    verification: 0.22,
    contextSetting: 0.22,
    iteration: 0.18,
    toolcraft: 0.14,
  };

  const hedge = Math.min(1, n / 30);
  const raw =
    briefing * weights.briefing +
    verification * weights.verification +
    contextSetting * weights.contextSetting +
    iteration * weights.iteration +
    toolcraft * weights.toolcraft;

  const fluencyScore = Math.round((0.5 * (1 - hedge) + raw * hedge) * 100);

  const agencyVector = {
    delegate: delegate / n,
    terse: terse / n,
    briefing,
    verify: verification,
    precise: iteration,
  };

  let archetype = "Collaborator";
  const scores = {
    "Autonomous Agent": agencyVector.delegate * 2 + briefing,
    Architect: contextSetting * 2 + briefing,
    Debugger: precise * 2 + verification,
    Collaborator: 0.6,
    Sprinter: agencyVector.terse * 2 - verification * 0.5,
  };
  archetype = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];

  return {
    fluencyScore,
    archetype,
    realPromptCount: n,
    dimensions: {
      briefing,
      verification,
      contextSetting,
      iteration,
      toolcraft,
    },
    confidence: n < 10 ? "low" : n < 40 ? "medium" : "high",
  };
}
