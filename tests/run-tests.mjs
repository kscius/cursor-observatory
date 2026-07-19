import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeProjectSlug,
  extractUserQuery,
  extractUserText,
  hashPrompt,
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
import { openDatabase, insertEvent as insertEventRow, withTransaction, queryScalar } from "../src/db.mjs";
import { ingestAll, ingestAuditLogs } from "../src/ingest.mjs";
import { runAllRollups, rollupBehavior, rollupSessions } from "../src/aggregate.mjs";
import { buildJsonReport, buildFullReport, buildSessionEventMap, writeReports, buildHtmlReport } from "../src/report.mjs";
import { buildDeterministicRecommendations, mergeLlmRecommendations } from "../src/recommend.mjs";
import { enrichWithLlm } from "../src/llm.mjs";
import { expandHome, loadConfig } from "../src/config.mjs";
import { applyRetention } from "../src/retention.mjs";
import { runCli, parseIntervalMs } from "../src/cli.mjs";
import { startWatch } from "../src/watch.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const windowsProject = `C:${path.sep}Development${path.sep}AGORA`;
assert.equal(decodeProjectSlug("c-Development-AGORA"), windowsProject);
assert.equal(normalizeProjectPath("c:\\Development\\foo"), `C:${path.sep}Development${path.sep}foo`);
assert.equal(shortProjectName("c:\\Development\\AGORA"), "AGORA");
assert.equal(projectPathContext("c:\\Development\\AGORA"), "C:/Development");

assert.equal(stripBom("\uFEFFhello"), "hello");
assert.equal(stripBom("hello"), "hello");
assert.equal(extractUserText("plain"), "plain");
assert.equal(extractUserText([{ type: "text", text: "a" }, { type: "tool_use" }]), "a");
assert.equal(extractUserText([{ type: "text", text: "x" }, { type: "text", text: "y" }]), "x\ny");
assert.equal(hashPrompt("same"), hashPrompt("same"));
assert.notEqual(hashPrompt("a"), hashPrompt("b"));
assert.match(sanitizePreview("x".repeat(200), 10), /…$/);
assert.equal(primaryWorkspace(["/c:/Development/Foo"]), `C:${path.sep}Development${path.sep}Foo`);
assert.equal(primaryWorkspace([null, "/c:/Development/Bar"]), `C:${path.sep}Development${path.sep}Bar`);
assert.equal(primaryWorkspace([123, ""]), null);
assert.equal(primaryWorkspace([]), null);
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

const innerEventAudit = {
  timestamp: "2026-06-18T00:34:02.971Z",
  event: "unknown",
  data: {
    raw: JSON.stringify({
      event: "stop",
      conversation_id: "conv-inner-event",
      input_tokens: 5,
      output_tokens: 1,
    }),
  },
};
assert.equal(unwrapAuditEntry(innerEventAudit).eventType, "stop");

const emptyBehavior = scoreBehaviorFromPrompts([]);
assert.equal(emptyBehavior.archetype, "Sprinter");
assert.equal(emptyBehavior.fluencyScore, 50);

const exampleConfig = JSON.parse(
  fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8")
);
assert.equal(exampleConfig.recommendations?.llm?.enabled, false);
assert.equal(exampleConfig.ingest?.hookEvents, false);

