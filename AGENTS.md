# AGENTS.md

## Cursor Cloud specific instructions

`cursor-observatory` is a **zero-dependency Node.js CLI** that ingests local Cursor
telemetry (`~/.cursor` hook logs + agent transcripts) into SQLite and generates an
HTML/JSON analytics dashboard. It relies on the built-in `node:sqlite` module, so it
requires **Node.js 22+** (already present on the VM). Python 3 is only needed for the
optional `analyzer/behavior.py`.

Standard commands live in `package.json` `scripts` and `README.md`. Common ones:

- Tests: `npm test`
- Full refresh (ingest → rollup → report): `node bin/cursor-observatory.mjs dashboard --no-open`
- DB summary: `node bin/cursor-observatory.mjs status`

Non-obvious caveats:

- **No lint step and no runtime dependencies.** `npm install` is effectively a no-op
  (there is no lockfile and nothing to build).
- **`npm test` has 4 Windows-only assertions that fail on Linux/macOS.** The top of
  `tests/run-tests.mjs` asserts `decodeProjectSlug` / `normalizeProjectPath` output with
  backslash paths (e.g. `C:\Development\AGORA`). Those helpers use `path.sep`, which is
  `/` on Linux, so the assertions fail before reaching the integration tests. This is a
  known cross-platform limitation of the test file (the app was authored for Windows),
  not a regression. The core pipeline (`ingest → rollup → report`, behavior scoring,
  recommendations) works correctly on Linux — verify it by running the CLI directly.
- **A fresh VM has no real telemetry.** `~/.cursor/hooks/logs/` is usually empty, so
  `ingest` reports 0 events and the dashboard renders empty. To exercise the full
  pipeline, seed sample events into `~/.cursor/hooks/logs/agent-audit.jsonl` (one JSON
  object per line, each wrapped as `{"timestamp":...,"data":{"raw":"<stringified stop event>"}}`),
  then run the `dashboard` command.
- **Always pass `--no-open` for `dashboard`/`report` in headless environments** —
  otherwise the CLI tries to launch a browser via `xdg-open`.
- Output is written outside the repo, under `~/.cursor/observatory/`
  (DB at `observatory.db`, reports under `reports/latest.html`).
- LLM coaching is enabled in `config.example.json` but silently no-ops without
  `OPENAI_API_KEY`; no key is required for normal operation.
