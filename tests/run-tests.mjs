import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeProjectSlug,
  extractUserQuery,
  sanitizePreview,
  normalizeProjectPath,
  shortProjectName,
  projectPathContext,
  unwrapAuditEntry,
  parseTranscriptRecords,
  stripBom,
  primaryWorkspace,
  projectFromTranscriptPath,
  isInjectedPrompt,
  detectSlashCommand,
} from "../src/parse.mjs";
import { scoreBehaviorFromPrompts } from "../src/behavior.mjs";
import { openDatabase } from "../src/db.mjs";
import { ingestAll, ingestAuditLogs } from "../src/ingest.mjs";
import { runAllRollups } from "../src/aggregate.mjs";
import { ingestAll } from "../src/ingest.mjs";
import { runAllRollups, rollupSessions } from "../src/aggregate.mjs";
import { buildJsonReport, buildFullReport, buildSessionEventMap } from "../src/report.mjs";
import { buildDeterministicRecommendations, mergeLlmRecommendations } from "../src/recommend.mjs";
import { expandHome, loadConfig } from "../src/config.mjs";
import { applyRetention } from "../src/retention.mjs";
import { runCli } from "../src/cli.mjs";

const windowsProject = `C:${path.sep}Development${path.sep}AGORA`;
assert.equal(decodeProjectSlug("c-Development-AGORA"), windowsProject);
assert.equal(normalizeProjectPath("c:\\Development\\foo"), `C:${path.sep}Development${path.sep}foo`);
assert.equal(shortProjectName("c:\\Development\\AGORA"), "AGORA");
assert.equal(projectPathContext("c:\\Development\\AGORA"), "C:/Development");

assert.equal(stripBom("\uFEFFhello"), "hello");
assert.equal(stripBom("hello"), "hello");
assert.equal(primaryWorkspace(["/c:/Development/Foo"]), `C:${path.sep}Development${path.sep}Foo`);
assert.equal(
  projectFromTranscriptPath("C:/Users/x/.cursor/projects/c-Development-Demo/agent-transcripts/x.jsonl"),
  `C:${path.sep}Development${path.sep}Demo`
);
assert.equal(isInjectedPrompt("<system_reminder>context</system_reminder>"), true);
assert.equal(isInjectedPrompt("[MUST] follow rules"), true);
assert.equal(isInjectedPrompt("fix the login bug"), false);
assert.equal(detectSlashCommand("<user_query>/fix-bug in auth</user_query>"), "fix-bug");

const badRawAudit = JSON.stringify({
  timestamp: "2026-06-18T00:34:02.971Z",
  data: { raw: "not-json" },
});
const badEv = unwrapAuditEntry(JSON.parse(badRawAudit));
assert.equal(badEv.eventType, "unknown");

const emptyBehavior = scoreBehaviorFromPrompts([]);
assert.equal(emptyBehavior.archetype, "Sprinter");
assert.equal(emptyBehavior.fluencyScore, 50);

const exampleConfig = JSON.parse(
  fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8")
);
assert.equal(exampleConfig.recommendations?.llm?.enabled, false);
assert.equal(exampleConfig.ingest?.hookEvents, true);

const home = os.homedir();
assert.equal(expandHome("~"), home);
assert.equal(expandHome("~/observatory"), path.join(home, "observatory"));
assert.equal(expandHome(null), null);

const sampleAudit = JSON.stringify({
  timestamp: "2026-06-18T00:34:02.971Z",
  event: "unknown",
  data: {
    raw: '{"conversation_id":"abc","hook_event_name":"stop","model":"composer-2.5","input_tokens":100,"output_tokens":10,"workspace_roots":["/c:/Development/AGORA"]}',
  },
});

const ev = unwrapAuditEntry(JSON.parse(sampleAudit));
assert.equal(ev.eventType, "stop");
assert.equal(ev.inputTokens, 100);
assert.ok(ev.project.includes("AGORA"));