// loadConfig: omitted hookEvents stays opt-in (false)
{
  const userConfigPath = path.join(os.homedir(), ".cursor", "observatory", "config.json");
  const repoConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");
  if (!fs.existsSync(userConfigPath)) {
    const hadRepoConfig = fs.existsSync(repoConfigPath);
    const savedRepoConfig = hadRepoConfig ? fs.readFileSync(repoConfigPath, "utf8") : null;
    try {
      fs.writeFileSync(repoConfigPath, JSON.stringify({ retention: { keepRawEventsDays: 0 } }));
      assert.equal(loadConfig().ingest.hookEvents, false);
    } finally {
      if (hadRepoConfig) fs.writeFileSync(repoConfigPath, savedRepoConfig);
      else if (fs.existsSync(repoConfigPath)) fs.unlinkSync(repoConfigPath);
    }
  }
}

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
  const sec = String(i % 60).padStart(2, "0");
  const min = String(Math.floor(i / 60)).padStart(2, "0");
  insertCapEvent.run(
    `2026-06-20T10:${min}:${sec}.000Z`,
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

// model_primary must ignore non-stop events even when they carry a model
const modelNoiseConv = "conv-model-noise";
insertEvent.run(
  "2026-06-20T11:00:00.000Z",
  "stop",
  modelNoiseConv,
  "composer-2.5",
  10,
  1,
  null,
  "r-model.jsonl",
  1
);
for (let i = 0; i < 5; i++) {
  insertEvent.run(
    `2026-06-20T11:0${i + 1}:00.000Z`,
    "toolFailure",
    modelNoiseConv,
    "noise-model",
    null,
    null,
    null,
    "r-model.jsonl",
    i + 2
  );
}
rollupSessions(rollupDb);
const modelNoiseRow = rollupDb
  .prepare("SELECT model_primary FROM sessions WHERE conversation_id = ?")
  .get(modelNoiseConv);
assert.equal(modelNoiseRow.model_primary, "composer-2.5");
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

// Same cutoff-day ISO timestamps must prune (ISO vs SQLite datetime string trap)
const retentionEdgeDb = openDatabase(path.join(tmp, "retention-edge.db"));
const edgeDays = 30;
const edgeCutoff = new Date(Date.now() - edgeDays * 24 * 60 * 60 * 1000);
const sameCutoffDayOldIso = new Date(
  Date.UTC(edgeCutoff.getUTCFullYear(), edgeCutoff.getUTCMonth(), edgeCutoff.getUTCDate())
).toISOString();
retentionEdgeDb
  .prepare(
    `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line)
     VALUES (?, 'stop', ?, ?, ?)`
  )
  .run(sameCutoffDayOldIso, "same-day-old", "same-day-old.jsonl", 1);
const edgePruned = applyRetention(retentionEdgeDb, { retention: { keepRawEventsDays: edgeDays } });
assert.equal(edgePruned.prunedEvents, 1);
retentionEdgeDb.close();

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

// Transcript re-ingest: unchanged mtime skips re-parse
const mtimeSecond = ingestAll(transcriptDb, transcriptConfig);
assert.equal(mtimeSecond.transcripts.transcripts, 0);
assert.equal(mtimeSecond.transcripts.prompts, 0);
assert.equal(mtimeSecond.transcripts.files, 1);
assert.equal(transcriptDb.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 1);
transcriptDb.close();

// Transcript re-ingest: mtime change replaces prompts
const mtimeChangeDb = openDatabase(path.join(tmp, "transcript-mtime.db"));
ingestAll(mtimeChangeDb, transcriptConfig);
fs.writeFileSync(
  transcriptPath,
  JSON.stringify({
    role: "user",
    message: {
      content: [{ type: "text", text: "<user_query>\nupdated prompt after mtime\n</user_query>" }],
    },
  }) + "\n"
);
const bumpedMtime = Date.now() + 60_000;
fs.utimesSync(transcriptPath, bumpedMtime / 1000, bumpedMtime / 1000);
const mtimeChanged = ingestAll(mtimeChangeDb, transcriptConfig);
assert.equal(mtimeChanged.transcripts.transcripts, 1);
assert.equal(mtimeChanged.transcripts.prompts, 1);
assert.equal(mtimeChangeDb.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 1);
assert.ok(
  mtimeChangeDb
    .prepare("SELECT preview FROM prompts LIMIT 1")
    .get()
    .preview.includes("updated prompt after mtime")
);
mtimeChangeDb.close();

// Transcript re-ingest: same mtime but changed size re-parses
const sameMtimeProjectsDir = path.join(tmp, "projects-same-mtime");
const sameMtimeTranscriptDir = path.join(
  sameMtimeProjectsDir,
  "c-Development-SameMtime",
  "agent-transcripts",
  "conv-transcript-same-mtime"
);
fs.mkdirSync(sameMtimeTranscriptDir, { recursive: true });
const sameMtimeTranscriptPath = path.join(
  sameMtimeTranscriptDir,
  "conv-transcript-same-mtime.jsonl"
);
const fixedMtimeMs = Date.now() + 120_000;
fs.writeFileSync(
  sameMtimeTranscriptPath,
  JSON.stringify({
    role: "user",
    message: {
      content: [{ type: "text", text: "<user_query>\ninitial prompt\n</user_query>" }],
    },
  }) + "\n"
);
fs.utimesSync(sameMtimeTranscriptPath, fixedMtimeMs / 1000, fixedMtimeMs / 1000);

const sameMtimeDb = openDatabase(path.join(tmp, "transcript-same-mtime-size.db"));
const sameMtimeConfig = { ...transcriptConfig, projectsDir: sameMtimeProjectsDir };
ingestAll(sameMtimeDb, sameMtimeConfig);

fs.writeFileSync(
  sameMtimeTranscriptPath,
  JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<user_query>\nupdated prompt with changed size\n</user_query>",
        },
      ],
    },
  }) + "\n"
);
fs.utimesSync(sameMtimeTranscriptPath, fixedMtimeMs / 1000, fixedMtimeMs / 1000);

const sameMtimeChanged = ingestAll(sameMtimeDb, sameMtimeConfig);
assert.equal(sameMtimeChanged.transcripts.transcripts, 1);
assert.equal(sameMtimeChanged.transcripts.prompts, 1);
assert.equal(sameMtimeDb.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 1);
assert.ok(
  sameMtimeDb
    .prepare("SELECT preview FROM prompts LIMIT 1")
    .get()
    .preview.includes("updated prompt with changed size")
);
sameMtimeDb.close();

