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
} from "../src/parse.mjs";
import { scoreBehaviorFromPrompts } from "../src/behavior.mjs";
import { openDatabase } from "../src/db.mjs";
import { ingestAll } from "../src/ingest.mjs";
import { runAllRollups } from "../src/aggregate.mjs";
import { buildJsonReport, buildFullReport, buildSessionEventMap } from "../src/report.mjs";
import { buildDeterministicRecommendations } from "../src/recommend.mjs";
import { expandHome } from "../src/config.mjs";
import { applyRetention } from "../src/retention.mjs";

const windowsProject = `C:${path.sep}Development${path.sep}AGORA`;
assert.equal(decodeProjectSlug("c-Development-AGORA"), windowsProject);
assert.equal(normalizeProjectPath("c:\\Development\\foo"), `C:${path.sep}Development${path.sep}foo`);
assert.equal(shortProjectName("c:\\Development\\AGORA"), "AGORA");
assert.equal(projectPathContext("c:\\Development\\AGORA"), "C:/Development");

const exampleConfig = JSON.parse(
  fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8")
);
assert.equal(exampleConfig.recommendations?.llm?.enabled, false);

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

const full = await buildFullReport(db, { recommendations: { enabled: true } });
assert.ok(full.recommendations?.sections?.overview);

const eventMap = buildSessionEventMap(db, [{ conversation_id: "conv-test-1" }]);
assert.ok(Array.isArray(eventMap["conv-test-1"]));
assert.ok(eventMap["conv-test-1"].length >= 1);
assert.equal(eventMap["conv-test-1"][0].type, "stop");

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
const pruned = applyRetention(retentionDb, { retention: { keepRawEventsDays: 30 } });
assert.equal(pruned.pruned, 1);
assert.equal(
  retentionDb.prepare("SELECT COUNT(*) AS n FROM events").get().n,
  1
);

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
transcriptDb.close();

retentionDb.close();

db.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows may lock temp DB briefly */
}

console.log("All tests passed.");
