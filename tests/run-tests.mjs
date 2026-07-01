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

const windowsProject = `C:${path.sep}Development${path.sep}AGORA`;
assert.equal(decodeProjectSlug("c-Development-AGORA"), windowsProject);
assert.equal(normalizeProjectPath("c:\\Development\\foo"), `C:${path.sep}Development${path.sep}foo`);
assert.equal(shortProjectName("c:\\Development\\AGORA"), "AGORA");
assert.equal(projectPathContext("c:\\Development\\AGORA"), "C:/Development");

const exampleConfig = JSON.parse(
  fs.readFileSync(new URL("../config.example.json", import.meta.url), "utf8")
);
assert.equal(exampleConfig.recommendations?.llm?.enabled, false);

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

db.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* Windows may lock temp DB briefly */
}

console.log("All tests passed.");