// --full forces transcript re-parse even when mtime+size are unchanged
const fullForceProjectsDir = path.join(tmp, "projects-full-force");
const fullForceTranscriptDir = path.join(
  fullForceProjectsDir,
  "c-Development-FullForce",
  "agent-transcripts",
  "conv-transcript-full-force"
);
fs.mkdirSync(fullForceTranscriptDir, { recursive: true });
const fullForceTranscriptPath = path.join(
  fullForceTranscriptDir,
  "conv-transcript-full-force.jsonl"
);
const fullForceMtimeMs = Date.now() + 180_000;
fs.writeFileSync(
  fullForceTranscriptPath,
  JSON.stringify({
    role: "user",
    message: {
      content: [{ type: "text", text: "<user_query>\noriginal full-force prompt\n</user_query>" }],
    },
  }) + "\n"
);
fs.utimesSync(fullForceTranscriptPath, fullForceMtimeMs / 1000, fullForceMtimeMs / 1000);
const fullForceDb = openDatabase(path.join(tmp, "transcript-full-force.db"));
const fullForceConfig = { ...transcriptConfig, projectsDir: fullForceProjectsDir };
assert.equal(ingestAll(fullForceDb, fullForceConfig).transcripts.transcripts, 1);
assert.equal(ingestAll(fullForceDb, fullForceConfig).transcripts.transcripts, 0);
const fullForceAgain = ingestAll(fullForceDb, fullForceConfig, { full: true });
assert.equal(fullForceAgain.transcripts.transcripts, 1);
assert.equal(fullForceAgain.transcripts.prompts, 1);
assert.equal(fullForceDb.prepare("SELECT COUNT(*) AS n FROM prompts").get().n, 1);
fullForceDb.close();

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
const cpReingest = ingestAll(cpDb, cpConfig);
assert.equal(cpDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
assert.equal(cpReingest.audit.inserted, 0);
fs.appendFileSync(cpAuditPath, cpLine2 + "\n");
const cpAppend = ingestAll(cpDb, cpConfig);
assert.equal(cpDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
assert.equal(cpAppend.audit.inserted, 1);
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

// Hook events: event/session_id/timestamp aliases, string tokens, status
const hookAliasLine = JSON.stringify({
  timestamp: "2026-06-20T14:00:00.000Z",
  event: "sessionEnd",
  session_id: "conv-hook-alias",
  input_tokens: "42",
  output_tokens: "7",
  status: "completed",
  workspace_roots: "not-an-array",
});
fs.appendFileSync(path.join(hookEventsDir, "hook-events.jsonl"), hookAliasLine + "\n");
const hookAliasSummary = ingestAll(hookDb, hookConfig);
assert.equal(hookAliasSummary.hookEvents.inserted, 1);
const hookAliasRow = hookDb
  .prepare("SELECT event_type, conversation_id, input_tokens, status FROM events WHERE conversation_id = ?")
  .get("conv-hook-alias");
assert.equal(hookAliasRow.event_type, "sessionEnd");
assert.equal(hookAliasRow.input_tokens, 42);
assert.equal(hookAliasRow.status, "completed");

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
const repoConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.json");
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

// includeRotatedLogs: agent-audit.jsonl.old is ingested when enabled
const rotHooksDir = path.join(tmp, "hooks-rotated", "logs");
fs.mkdirSync(rotHooksDir, { recursive: true });
const rotOldPath = path.join(rotHooksDir, "agent-audit.jsonl.old");
const rotLine = JSON.stringify({
  timestamp: "2026-06-21T13:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-rotated-old",
      hook_event_name: "stop",
      model: "rot-model",
      input_tokens: 7,
      output_tokens: 1,
    }),
  },
});
fs.writeFileSync(rotOldPath, rotLine + "\n");
const rotDb = openDatabase(path.join(tmp, "rotated-audit.db"));
const rotOff = ingestAuditLogs(rotDb, rotHooksDir, false);
assert.equal(rotOff.files, 0);
assert.equal(rotOff.inserted, 0);
const rotOn = ingestAuditLogs(rotDb, rotHooksDir, true);
assert.equal(rotOn.files, 1);
assert.equal(rotOn.inserted, 1);
assert.equal(
  rotDb.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get("conv-rotated-old").n,
  1
);
rotDb.close();

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

// daily_stats.prompt_count must respect model dimension (not duplicate across models)
const promptCountDbPath = path.join(tmp, "daily-prompt-count.db");
const promptCountDb = openDatabase(promptCountDbPath);
const promptDay = "2026-06-22";
const insertPromptStop = promptCountDb.prepare(
  `INSERT INTO events (
    ts, event_type, conversation_id, model, input_tokens, output_tokens,
    source_file, source_line
  ) VALUES (?, 'stop', ?, ?, 10, 1, 'a.jsonl', ?)`
);
insertPromptStop.run(`${promptDay}T10:00:00.000Z`, "conv-a", "model-a", 1);
insertPromptStop.run(`${promptDay}T11:00:00.000Z`, "conv-b", "model-b", 2);
const insertPrompt = promptCountDb.prepare(
  `INSERT INTO prompts (conversation_id, project, prompt_idx, ts, preview, source)
   VALUES (?, '', 0, ?, ?, 'transcript')`
);
insertPrompt.run("conv-a", `${promptDay}T10:05:00.000Z`, "prompt a");
insertPrompt.run("conv-b", `${promptDay}T11:05:00.000Z`, "prompt b");
runAllRollups(promptCountDb);
const promptCountRows = promptCountDb
  .prepare(`SELECT model, prompt_count FROM daily_stats WHERE day_key = ? ORDER BY model`)
  .all(promptDay);
