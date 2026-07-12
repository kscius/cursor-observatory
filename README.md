# Cursor Observatory

Local analytics for **Cursor** — measure **how much**, **where**, and **how** you work with the agent across all projects on your machine.

Privacy-first: everything runs locally. Your transcripts and hook logs never leave your computer.

Inspired by [claude-insight](https://github.com/Feloguarin/claude-insight) (behavior) and your existing `~/.cursor/hooks` telemetry (volume).

## What it measures

| Dimension | Examples |
|-----------|----------|
| **How much** | Tokens (in/out/cache), generations, sessions, tool calls |
| **Where** | Project/workspace, model, tools, MCP/shell commands |
| **How** | AI fluency score, archetype, briefing/verification/context dimensions |
| **Granularity** | Hourly, daily, per chat, per prompt (from transcripts) |

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite`)
- **Python 3.8+** (optional — standalone `analyzer/behavior.py` for ad-hoc prompt scoring)
- Cursor with hooks logging to `~/.cursor/hooks/logs/` (KS Cursor Orchestrator setup already does this)

## Quick start

```bash
git clone https://github.com/kscius/cursor-observatory.git
cd cursor-observatory
node --version  # requires Node.js 22+
npm install
npm run dashboard
```

This will:

1. Ingest hook logs + agent transcripts from `~/.cursor`
2. Apply retention (if configured), then aggregate into SQLite at `~/.cursor/observatory/observatory.db`
3. Generate `~/.cursor/observatory/reports/latest.html` (and `latest.json`) and open the HTML report

## CLI

```bash
node bin/cursor-observatory.mjs ingest          # incremental ingest + rollup
node bin/cursor-observatory.mjs ingest --full   # clear checkpoints & rescan JSONL from line 0 (existing rows deduped)
node bin/cursor-observatory.mjs ingest --no-rollup  # ingest only (faster)
node bin/cursor-observatory.mjs rollup          # recompute aggregates only
node bin/cursor-observatory.mjs report          # rollup + regenerate reports
node bin/cursor-observatory.mjs report --json   # also print report paths as JSON
node bin/cursor-observatory.mjs report --with-llm # report + OpenAI coaching (needs API key)
node bin/cursor-observatory.mjs dashboard       # ingest → retention → rollup → report → open browser
node bin/cursor-observatory.mjs dashboard --full     # full rescan + refresh
node bin/cursor-observatory.mjs dashboard --no-open  # headless / CI (skip browser)
node bin/cursor-observatory.mjs dashboard --with-llm
node bin/cursor-observatory.mjs watch           # auto-refresh on file changes (30s interval, 2s debounce)
node bin/cursor-observatory.mjs watch --interval 60  # interval in seconds
node bin/cursor-observatory.mjs prune           # apply retention (if configured)
node bin/cursor-observatory.mjs status          # DB summary
npm test
```

## Always-on usage

**Passive collection** — Cursor hooks write logs automatically while you work.

**Refresh reports** — run `npm run dashboard` when you want an updated view.

**Near real-time** — run `npm run watch` in a terminal; it re-ingests when hook logs, transcripts, or collector event files change (plus periodic refresh every 30s by default). Each refresh runs ingest → retention → rollup → report. Overlapping refreshes are serialized so the DB is not updated concurrently.

**Scheduled (Windows)** — optional Task Scheduler entry:

```powershell
schtasks /Create /TN "Cursor Observatory Dashboard" /TR "cmd /c cd /d <repo-path> && node bin/cursor-observatory.mjs dashboard --no-open" /SC HOURLY /F
```

**Scheduled (Linux/macOS)** — optional cron entry (hourly DB + report refresh):

```bash
# crontab -e
0 * * * * cd /path/to/cursor-observatory && node bin/cursor-observatory.mjs dashboard --no-open
```

Use `npm run ingest` alone only if you want the DB updated without regenerating `latest.html`. After `prune` removes old raw events, session aggregates are recomputed automatically when any rows were deleted. Use `rollup` or `dashboard` if you pruned outside the CLI.

## Data sources

| Source | Path |
|--------|------|
| Hook audit (tokens, tools, sessions) | `~/.cursor/hooks/logs/agent-audit.jsonl` |
| Rotated audit (when `includeRotatedLogs`) | `~/.cursor/hooks/logs/agent-audit.jsonl.old` |
| Session end | `~/.cursor/hooks/logs/session-summary.jsonl` |
| Subagents | `~/.cursor/hooks/logs/subagent-audit.jsonl` |
| Tool failures | `~/.cursor/hooks/logs/tool-failures.jsonl` |
| Agent transcripts | `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` |
| Optional collector | `~/.cursor/observatory/events/hook-events.jsonl` |

## Optional: dedicated hook collector

Copy `collector/observatory-collector.js` and register in `~/.cursor/hooks.json` on:

- `beforeSubmitPrompt`
- `sessionStart` / `sessionEnd`
- `stop`
- optionally `preToolUse` / `postToolUse` / `afterShellExecution` (for `tool_count` without audit logs)

Example `hooks.json` entry (adjust the script path):

```json
{
  "version": 1,
  "hooks": {
    "stop": [{ "command": "node ~/.cursor/hooks/observatory-collector.js" }],
    "beforeSubmitPrompt": [{ "command": "node ~/.cursor/hooks/observatory-collector.js" }],
    "sessionStart": [{ "command": "node ~/.cursor/hooks/observatory-collector.js" }],
    "sessionEnd": [{ "command": "node ~/.cursor/hooks/observatory-collector.js" }]
  }
}
```

Writes cleaner events to `~/.cursor/observatory/events/hook-events.jsonl` (or `$OBSERVATORY_DATA_DIR/events` / `dataDir` from config).

Enable with `"hookEvents": true` in `~/.cursor/observatory/config.json` (omitting the key keeps it off; `config.example.json` also sets `false` so audit-only setups do not double-count). If you use the collector, set `"auditLogs": false` so the same `stop` events are not ingested twice from both `agent-audit.jsonl` and `hook-events.jsonl`. Note: the hook collector itself only reads `~/.cursor/observatory/config.json` (or `OBSERVATORY_DATA_DIR`), not a repo-local `config.json`.

## Configuration

Copy `config.example.json` to `~/.cursor/observatory/config.json` to customize paths.

Config is resolved in this order: `~/.cursor/observatory/config.json`, repo-local `config.json`, then `config.example.json` as a fallback. Deterministic recommendations run locally by default; LLM coaching remains opt-in via `--with-llm` or by setting `recommendations.llm.enabled` to `true` in your copied config.

## Recommendations (Guide cards)

Each dashboard section (Overview, Usage, Behavior, Sessions, Tools) includes a **Guide & recommendations** panel:

- **Explain** — what the section measures and how to read it
- **Metrics glossary** — key numbers with hints
- **Insights** — offline heuristics from your data
- **Suggested actions** — concrete next steps

**Sessions UX:** click a row for trace details + **event timeline** (hook events per chat). Sort any column via header click. **Export CSV** exports visible (filtered) rows. **Theme** toggle (nav, top-right) switches light/dark; preference persists in `localStorage`.

Deterministic recommendations run on every report (no network).

### Optional: LLM coaching (OpenAI)

Enable richer, personalized coaching per section via OpenAI:

```powershell
$env:OPENAI_API_KEY = "sk-..."
node bin/cursor-observatory.mjs report --with-llm
```

Or in `~/.cursor/observatory/config.json`:

```json
"recommendations": {
  "enabled": true,
  "llm": {
    "enabled": true,
    "model": "gpt-4o-mini",
    "apiKeyEnv": "OPENAI_API_KEY",
    "useCache": true,
    "sections": ["behavior", "overview", "usage", "sessions", "tools"]
  }
}
```

Responses are cached at `~/.cursor/observatory/cache/llm-recommendations.json` so repeat reports stay fast. Only aggregated metrics are sent — not full transcripts.

**Cursor SDK / Composer 2.5:** not wired yet; use OpenAI today or extend `src/llm.mjs` with a second provider when you add `@cursor/sdk` and `CURSOR_API_KEY`.

## Related projects

- **KS Cursor Orchestrator** — rules, commands, hooks (produces telemetry)
- **cursor-observatory** — reads telemetry + transcripts (consumes data)

Keep this repo separate; only thin integration (collector hook + `/stats` can call this CLI later).

## Limitations

- Token counts come from Cursor hook `stop` events — approximate vs official billing dashboard
- Transcript JSONL lacks per-line timestamps (mtime used as proxy for historical chats)
- Tab completions / inline edits may not appear in agent transcripts
- Multi-machine: each PC has its own database

## License

MIT — see [LICENSE](LICENSE).