const lines = [
  JSON.stringify({
    role: "user",
    message: { content: [{ type: "text", text: "<user_query>\nfix the login bug\n</user_query>" }] },
  }),
  JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
  }),
];
const parsed = parseTranscriptRecords(lines, { conversationId: "x", project: "p", ts: null, source: "t" });
assert.equal(parsed.promptCount, 1);
assert.equal(extractUserQuery("<user_query>hello</user_query>"), "hello");
assert.equal(sanitizePreview("<user_query>fix auth</user_query>"), "fix auth");

const behavior = scoreBehaviorFromPrompts(["fix the auth bug in UserService and run tests"]);
assert.ok(behavior.fluencyScore >= 0);
assert.ok(behavior.archetype);

const withTests = scoreBehaviorFromPrompts(["please run tests on the module"]);
assert.ok(withTests.dimensions.verification > 0, "tests regex should match");

// Integration: fixture audit log → ingest → rollup → report keys
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "obs-test-"));
const hooksDir = path.join(tmp, "hooks", "logs");
fs.mkdirSync(hooksDir, { recursive: true });
const auditLine = JSON.stringify({
  timestamp: "2026-06-20T12:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-test-1",
      hook_event_name: "stop",
      model: "test-model",
      input_tokens: 500,
      output_tokens: 50,
      cache_read_tokens: 100,
      workspace_roots: ["/c:/Development/TestProject"],
    }),
  },
});
fs.writeFileSync(path.join(hooksDir, "agent-audit.jsonl"), auditLine + "\n");

const dbPath = path.join(tmp, "observatory.db");
const db = openDatabase(dbPath);
const config = {
  cursorHome: tmp,
  dataDir: path.join(tmp, "observatory"),
  hooksLogsDir: hooksDir,
  projectsDir: path.join(tmp, "projects"),
  ingest: {
    auditLogs: true,
    sessionSummary: false,
    subagentAudit: false,
    toolFailures: false,
    transcripts: false,
    includeRotatedLogs: false,
  },
};
ingestAll(db, config);
runAllRollups(db);
const report = buildJsonReport(db);
assert.ok(report.totals.events >= 1);
assert.ok(report.totals.input_tokens >= 500);
assert.ok(report.totals.cache_read_tokens >= 100);
assert.ok(Array.isArray(report.hourlyToday));
assert.ok("toolFailures" in report);
assert.ok("behaviorTrend" in report);
assert.ok("sessionEvents" in report);

const recs = buildDeterministicRecommendations(report);
assert.ok(recs.sections.overview?.explain);
assert.ok(recs.sections.behavior?.metrics?.length >= 5);
assert.ok(Array.isArray(recs.sections.behavior?.actions));

const merged = mergeLlmRecommendations(recs, {
  behavior: { summary: "test summary", actions: ["run tests"] },
});
assert.equal(merged.source, "hybrid");
assert.equal(merged.sections.behavior.llmSummary, "test summary");
assert.deepEqual(merged.sections.behavior.llmActions, ["run tests"]);

const full = await buildFullReport(db, { recommendations: { enabled: true } });
assert.ok(full.recommendations?.sections?.overview);

const eventMap = buildSessionEventMap(db, [{ conversation_id: "conv-test-1" }]);
assert.ok(Array.isArray(eventMap["conv-test-1"]));
assert.ok(eventMap["conv-test-1"].length >= 1);
assert.equal(eventMap["conv-test-1"][0].type, "stop");

// Session event trace cap (80 events per conversation)
const capDbPath = path.join(tmp, "session-cap.db");
const capDb = openDatabase(capDbPath);
const capConv = "conv-cap-test";
const insertCapEvent = capDb.prepare(
  `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line)
   VALUES (?, 'preToolUse', ?, ?, ?)`
);
for (let i = 0; i < 85; i++) {
  insertCapEvent.run(
    `2026-06-20T10:00:${String(i).padStart(2, "0")}.000Z`,
    capConv,
    "cap.jsonl",
    i + 1
  );
}
const capMap = buildSessionEventMap(capDb, [{ conversation_id: capConv }]);
assert.equal(capMap[capConv].length, 80);
assert.equal(capMap[capConv][0].type, "preToolUse");
capDb.close();