assert.equal(promptCountRows.length, 2);
assert.equal(promptCountRows[0].model, "model-a");
assert.equal(promptCountRows[0].prompt_count, 1);
assert.equal(promptCountRows[1].model, "model-b");
assert.equal(promptCountRows[1].prompt_count, 1);
promptCountDb.close();

// enrichWithLlm no-ops without API key (even when enabled)
{
  const savedApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const llmReport = { totals: {}, behavior: {}, sessions: [], topTools: [], toolFailures: [] };
    const llmDet = buildDeterministicRecommendations(llmReport);
    const llmOut = await enrichWithLlm(llmReport, llmDet, {
      enabled: true,
      apiKeyEnv: "OPENAI_API_KEY",
      useCache: false,
      cacheDir: path.join(tmp, "llm-cache"),
    });
    assert.equal(llmOut, llmDet);
    assert.equal(llmOut.source, "deterministic");
  } finally {
    if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey;
  }
}

// Daily chart: last 30 days, not the oldest 30
const windowDbPath = path.join(tmp, "daily-window.db");
const windowDb = openDatabase(windowDbPath);
const windowDays = [];
const windowInsert = windowDb.prepare(
  `INSERT INTO daily_stats (day_key, project, model, event_count, generation_count, input_tokens, output_tokens, session_count, prompt_count)
   VALUES (?, '', '', 1, 1, 100, 10, 1, 0)`
);
for (let i = 0; i < 35; i++) {
  const d = new Date("2026-01-01T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + i);
  const day = d.toISOString().slice(0, 10);
  windowDays.push(day);
  windowInsert.run(day);
}
const windowReport = buildJsonReport(windowDb);
assert.equal(windowReport.daily.length, 30);
assert.equal(windowReport.daily[0].day_key, windowDays[5]);
assert.equal(windowReport.daily[29].day_key, windowDays[34]);
windowDb.close();

// Behavior trend: last 90 daily snapshots, chronological
const trendDbPath = path.join(tmp, "behavior-window.db");
const trendDb = openDatabase(trendDbPath);
const trendDays = [];
const trendInsert = trendDb.prepare(
  `INSERT INTO behavior_snapshots (period, period_key, fluency_score, archetype, real_prompt_count, session_count, computed_at)
   VALUES ('daily', ?, 50, 'Sprinter', 1, 0, datetime('now'))`
);
for (let i = 0; i < 100; i++) {
  const d = new Date("2026-01-01T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + i);
  const day = d.toISOString().slice(0, 10);
  trendDays.push(day);
  trendInsert.run(day);
}
const trendReport = buildJsonReport(trendDb);
assert.equal(trendReport.behaviorTrend.length, 90);
assert.equal(trendReport.behaviorTrend[0].day, trendDays[10]);
assert.equal(trendReport.behaviorTrend[89].day, trendDays[99]);
trendDb.close();

// rollupBehavior purges stale daily behavior_snapshots before rebuild
const purgeDbPath = path.join(tmp, "behavior-purge.db");
const purgeDb = openDatabase(purgeDbPath);
purgeDb
  .prepare(
    `INSERT INTO behavior_snapshots (period, period_key, fluency_score, archetype, real_prompt_count, session_count, computed_at)
     VALUES ('daily', '2020-01-01', 50, 'Sprinter', 1, 0, datetime('now'))`
  )
  .run();
rollupBehavior(purgeDb);
assert.equal(
  purgeDb
    .prepare("SELECT COUNT(*) AS n FROM behavior_snapshots WHERE period='daily' AND period_key='2020-01-01'")
    .get().n,
  0
);
purgeDb.close();

// rollupBehavior: daily behavior_snapshots.session_count matches distinct stop sessions
const behSessDbPath = path.join(tmp, "behavior-session-count.db");
const behSessDb = openDatabase(behSessDbPath);
const behDay = "2026-06-25";
for (const [conv, line] of [
  ["conv-beh-a", 1],
  ["conv-beh-b", 2],
]) {
  behSessDb
    .prepare(
      `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line)
       VALUES (?, 'stop', ?, 'beh.jsonl', ?)`
    )
    .run(`${behDay}T10:00:00.000Z`, conv, line);
}
behSessDb
  .prepare(
    `INSERT INTO prompts (conversation_id, ts, preview, prompt_idx, source)
     VALUES ('conv-beh-a', ?, 'fix the bug in auth.ts and run tests', 0, 'transcript')`
  )
  .run(`${behDay}T10:05:00.000Z`);
runAllRollups(behSessDb);
assert.equal(
  behSessDb
    .prepare(
      `SELECT session_count AS n FROM behavior_snapshots WHERE period='daily' AND period_key=?`
    )
    .get(behDay).n,
  2
);
assert.equal(
  behSessDb
    .prepare(
      `SELECT session_count AS n FROM behavior_snapshots WHERE period='all-time' AND period_key='all'`
    )
    .get().n,
  2
);
rollupBehavior(behSessDb);
assert.equal(
  behSessDb
    .prepare(
      `SELECT session_count AS n FROM behavior_snapshots WHERE period='daily' AND period_key=?`
    )
    .get(behDay).n,
  2,
  "session_count survives ON CONFLICT upsert"
);
behSessDb.close();

// withTransaction rolls back on failure; runAllRollups is atomic across aggregate tables
const txDb = openDatabase(path.join(tmp, "rollup-tx.db"));
txDb
  .prepare(
    `INSERT INTO events (ts, event_type, conversation_id, source_file, source_line, input_tokens, output_tokens)
     VALUES ('2026-06-26T12:00:00.000Z', 'stop', 'conv-tx', 'tx.jsonl', 1, 5, 1)`
  )
  .run();
txDb
  .prepare(
    `INSERT INTO prompts (conversation_id, ts, preview, prompt_idx, source)
     VALUES ('conv-tx', '2026-06-26T12:00:00.000Z', 'implement a rollback-safe rollup', 0, 'transcript')`
  )
  .run();
runAllRollups(txDb);
assert.equal(txDb.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
assert.equal(
  txDb.prepare("SELECT COUNT(*) AS n FROM behavior_snapshots WHERE period='daily'").get().n,
  1
);
assert.throws(
  () =>
    withTransaction(txDb, () => {
      txDb.exec("DELETE FROM sessions");
      throw new Error("forced transaction failure");
    }),
  /forced transaction failure/
);
assert.equal(txDb.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
txDb.exec(`
  CREATE TRIGGER fail_daily_behavior BEFORE INSERT ON behavior_snapshots
  WHEN NEW.period = 'daily'
  BEGIN
    SELECT RAISE(ABORT, 'forced rollup failure');
  END
`);
assert.throws(() => runAllRollups(txDb), /forced rollup failure/);
assert.equal(txDb.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 1);
assert.equal(
  txDb.prepare("SELECT COUNT(*) AS n FROM behavior_snapshots WHERE period='daily'").get().n,
  1
);
txDb.close();

// Log rotation: truncated audit file drops stale events and re-ingests
const rotateDir = path.join(tmp, "rotate");
fs.mkdirSync(rotateDir, { recursive: true });
const rotateAudit = path.join(rotateDir, "agent-audit.jsonl");
const rotateLine1 = JSON.stringify({
  timestamp: "2026-06-20T12:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-rotate-old",
      hook_event_name: "stop",
      model: "old-model",
      input_tokens: 10,
      output_tokens: 1,
      workspace_roots: ["/c:/Development/Rotate"],
    }),
  },
});
fs.writeFileSync(rotateAudit, rotateLine1 + "\n");
const rotateDbPath = path.join(tmp, "rotate.db");
const rotateDb = openDatabase(rotateDbPath);
const rotateConfig = {
  cursorHome: tmp,
  dataDir: path.join(tmp, "observatory-rotate"),
  hooksLogsDir: rotateDir,
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
ingestAll(rotateDb, rotateConfig);
assert.equal(rotateDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
assert.equal(rotateDb.prepare("SELECT conversation_id FROM events").get().conversation_id, "conv-rotate-old");
const rotateLine2 = JSON.stringify({
  timestamp: "2026-06-21T12:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-rotate-new",
      hook_event_name: "stop",
      model: "m",
      input_tokens: 1,
      output_tokens: 0,
      workspace_roots: [],
    }),
  },
});
fs.writeFileSync(rotateAudit, rotateLine2 + "\n");
ingestAll(rotateDb, rotateConfig);
assert.equal(rotateDb.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
assert.equal(rotateDb.prepare("SELECT conversation_id FROM events").get().conversation_id, "conv-rotate-new");
rotateDb.close();

// insertEvent reports changes for INSERT OR IGNORE dedup
const insertDb = openDatabase(path.join(tmp, "insert-event.db"));
const insertEv = {
  ts: "2026-06-20T12:00:00.000Z",
  eventType: "stop",
  conversationId: "conv-ins",
  generationId: null,
  model: "m",
  project: null,
  workspaceRoots: [],
  inputTokens: 1,
  outputTokens: 0,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  toolName: null,
  command: null,
  durationMs: null,
  transcriptPath: null,
  cursorVersion: null,
  composerMode: null,
  promptPreview: null,
  subagentType: null,
  status: null,
  sourceFile: "/tmp/x.jsonl",
  sourceLine: 1,
  payloadJson: "{}",
};
assert.equal(insertEventRow(insertDb, insertEv), 1);
assert.equal(insertEventRow(insertDb, insertEv), 0);
insertDb.close();

// Atomic latest.* report writes
const reportDb = openDatabase(path.join(tmp, "report-write.db"));
insertEventRow(reportDb, {
  ...insertEv,
  conversationId: "conv-html",
  sourceFile: "/tmp/html.jsonl",
  promptPreview: "hello report",
});
const reportsDir = path.join(tmp, "reports-out");
const written = await writeReports(reportDb, reportsDir, {
  recommendations: { enabled: false, llm: { enabled: false } },
});
assert.ok(fs.existsSync(written.latestHtml));
assert.ok(fs.existsSync(written.latestJson));
assert.ok(written.htmlPath && fs.existsSync(written.htmlPath));
assert.ok(written.jsonPath && fs.existsSync(written.jsonPath));
const html = fs.readFileSync(written.latestHtml, "utf8");
assert.ok(html.includes("<!DOCTYPE html>"));
assert.equal(fs.readdirSync(reportsDir).filter((f) => f.endsWith(".tmp")).length, 0);

// keepReportSnapshots: false writes only latest.* (watch mode)
const latestOnlyDir = path.join(tmp, "reports-latest-only");
const latestOnly = await writeReports(
  reportDb,
  latestOnlyDir,
  { recommendations: { enabled: false, llm: { enabled: false } } },
  { keepReportSnapshots: false }
);
assert.equal(latestOnly.htmlPath, null);
assert.equal(latestOnly.jsonPath, null);
assert.ok(fs.existsSync(latestOnly.latestHtml));
assert.ok(fs.existsSync(latestOnly.latestJson));
assert.equal(
  fs.readdirSync(latestOnlyDir).filter((f) => f.startsWith("report-")).length,
  0
);
reportDb.close();

// Collector subprocess: event alias + OBSERVATORY_DATA_DIR
const collectorDataDir = path.join(tmp, "collector-data");
const collectorScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "collector",
  "observatory-collector.js"
);
const collectorPayload = JSON.stringify({
  event: "stop",
  session_id: "conv-collector",
  timestamp: "2026-06-20T15:00:00.000Z",
  model: "collector-sub",
  input_tokens: 11,
  workspace_roots: ["/c:/Development/Collector"],
});
const collectorRun = spawnSync(process.execPath, [collectorScript], {
  input: collectorPayload,
  encoding: "utf8",
  env: { ...process.env, OBSERVATORY_DATA_DIR: collectorDataDir },
});
assert.equal(collectorRun.status, 0);
assert.match(collectorRun.stdout, /\{\}/);
const collectorLog = path.join(collectorDataDir, "events", "hook-events.jsonl");
assert.ok(fs.existsSync(collectorLog));
const collectorEntry = JSON.parse(fs.readFileSync(collectorLog, "utf8").trim().split("\n").pop());
assert.equal(collectorEntry.hook_event_name, "stop");
assert.equal(collectorEntry.conversation_id, "conv-collector");

