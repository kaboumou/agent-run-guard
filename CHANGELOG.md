# Agent Run Guard — changelog (NOT published)

## 0.2.1 (2026-09-19)

- R1: OpenCode V2 adapter (primary, `{ id, setup }` literal, zero runtime
  deps — `Plugin.define` verified identity in `@opencode/plugin@2.0.9`);
  V1 adapter version-scoped to `adapters/opencode-v1/`; dual entrypoint
  `adapters/opencode/index.js` (V2 definition + V1 `server()`, official
  shape). Live: 1.18.31 runs the dual entry from an npm-tarball install
  (load/allow/identical/near/budget/storm/guard_status proven); dev
  0.0.0-dev-202609190806 invokes `setup()` but exposes no `tool`/`session`
  domains, so V2 hooks are unit/dry-run only there.
- R2: per-session lock (exclusive create, jittered backoff, 15 s stale
  takeover, 5 s timeout, token-checked release); reload-inside-lock, one
  event per hold, atomic save with retries; lock-timeout falls open by
  applying once unlocked. 24 parallel processes: no lost updates.
- R3: stable result identities deduped (Claude `tool_use_id`, V1 `callID`,
  V2 `event.id`); hashed + bounded (200) + persisted; duplicates never
  counted twice, even across restarts.
- R4: single `loadConfig`/`validateConfig` for CLI and all adapters
  (counts ≥ 1, minutes 0|≥1, cost 0|positive, mode allowlists); adapter-local
  numeric parsing deleted.
- R5: opt-in read-numeric near profile (`nearNormalizeNumerics`, default
  off — pagination never collapses by default).
- R6: `rm` any-flag-form root/home, `git push -f`, order-free PowerShell
  `-Recurse`/`-Force`; warn default kept.
- R7: shell write forms (`>`/`>>`, heredoc, `tee`, Set-Content/Out-File/
  Add-Content) scanned for secrets on any tool; warn default kept.
- R8: state files are `sha256(harness + session-or-cwd)`; 24 h inactivity
  expiry; `--reset-state`.
- R9: V2 `session.interrupt({ sessionID })` (published type has no
  `continue` field — earlier note corrected); V1 single-attempt abort,
  dead retry removed.
- R10: cost id-dedupe + delta/cumulative semantics; path dormant
  (`message.updated` still absent on 1.18.31).
- Release-prep metadata (no publish): MIT `LICENSE`, `files` allowlist
  (tarball 18 files / 30.4 kB, no tests), repository/homepage placeholders,
  `private` removed. Zero runtime dependencies.
- 113/113 tests green.

## 0.2.0-dev post-audit fixes (2026-09-19, unreleased, unpublished)

- P1: repeat counters now keyed by deterministic hashes (`ex@…`/`nx@…`,
  snapshot `v: 2`) — raw args never persisted in state; legacy v1 raw keys
  discarded on load (not migrated). Default CLI state dir moved out of the
  project tree to `os.tmpdir()/agent-run-guard-state`.
- P2: single audit-log append path (engine only; CLI mirror removed) —
  exactly one JSONL line per block/warn.
- P2: `error_storm` latch logging deduped (10 s same-count window; recovery
  re-arms).
- P3: empty/unparseable/non-hook stdin → exit 0 with no state write and no
  budget consumed.
- 61/61 tests green (new `tests/cli-regressions.test.mjs`).

## 0.2.0-dev (2026-09-19, unreleased, unpublished)

- New layout: `core/` (pure ESM policy engine: engine, rules, state, config,
  redaction), `adapters/opencode/plugin.js` (OpenCode plugin importing core),
  `adapters/harness-map.js` (stdin→canonical / decision→stdout per harness),
  `bin/guard.js` (universal hook CLI for Claude Code / Codex CLI / Gemini CLI /
  Crush). `plugin/agent-run-guard.js` kept as a compat shim (same v0.1
  `createGuard` semantics).
- Rules: identical repeats (ported), near-duplicate repeats (normalized hash,
  default 3), budgets (calls default 300, wall-clock minutes off, cost USD
  off/OpenCode-only), error-storm (N consecutive failures, default 5),
  dangerous-command patterns (default warn), secret-pattern file-write guard
  (default warn). All via config file + `AGENT_RUN_GUARD_*` env overrides.
- Steering: corrective reason on every deny; OpenCode context inject
  (`session.prompt` noReply, ≤1/30 s), compaction memory, `guard_status` tool,
  best-effort `session.abort` on hard limits (default cost-only), toast
  attempt; Gemini `continue:false` and Crush `halt:true` on hard limits.
- OpenCode 1.18.27 measurements: `tool.execute.after` carries NO `status`
  field — failure is read from bash-style `metadata.exit`; `message.updated`
  never fired in `opencode run`, so the cost budget cannot trigger from live
  events there (implemented + unit-tested, dormant until a harness delivers
  cost). `session.abort` stopped an `opencode run --auto` run (control run
  without abort ended normally with the budget message).
- 54/54 unit tests green. Live OpenCode proofs (sandbox): identical-repeat
  block, call-budget stop, error-storm block. CLI simulations: allow/deny/kill
  paths for all four CLI harnesses + cross-process state proof.

## 0.1.0 (2026-09-18, prototype, unpublished)

- OpenCode plugin: identical-repeat block (canonical tool+args hash),
  per-process call budget, deny/warn modes, JSONL log. 6/6 tests green.
- Live proof on OpenCode 1.18.31: second identical bash call blocked.