// rollupSessions: token totals only from stop events; tool_count from tool hooks
const rollupDbPath = path.join(tmp, "rollup-sessions.db");
const rollupDb = openDatabase(rollupDbPath);
const rollupConv = "conv-rollup-semantics";
const insertEvent = rollupDb.prepare(
  `INSERT INTO events (
    ts, event_type, conversation_id, model, input_tokens, output_tokens,
    duration_ms, source_file, source_line
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
insertEvent.run(
  "2026-06-20T10:00:00.000Z",
  "stop",
  rollupConv,
  "model-a",
  100,
  10,
  null,
  "r.jsonl",
  1
);
insertEvent.run(
  "2026-06-20T10:05:00.000Z",
  "stop",
  rollupConv,
  "model-a",
  100,
  10,
  null,
  "r.jsonl",
  2
);
insertEvent.run(
  "2026-06-20T10:10:00.000Z",
  "stop",
  rollupConv,
  "model-b",
  50,
  5,
  null,
  "r.jsonl",
  3
);
insertEvent.run(
  "2026-06-20T10:15:00.000Z",
  "sessionEnd",
  rollupConv,
  null,
  9999,
  9999,
  5000,
  "r.jsonl",
  4
);
insertEvent.run("2026-06-20T10:20:00.000Z", "preToolUse", rollupConv, null, null, null, null, "r.jsonl", 5);
insertEvent.run("2026-06-20T10:25:00.000Z", "preToolUse", rollupConv, null, null, null, null, "r.jsonl", 6);
rollupSessions(rollupDb);
const rollupRow = rollupDb
  .prepare("SELECT * FROM sessions WHERE conversation_id = ?")
  .get(rollupConv);
assert.equal(rollupRow.total_input_tokens, 250);
assert.equal(rollupRow.total_output_tokens, 25);
assert.equal(rollupRow.tool_count, 2);
assert.equal(rollupRow.duration_ms, 5000);
assert.equal(rollupRow.model_primary, "model-a");
rollupDb.close();

// Retention: prune events older than N days
const retentionDbPath = path.join(tmp, "retention.db");
const retentionDb = openDatabase(retentionDbPath);
retentionDb
  .prepare(
    `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line)
     VALUES (?, 'stop', ?, ?, ?)`
  )
  .run("2020-01-01T00:00:00.000Z", "old", "old.jsonl", 1);
retentionDb
  .prepare(
    `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line)
     VALUES (?, 'stop', ?, ?, ?)`
  )
  .run(new Date().toISOString(), "new", "new.jsonl", 1);
const disabled = applyRetention(retentionDb, { retention: { keepRawEventsDays: 0 } });
assert.equal(disabled.pruned, 0);
assert.equal(disabled.reason, "retention disabled");
const invalidDays = applyRetention(retentionDb, { retention: { keepRawEventsDays: "abc" } });
assert.equal(invalidDays.pruned, 0);
assert.equal(invalidDays.reason, "retention disabled");
const pruned = applyRetention(retentionDb, { retention: { keepRawEventsDays: 30 } });
assert.equal(pruned.prunedEvents, 1);
assert.equal(pruned.prunedPrompts, 0);
assert.equal(pruned.pruned, 1);
assert.equal(
  retentionDb.prepare("SELECT COUNT(*) AS n FROM events").get().n,
  1
);

// Retention: prune old prompts alongside events
const promptRetentionDb = openDatabase(path.join(tmp, "retention-prompts.db"));
promptRetentionDb
  .prepare(
    `INSERT INTO prompts (conversation_id, prompt_idx, ts, preview, source)
     VALUES (?, ?, ?, ?, ?)`
  )
  .run("old-conv", 0, "2020-01-01T00:00:00.000Z", "old prompt", "transcript");
promptRetentionDb
  .prepare(
    `INSERT INTO prompts (conversation_id, prompt_idx, ts, preview, source)
     VALUES (?, ?, ?, ?, ?)`
  )
  .run("new-conv", 0, new Date().toISOString(), "new prompt", "transcript");
const promptPruned = applyRetention(promptRetentionDb, { retention: { keepRawEventsDays: 30 } });
assert.equal(promptPruned.prunedPrompts, 1);
assert.equal(promptPruned.prunedEvents, 0);
assert.equal(
  promptRetentionDb.prepare("SELECT preview FROM prompts").get().preview,
  "new prompt"
);
promptRetentionDb.close();

// Prune + rollup: session aggregates reflect retained events only
const pruneDbPath = path.join(tmp, "prune-rollup.db");
const pruneDb = openDatabase(pruneDbPath);
const convId = "conv-prune-test";
pruneDb
  .prepare(
    `INSERT INTO events (
      ts, event_type, conversation_id, input_tokens, output_tokens,
      source_file, source_line
    ) VALUES (?, 'stop', ?, ?, ?, ?, ?)`
  )
  .run("2020-01-01T00:00:00.000Z", convId, 1000, 100, "old.jsonl", 1);
pruneDb
  .prepare(
    `INSERT INTO events (
      ts, event_type, conversation_id, input_tokens, output_tokens,
      source_file, source_line
    ) VALUES (?, 'stop', ?, ?, ?, ?, ?)`
  )
  .run(new Date().toISOString(), convId, 200, 20, "new.jsonl", 1);
runAllRollups(pruneDb);
assert.equal(
  pruneDb.prepare("SELECT total_input_tokens AS n FROM sessions WHERE conversation_id = ?").get(convId).n,
  1200
);
applyRetention(pruneDb, { retention: { keepRawEventsDays: 30 } });
runAllRollups(pruneDb);
assert.equal(
  pruneDb.prepare("SELECT total_input_tokens AS n FROM sessions WHERE conversation_id = ?").get(convId).n,
  200
);
pruneDb.close();

// Transcript ingest: user prompts extracted, injected prompts skipped
const transcriptDir = path.join(
  tmp,
  "projects",
  "c-Development-Demo",
  "agent-transcripts",
  "conv-transcript-1"
);
fs.mkdirSync(transcriptDir, { recursive: true });
const transcriptPath = path.join(transcriptDir, "conv-transcript-1.jsonl");
fs.writeFileSync(
  transcriptPath,
  [
    JSON.stringify({
      role: "user",
      message: {
        content: [{ type: "text", text: "<user_query>\nfix the login bug\n</user_query>" }],
      },
    }),
    JSON.stringify({
      role: "user",
      message: {
        content: [{ type: "text", text: "<system_reminder>injected context</system_reminder>" }],
      },
    }),
  ].join("\n") + "\n"
);
const transcriptDbPath = path.join(tmp, "transcript.db");
const transcriptDb = openDatabase(transcriptDbPath);
const transcriptConfig = {
  cursorHome: tmp,
  dataDir: path.join(tmp, "observatory"),
  hooksLogsDir: hooksDir,
  projectsDir: path.join(tmp, "projects"),
  ingest: {
    auditLogs: false,
    sessionSummary: false,
    subagentAudit: false,
    toolFailures: false,
    transcripts: true,
    hookEvents: false,
    includeRotatedLogs: false,
  },
};
const transcriptSummary = ingestAll(transcriptDb, transcriptConfig);
assert.equal(transcriptSummary.transcripts.transcripts, 1);
assert.equal(transcriptSummary.transcripts.prompts, 1);
assert.equal(
  transcriptDb.prepare("SELECT COUNT(*) AS n FROM prompts").get().n,
  1
);
assert.ok(
  transcriptDb.prepare("SELECT preview FROM prompts LIMIT 1").get().preview.includes("fix the login bug")
);
assert.ok(
  !transcriptDb.prepare("SELECT preview FROM prompts LIMIT 1").get().preview.includes("<user_query>")
);
transcriptDb.close();

// Incremental ingest: checkpoint resume and dedup on re-ingest
const cpHooksDir = path.join(tmp, "hooks-cp", "logs");
fs.mkdirSync(cpHooksDir, { recursive: true });
const cpAuditPath = path.join(cpHooksDir, "agent-audit.jsonl");
const cpLine1 = JSON.stringify({
  timestamp: "2026-06-21T10:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-cp-1",
      hook_event_name: "stop",
      model: "model-a",
      input_tokens: 10,
      output_tokens: 1,
      workspace_roots: ["/c:/Development/CpTest"],
    }),
  },
});
const cpLine2 = JSON.stringify({
  timestamp: "2026-06-21T11:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-cp-2",
      hook_event_name: "stop",
      model: "model-b",
      input_tokens: 20,
      output_tokens: 2,
      workspace_roots: ["/c:/Development/CpTest"],
    }),
  },
});
fs.writeFileSync(cpAuditPath, cpLine1 + "\n");
const cpDbPath = path.join(tmp, "checkpoint.db");
const cpDb = openDatabase(cpDbPath);
const cpConfig = {
  cursorHome: tmp,
  dataDir: path.join(tmp, "observatory-cp"),
  hooksLogsDir: cpHooksDir,
  projectsDir: path.join(tmp, "projects"),
  ingest: {
    auditLogs: true,
    sessionSummary: false,
    subagentAudit: false,
    toolFailures: false,
    transcripts: false,
    hookEvents: false,
    includeRotatedLogs: false,
  },
};
ingestAll(cpDb, cpConfig);
assert.equal(cpDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
ingestAll(cpDb, cpConfig);
assert.equal(cpDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
fs.appendFileSync(cpAuditPath, cpLine2 + "\n");
ingestAll(cpDb, cpConfig);
assert.equal(cpDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
cpDb.close();

// Secondary hook logs: session-summary, subagent-audit, tool-failures
const secondaryHooksDir = path.join(tmp, "secondary-hooks", "logs");
fs.mkdirSync(secondaryHooksDir, { recursive: true });
fs.writeFileSync(
  path.join(secondaryHooksDir, "session-summary.jsonl"),
  JSON.stringify({
    timestamp: "2026-06-21T10:00:00.000Z",
    conversation_id: "conv-session-end",
    generation_id: "gen-1",
    duration_ms: 120000,
    final_status: "completed",
    cursor_version: "1.0.0",
    composer_mode: "agent",
  }) + "\n"
);
fs.writeFileSync(
  path.join(secondaryHooksDir, "subagent-audit.jsonl"),
  JSON.stringify({
    timestamp: "2026-06-21T10:05:00.000Z",
    event: "subagentStop",
    subagent_type: "explore",
    task: "search the codebase for auth handlers",
    status: "completed",
    duration_ms: 45000,
    cursor_version: "1.0.0",
  }) + "\n"
);
fs.writeFileSync(
  path.join(secondaryHooksDir, "tool-failures.jsonl"),
  JSON.stringify({
    timestamp: "2026-06-21T10:10:00.000Z",
    conversation_id: "conv-tool-fail",
    generation_id: "gen-2",
    model: "test-model",
    tool_name: "Shell",
    error: "command not found: foobar",
    status: "failed",
    cursor_version: "1.0.0",
  }) + "\n"
);
const secondaryDbPath = path.join(tmp, "secondary-ingest.db");
const secondaryDb = openDatabase(secondaryDbPath);
const secondaryConfig = {
  cursorHome: path.join(tmp, "secondary-hooks"),
  dataDir: path.join(tmp, "observatory"),
  hooksLogsDir: secondaryHooksDir,
  projectsDir: path.join(tmp, "projects"),
  ingest: {
    auditLogs: false,
    sessionSummary: true,
    subagentAudit: true,
    toolFailures: true,
    transcripts: false,
    hookEvents: false,
    includeRotatedLogs: false,
  },
};
const secondarySummary = ingestAll(secondaryDb, secondaryConfig);
assert.equal(secondarySummary.session.inserted, 1);
assert.equal(secondarySummary.subagent.inserted, 1);
assert.equal(secondarySummary.tools.inserted, 1);
const secondaryEvents = secondaryDb
  .prepare("SELECT event_type, conversation_id, tool_name, status FROM events ORDER BY id")
  .all();
assert.equal(secondaryEvents.length, 3);
assert.equal(secondaryEvents[0].event_type, "sessionEnd");
assert.equal(secondaryEvents[0].conversation_id, "conv-session-end");
assert.equal(secondaryEvents[0].status, "completed");
assert.equal(secondaryEvents[1].event_type, "subagentStop");
assert.equal(secondaryEvents[1].status, "completed");
assert.equal(secondaryEvents[2].event_type, "toolFailure");
assert.equal(secondaryEvents[2].conversation_id, "conv-tool-fail");
assert.equal(secondaryEvents[2].tool_name, "Shell");
secondaryDb.close();
// Hook events ingest: collector stream at dataDir/events/hook-events.jsonl
const hookEventsDir = path.join(tmp, "observatory", "events");
fs.mkdirSync(hookEventsDir, { recursive: true });
const hookEventLine = JSON.stringify({
  ts: "2026-06-20T13:00:00.000Z",
  hook_event_name: "stop",
  conversation_id: "conv-hook-1",
  model: "collector-model",
  input_tokens: 300,
  output_tokens: 30,
  workspace_roots: ["/c:/Development/HookProject"],
});
fs.writeFileSync(path.join(hookEventsDir, "hook-events.jsonl"), hookEventLine + "\n");

const hookDbPath = path.join(tmp, "hook-events.db");
const hookDb = openDatabase(hookDbPath);
const hookConfig = {
  cursorHome: tmp,
  dataDir: path.join(tmp, "observatory"),
  hooksLogsDir: hooksDir,
  projectsDir: path.join(tmp, "projects"),
  ingest: {
    auditLogs: false,
    sessionSummary: false,
    subagentAudit: false,
    toolFailures: false,
    transcripts: false,
    hookEvents: true,
    includeRotatedLogs: false,
  },
};
const hookSummary = ingestAll(hookDb, hookConfig);
assert.equal(hookSummary.hookEvents.inserted, 1);
assert.equal(
  hookDb.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get("conv-hook-1").n,
  1
);
assert.equal(
  hookDb.prepare("SELECT model FROM events WHERE conversation_id = ?").get("conv-hook-1").model,
  "collector-model"
);

const hookDisabledDbPath = path.join(tmp, "hook-disabled.db");
const hookDisabledDb = openDatabase(hookDisabledDbPath);
const hookDisabledConfig = { ...hookConfig, ingest: { ...hookConfig.ingest, hookEvents: false } };
const hookDisabledSummary = ingestAll(hookDisabledDb, hookDisabledConfig);
assert.equal(hookDisabledSummary.hookEvents, null);
assert.equal(hookDisabledDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
hookDb.close();
hookDisabledDb.close();

// loadConfig rejects invalid JSON in repo config.json (skipped when user config exists)
const userConfigPath = path.join(home, ".cursor", "observatory", "config.json");
const repoConfigPath = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "config.json");
if (!fs.existsSync(userConfigPath)) {
  const hadRepoConfig = fs.existsSync(repoConfigPath);
  const savedRepoConfig = hadRepoConfig ? fs.readFileSync(repoConfigPath, "utf8") : null;
  try {
    fs.writeFileSync(repoConfigPath, "{ not valid json\n");
    assert.throws(() => loadConfig(), /Invalid JSON in config file/);
    fs.writeFileSync(repoConfigPath, "[]");
    assert.throws(() => loadConfig(), /must be a JSON object/);
  } finally {
    if (hadRepoConfig) fs.writeFileSync(repoConfigPath, savedRepoConfig);
    else if (fs.existsSync(repoConfigPath)) fs.unlinkSync(repoConfigPath);
  }
}

// ingestAll warns when audit and hook-event streams are both enabled
const warnLines = [];
const origWarn = console.warn;
console.warn = (...args) => warnLines.push(args.join(" "));
try {
  const warnDb = openDatabase(path.join(tmp, "dual-stream.db"));
  ingestAll(warnDb, {
    cursorHome: tmp,
    dataDir: path.join(tmp, "observatory"),
    hooksLogsDir: hooksDir,
    projectsDir: path.join(tmp, "projects"),
    ingest: {
      auditLogs: true,
      sessionSummary: false,
      subagentAudit: false,
      toolFailures: false,
      transcripts: false,
      hookEvents: true,
      includeRotatedLogs: false,
    },
  });
  warnDb.close();
  assert.ok(
    warnLines.some((line) => line.includes("auditLogs and hookEvents are both enabled")),
    "expected dual-stream ingest warning"
  );
} finally {
  console.warn = origWarn;
}

// BOM-prefixed JSONL lines ingest correctly
const bomAuditLine = JSON.stringify({
  timestamp: "2026-06-21T12:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-bom",
      hook_event_name: "stop",
      model: "bom-model",
      input_tokens: 11,
      output_tokens: 2,
    }),
  },
});
const bomAuditDefault = path.join(hooksDir, "agent-audit.jsonl");
const hadDefaultAudit = fs.existsSync(bomAuditDefault);
const savedDefaultAudit = hadDefaultAudit ? fs.readFileSync(bomAuditDefault, "utf8") : null;
const bomDirectDb = openDatabase(path.join(tmp, "bom-direct.db"));
try {
  fs.writeFileSync(bomAuditDefault, "\uFEFF" + bomAuditLine + "\n");
  const bomDirect = ingestAuditLogs(bomDirectDb, hooksDir, false);
  assert.equal(bomDirect.inserted, 1);
  assert.equal(
    bomDirectDb.prepare("SELECT conversation_id FROM events WHERE conversation_id = ?").get("conv-bom")
      .conversation_id,
    "conv-bom"
  );
} finally {
  if (hadDefaultAudit) fs.writeFileSync(bomAuditDefault, savedDefaultAudit);
  else if (fs.existsSync(bomAuditDefault)) fs.unlinkSync(bomAuditDefault);
}
bomDirectDb.close();

// Daily chart: one conversation with two models counts as one session
const dayDbPath = path.join(tmp, "daily-sessions.db");
const dayDb = openDatabase(dayDbPath);
const dayKey = "2026-06-22";
const insertStop = dayDb.prepare(
  `INSERT INTO events (
    ts, event_type, conversation_id, model, input_tokens, output_tokens,
    source_file, source_line
  ) VALUES (?, 'stop', ?, ?, ?, ?, ?, ?)`
);
insertStop.run(`${dayKey}T10:00:00.000Z`, "conv-multi-model", "model-a", 100, 10, "a.jsonl", 1);
insertStop.run(`${dayKey}T11:00:00.000Z`, "conv-multi-model", "model-b", 200, 20, "a.jsonl", 2);
runAllRollups(dayDb);
const dayReport = buildJsonReport(dayDb);
const dayRow = dayReport.daily.find((d) => d.day_key === dayKey);
assert.ok(dayRow, "expected daily row for test day");
assert.equal(dayRow.sessions, 1);
dayDb.close();

// CLI smoke tests
const helpLines = [];
const origLog = console.log;
console.log = (...args) => helpLines.push(args.join(" "));
try {
  await runCli(["--help"]);
  assert.ok(helpLines.some((line) => line.includes("cursor-observatory")));
  assert.ok(helpLines.some((line) => line.includes("dashboard")));
} finally {
  console.log = origLog;
}
await assert.rejects(() => runCli(["not-a-command"]), /Unknown command: not-a-command/);

retentionDb.close();

db.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows may lock temp DB briefly */
}

console.log("All tests passed.");