// Reject non-object / missing event name
const collectorReject = spawnSync(process.execPath, [collectorScript], {
  input: "null",
  encoding: "utf8",
  env: { ...process.env, OBSERVATORY_DATA_DIR: collectorDataDir },
});
assert.equal(collectorReject.status, 0);
assert.equal(fs.readFileSync(collectorLog, "utf8").trim().split("\n").length, 1);

// Watch smoke: refresh once, stop cleanly, no overlapping onRefresh
const watchDb = openDatabase(path.join(tmp, "watch.db"));
const watchHooks = path.join(tmp, "watch-hooks");
fs.mkdirSync(watchHooks, { recursive: true });
let active = 0;
let maxActive = 0;
let refreshes = 0;
const stopWatch = startWatch(
  {
    hooksLogsDir: watchHooks,
    projectsDir: path.join(tmp, "watch-projects"),
    dataDir: path.join(tmp, "watch-data"),
    reportsDir: path.join(tmp, "watch-reports"),
    ingest: {
      auditLogs: false,
      sessionSummary: false,
      subagentAudit: false,
      toolFailures: false,
      transcripts: false,
      hookEvents: false,
      includeRotatedLogs: false,
    },
    recommendations: { enabled: false, llm: { enabled: false } },
  },
  watchDb,
  {
    intervalMs: 60_000,
    onRefresh: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      refreshes++;
      await new Promise((r) => setTimeout(r, 30));
      active--;
    },
  }
);
await new Promise((r) => setTimeout(r, 150));
stopWatch();
assert.ok(refreshes >= 1);
assert.equal(maxActive, 1);
const watchReportFiles = fs.readdirSync(path.join(tmp, "watch-reports"));
assert.ok(watchReportFiles.includes("latest.html"));
assert.ok(watchReportFiles.includes("latest.json"));
assert.equal(watchReportFiles.filter((f) => f.startsWith("report-")).length, 0);
watchDb.close();

// Trailing incomplete JSONL line must not advance checkpoint until completed
const partialHooksDir = path.join(tmp, "hooks-partial", "logs");
fs.mkdirSync(partialHooksDir, { recursive: true });
const partialAuditPath = path.join(partialHooksDir, "agent-audit.jsonl");
const partialLine1 = JSON.stringify({
  timestamp: "2026-06-21T12:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-partial-1",
      hook_event_name: "stop",
      model: "model-a",
    }),
  },
});
const partialLine2 = JSON.stringify({
  timestamp: "2026-06-21T12:01:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-partial-2",
      hook_event_name: "stop",
      model: "model-b",
    }),
  },
});
fs.writeFileSync(partialAuditPath, partialLine1 + "\n" + partialLine2.slice(0, -1));
const partialDb = openDatabase(path.join(tmp, "partial-checkpoint.db"));
const partialFirst = ingestAuditLogs(partialDb, partialHooksDir, false);
assert.equal(partialFirst.inserted, 1);
assert.equal(partialFirst.skipped, 1);
assert.equal(
  partialDb.prepare("SELECT last_line FROM ingest_checkpoints WHERE source_path = ?").get(partialAuditPath)
    .last_line,
  1
);
fs.writeFileSync(partialAuditPath, partialLine1 + "\n" + partialLine2 + "\n");
const partialSecond = ingestAuditLogs(partialDb, partialHooksDir, false);
assert.equal(partialSecond.inserted, 1);
assert.equal(
  partialDb.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get("conv-partial-2").n,
  1
);
partialDb.close();

// Parseable JSON without a trailing newline must not insert or advance the checkpoint
const parseableHooksDir = path.join(tmp, "hooks-parseable-partial", "logs");
fs.mkdirSync(parseableHooksDir, { recursive: true });
const parseableAuditPath = path.join(parseableHooksDir, "agent-audit.jsonl");
const parseableLine = JSON.stringify({
  timestamp: "2026-06-21T13:00:00.000Z",
  data: {
    raw: JSON.stringify({
      conversation_id: "conv-parseable-partial",
      hook_event_name: "stop",
      model: "model-c",
    }),
  },
});
fs.writeFileSync(parseableAuditPath, parseableLine); // no trailing newline
const parseableDb = openDatabase(path.join(tmp, "parseable-partial.db"));
const parseableFirst = ingestAuditLogs(parseableDb, parseableHooksDir, false);
assert.equal(parseableFirst.inserted, 0);
assert.equal(parseableFirst.skipped, 1);
assert.equal(
  parseableDb.prepare("SELECT last_line FROM ingest_checkpoints WHERE source_path = ?").get(parseableAuditPath)
    ?.last_line ?? 0,
  0
);
assert.equal(
  parseableDb.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get("conv-parseable-partial")
    .n,
  0
);
fs.writeFileSync(parseableAuditPath, parseableLine + "\n");
const parseableSecond = ingestAuditLogs(parseableDb, parseableHooksDir, false);
assert.equal(parseableSecond.inserted, 1);
assert.equal(
  parseableDb.prepare("SELECT COUNT(*) AS n FROM events WHERE conversation_id = ?").get("conv-parseable-partial")
    .n,
  1
);
parseableDb.close();

// Corrupt middle JSONL line should still advance checkpoint
const corruptHooksDir = path.join(tmp, "hooks-corrupt", "logs");
fs.mkdirSync(corruptHooksDir, { recursive: true });
const corruptAuditPath = path.join(corruptHooksDir, "agent-audit.jsonl");
fs.writeFileSync(corruptAuditPath, partialLine1 + "\n{not-json}\n" + partialLine2 + "\n");
const corruptDb = openDatabase(path.join(tmp, "corrupt-checkpoint.db"));
const corruptFirst = ingestAuditLogs(corruptDb, corruptHooksDir, false);
assert.equal(corruptFirst.inserted, 2);
assert.equal(corruptFirst.skipped, 1);
assert.equal(
  corruptDb.prepare("SELECT last_line FROM ingest_checkpoints WHERE source_path = ?").get(corruptAuditPath)
    .last_line,
  3
);
const corruptSecond = ingestAuditLogs(corruptDb, corruptHooksDir, false);
assert.equal(corruptSecond.inserted, 0);
assert.equal(corruptSecond.skipped, 0);
corruptDb.close();

// Client-side report helpers escape session detail / timeline values
{
  const html = buildHtmlReport({
    generatedAt: "2026-07-12T00:00:00.000Z",
    totals: {},
    today: {},
    behavior: null,
    daily: [],
    hourlyToday: [],
    topProjects: [],
    topModels: [],
    topTools: [],
    toolFailures: [],
    toolUsage: [],
    recentSessions: [
      {
        conversation_id: '<img src=x onerror=alert(1)>',
        project: '<script>alert(1)</script>',
        started_at: "2026-07-12T00:00:00.000Z",
        model_primary: 'composer"><b>x',
        total_input_tokens: 1,
        total_output_tokens: 1,
        prompt_count: 1,
        fluency_score: 50,
        archetype: "Sprinter",
        first_prompt_preview: null,
        transcript_path: null,
      },
    ],
    sessionEvents: {},
    recommendations: { enabled: false },
  });
  assert.ok(html.includes("function escHtml"));
  assert.ok(html.includes("escHtml(s.project"));
  assert.ok(html.includes("escHtml(ev.type"));
  assert.match(html, /sessions\[Number\(row\.dataset\.index\)\]/);
  assert.match(html, /Number\(r\.dataset\.index\) === idx/);
}

// topTools must not count toolFailure rows as uses
{
  const toolsDb = openDatabase(path.join(tmp, "top-tools.db"));
  toolsDb
    .prepare(
      `INSERT INTO events (ts, event_type, conversation_id, tool_name, source_file, source_line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("2026-06-20T10:00:00.000Z", "preToolUse", "conv-tools", "Shell", "t.jsonl", 1);
  toolsDb
    .prepare(
      `INSERT INTO events (ts, event_type, conversation_id, tool_name, source_file, source_line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("2026-06-20T10:01:00.000Z", "toolFailure", "conv-tools", "Shell", "t.jsonl", 2);
  toolsDb
    .prepare(
      `INSERT INTO events (ts, event_type, conversation_id, tool_name, source_file, source_line)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run("2026-06-20T10:02:00.000Z", "toolFailure", "conv-tools", "Read", "t.jsonl", 3);
  const toolsReport = buildJsonReport(toolsDb);
  assert.deepEqual(
    toolsReport.topTools.map((r) => ({ tool_name: r.tool_name, uses: r.uses })),
    [{ tool_name: "Shell", uses: 1 }]
  );
  assert.equal(toolsReport.toolFailures.length, 2);
  toolsDb.close();
}

// Live fluency/archetype surface when no behavior_snapshots row exists yet
{
  const liveDb = openDatabase(path.join(tmp, "live-behavior.db"));
  liveDb
    .prepare(
      `INSERT INTO prompts (conversation_id, prompt_idx, ts, preview, source)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      "conv-live",
      0,
      "2026-06-20T10:00:00.000Z",
      "Please implement the API endpoint and verify with npm test",
      "transcript"
    );
  const liveReport = buildJsonReport(liveDb);
  assert.equal(typeof liveReport.behavior.fluency_score, "number");
  assert.ok(liveReport.behavior.fluency_score >= 0);
  assert.ok(liveReport.behavior.archetype);
  assert.ok(liveReport.behavior.dimensions?.contextSetting != null);
  liveDb.close();
}

// --with-llm still builds recommendations when guide cards are disabled
{
  const savedApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const withFlag = await buildFullReport(
      db,
      { recommendations: { enabled: false, llm: { enabled: false } }, dataDir: path.join(tmp, "llm-disabled-cache") },
      { withLlm: true }
    );
    assert.ok(withFlag.recommendations?.sections?.overview, "--with-llm should not early-return when recommendations.enabled=false");

    const disabled = await buildFullReport(db, { recommendations: { enabled: false } });
    assert.equal(disabled.recommendations, undefined);
  } finally {
    if (savedApiKey !== undefined) process.env.OPENAI_API_KEY = savedApiKey;
  }
}

// Guide card Context metric reads live camelCase contextSetting
{
  const ctxRecs = buildDeterministicRecommendations({
    totals: { sessions: 1, events: 1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 },
    topProjects: [],
    topModels: [],
    topTools: [],
    toolFailures: [],
    behavior: {
      fluency_score: 60,
      archetype: "Architect",
      real_prompt_count: 1,
      dimensions: {
        briefing: 0.5,
        verification: 0.5,
        contextSetting: 0.8,
        iteration: 0.5,
        toolcraft: 0.5,
      },
    },
  });
  const contextMetric = ctxRecs.sections.behavior.metrics.find((m) => m.label === "Context");
  assert.equal(contextMetric?.value, "80%");
}

// status session count matches report (distinct conversations in events, not sessions table)
{
  const statusDbPath = path.join(tmp, "status-sessions.db");
  const statusDb = openDatabase(statusDbPath);
  insertEventRow(statusDb, {
    ...insertEv,
    conversationId: "status-conv-1",
    generationId: "status-gen-1",
    sourceFile: "status-test.jsonl",
    sourceLine: 1,
  });
  insertEventRow(statusDb, {
    ...insertEv,
    conversationId: "status-conv-2",
    generationId: "status-gen-2",
    sourceFile: "status-test.jsonl",
    sourceLine: 2,
  });
  // No rollup — sessions table stays empty (ingest --no-rollup scenario)
  const statusSessions = queryScalar(
    statusDb,
    `SELECT COUNT(DISTINCT conversation_id) AS sessions FROM events WHERE conversation_id IS NOT NULL`
  );
  const reportSessions = buildJsonReport(statusDb).totals.sessions;
  assert.equal(statusSessions.sessions, 2);
  assert.equal(reportSessions, 2);
  assert.equal(queryScalar(statusDb, `SELECT COUNT(*) AS n FROM sessions`).n, 0);
  statusDb.close();
}

// CLI smoke tests
const helpLines = [];
const origLog = console.log;
console.log = (...args) => helpLines.push(args.join(" "));
try {
  await runCli(["--help"]);
  assert.ok(helpLines.some((line) => line.includes("cursor-observatory")));
  assert.ok(helpLines.some((line) => line.includes("dashboard")));
  assert.ok(helpLines.some((line) => /interval.*seconds/i.test(line)));
  assert.ok(helpLines.some((line) => line.includes("watch") && line.includes("--with-llm")));
} finally {
  console.log = origLog;
}
await assert.rejects(() => runCli(["not-a-command"]), /Unknown command: not-a-command/);

// --interval validation
assert.equal(parseIntervalMs([]), 30000);
assert.equal(parseIntervalMs(["--interval", "60"]), 60000);
assert.throws(() => parseIntervalMs(["--interval"]), /requires a positive number/);
assert.throws(() => parseIntervalMs(["--interval", "0"]), /Invalid --interval/);
assert.throws(() => parseIntervalMs(["--interval", "-5"]), /requires a positive number|Invalid --interval/);
assert.throws(() => parseIntervalMs(["--interval", "abc"]), /Invalid --interval/);

retentionDb.close();

db.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows may lock temp DB briefly */
}

console.log("All tests passed.");
