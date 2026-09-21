# Agent Run Guard — cross-harness runtime guard

Blocks runaway agent behaviour at runtime instead of reporting it after the
fact: identical and near-duplicate repeat loops, tool-call / time / cost
budgets, consecutive-failure storms, dangerous commands, and secret material
in file writes. One dependency-free Node core (ESM, stdlib-only) plus thin
per-harness adapters. Version `0.2.1`, MIT-licensed. Source:
https://github.com/kaboumou/agent-run-guard

## Fail-open, always

Every harness here fails open: a broken hook, a crashed process, an
unparseable payload, or a lock timeout lets the tool proceed. The guard
reduces accidents; it does not contain an adversary and is not a security
boundary. Defaults are conservative (dangerous/secret matches **warn**;
budgets only block when exceeded).

## Layout

- `core/` — pure policy engine: `engine.js`, `config.js` (single
  resolver/validator), `canonical.js` (hashing, near-dup normalization,
  opt-in numeric profiles), `patterns.js` (dangerous + secret patterns),
  `state.js` (sha256 identity, expiry, atomic JSON state), `lock.js`
  (bounded per-session lock), `index.js` (re-exports).
- `adapters/opencode-v2/` — OpenCode V2 adapter, primary
  (`{ id, setup }` literal, no runtime dependency on `@opencode/plugin`).
- `adapters/opencode-v1/` — OpenCode V1 adapter, legacy (object entrypoints
  need OpenCode ≥ 1.18.29; live-proven on 1.18.27/1.18.31).
- `adapters/opencode/index.js` — dual entrypoint (official shape: V2
  definition + V1 `server()`), sharing the core.
- `adapters/opencode/plugin.js` — legacy re-export of the V1 adapter.
  `plugin/agent-run-guard.js` is the v0.1 compat shim.
- `adapters/harness-map.js` — per-harness stdin→canonical mapping and
  canonical decision→stdout JSON + exit codes.
- `bin/guard.js` — universal hook CLI for the non-OpenCode harnesses.
- `tests/` — unit + CLI + concurrency tests, stdlib only (`npm test`).

The guard only inspects hook JSON. It never executes user commands, never
makes network calls, and never stores raw argument values — neither in logs
nor in state files. Logs carry the tool name, a short hash fingerprint +
length, and pattern ids. State files carry deterministic hash keys
(`ex@…`/`nx@…`/`rid@…`) + counters only.

## Try a reproducible check

[Run the synthetic repeat-call demonstration](https://kaboumou.github.io/agent-run-inspector-docs/guard.html)
with the released npm package: two allowed calls, then a denied third call.
This tests the CLI mapping; it does not certify that your host invokes hooks.

## Install per harness

Install the published npm package (Node.js 18 or newer):

```sh
npm i -g agent-run-guard@0.2.1
```

This installs the `agent-run-guard` hook command. Configure the appropriate
harness below; installation alone does not activate hooks.
For adapter paths inside a project, use `npm i agent-run-guard@0.2.1` and
replace `<GUARD>` with the absolute path to
`<PROJECT>/node_modules/agent-run-guard`.

Package: https://www.npmjs.com/package/agent-run-guard

From source: `git clone https://github.com/kaboumou/agent-run-guard`.
Replace `<GUARD>` with the absolute path of the checkout, or install the
packed tarball (`npm pack` output) and use
`<PROJECT>/node_modules/agent-run-guard/...` paths (this is how the
1.18.31 live proof loaded it).

### OpenCode V2 (wiring unit-tested; host-limited live)

`.opencode/plugins/agent-run-guard.js`:

```js
export { default } from "file:///<GUARD>/adapters/opencode/index.js";
```

V2 calls `setup()`; on hosts that also call `server()` the V1 hooks apply.
Proof level: dry-run/unit only — on the one V2-capable host available here
(`opencode-ai@0.0.0-dev-202609190806`) `setup()` runs but its context
exposes no `tool`/`session` domains, so V2 hooks cannot register there;
enforcement on that host came from the V1 `server()` path. See matrix.

### OpenCode V1 ≥ 1.18.29 (tested live on 1.18.31)

Same dual entry as above (the `server()` object entrypoint), or the legacy
path:

```js
export { AgentRunGuard, default } from "file:///<GUARD>/adapters/opencode-v1/plugin.js";
```

(Use forward slashes in `file:///` URLs on Windows.) Live-proven: load,
allow, identical/near-repeat blocks, call-budget stop, error-storm block,
`guard_status` output, context inject (rate-limited ≤1/30 s). `session.abort`
(V1) is a single best-effort attempt on hard limits (default: cost-only);
on V2 the adapter uses `session.interrupt({ sessionID })` instead
(unit-tested; no `continue` field exists in the published 2.0.9 type).

### Claude Code (simulated)

`~/.claude/settings.json` (global) or `.claude/settings.json` (project):

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node <GUARD>/bin/guard.js --harness claude-code" }] }
    ]
  }
}
```

Windows: `command` runs via `powershell.exe` (first-class hook support).
Deny returns `permissionDecision: "deny"` + reason; allow prints nothing.
Result identity for storm dedupe: `tool_use_id` on result-style events.

### Codex CLI (simulated)

`~/.codex/hooks.json` (global) or `<repo>/.codex/hooks.json`:

```json {
  "PreToolUse": [{ "command": "node <GUARD>/bin/guard.js --harness codex" }]
}
```

Windows: use the `commandWindows` field. Hosted tools are NOT covered.

### Gemini CLI (simulated)

`.gemini/settings.json` (project) or `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [{ "command": "node <GUARD>/bin/guard.js --harness gemini-cli" }]
  }
}
```

Deny returns `{"decision":"deny","reason":"..."}`; hard-limit breaches
return `{"continue":false,"stopReason":"..."}`.

### Crush (simulated)

`crush.json` or `~/.config/crush/crush.json`: `PreToolUse` hook pointing at
`node <GUARD>/bin/guard.js --harness crush`. Deny returns
`{"decision":"deny","reason":"..."}`; hard limits add `"halt": true`.
Windows behavior undocumented (embedded POSIX shell) — documented, untested.

### CLI state, locking, expiry

`bin/guard.js` persists counters per session in a file named
`sha256(harness + session-or-cwd)` (no readable names), default dir
`os.tmpdir()/agent-run-guard-state` (`--state-dir` /
`AGENT_RUN_GUARD_STATE_DIR` override). Each invocation holds a bounded
exclusive lock (`.lock` sibling: exclusive create, jittered backoff,
15 s-stale takeover, 5 s timeout via `AGENT_RUN_GUARD_LOCK_TIMEOUT_MS` /
`AGENT_RUN_GUARD_LOCK_STALE_MS`), reloads state **inside** the lock, applies
exactly one event, and saves atomically (tmp + rename, retried). Lock
timeout falls open by applying once unlocked — never by dropping the hook.
Idle sessions reset after 24 h without activity; `--reset-state` deletes a
session file explicitly. Empty/unparseable/non-hook stdin: exit 0, no state
write, no budget consumed.

## Config reference

One resolver/validator (`loadConfig`) serves the CLI and all adapters.
File (JSON, camelCase) < env (`AGENT_RUN_GUARD_*`) < defaults. Invalid values
fall back to defaults (validator warnings are returned to callers; the CLI
keeps hooks silent).

| Key (file) | Env | Default | Meaning |
|---|---|---|---|
| `maxIdentical` | `AGENT_RUN_GUARD_MAX_IDENTICAL` | `3` | identical (tool, args) calls allowed; must be ≥ 1 |
| `maxNearDuplicate` | `AGENT_RUN_GUARD_MAX_NEAR` | `3` | near-identical calls allowed; must be ≥ 1 (see claim below) |
| `nearNormalizeNumerics` | `AGENT_RUN_GUARD_NEAR_NUMERICS` | `false` | opt-in: mask read-tool line/offset/limit numbers in near keys |
| `maxCalls` | `AGENT_RUN_GUARD_MAX_CALLS` | `300` | total tool calls allowed; must be ≥ 1 |
| `maxMinutes` | `AGENT_RUN_GUARD_MAX_MINUTES` | `0` (= off) | wall-clock minutes; 0 disables, else ≥ 1 |
| `maxCost` | `AGENT_RUN_GUARD_MAX_COST` | `0` (= off, USD) | spend allowed; 0 disables, else positive; dormant (see matrix) |
| `maxConsecutiveErrors` | `AGENT_RUN_GUARD_MAX_ERRORS` | `5` | consecutive failures before block; must be ≥ 1 |
| `mode` | `AGENT_RUN_GUARD_MODE` | `deny` | repeats/budgets/storms: `deny` = block, `warn` = log only |
| `dangerousMode` | `AGENT_RUN_GUARD_DANGEROUS_MODE` | `warn` | dangerous-command matches |
| `secretMode` | `AGENT_RUN_GUARD_SECRET_MODE` | `warn` | secret-in-write matches |
| `injectContext` | `AGENT_RUN_GUARD_INJECT_CONTEXT` | `true` | corrective context on block (≤1/30 s) |
| `abortMode` | `AGENT_RUN_GUARD_ABORT` | `cost-only` | `never` / `cost-only` / `always`; best-effort interrupt/abort on hard limits |
| `logFile` | `AGENT_RUN_GUARD_LOG` | unset | JSONL audit log, exactly one line per block/warn, never raw args |

## What the detectors actually claim (narrowed)

- **Near-duplicate (default):** masks whitespace, ISO timestamps,
  UUIDs/long hex ids, PIDs, temp paths, and `:line:`/`line N` text — NOT
  structured numeric fields. Legitimate pagination (`read` at offset 10 vs
  20) does **not** collapse. Opt-in `nearNormalizeNumerics` additionally
  masks read-tool `start_line`/`end_line`/`offset`/`limit`/`line`/`lines`.
- **Dangerous (warn default):** `rm` recursive+force against `/` or home in
  any flag form (`-rf`, `-fr`, `-r -f`, `--recursive --force`,
  `--no-preserve-root` ignored for letter detection); `git push --force`
  or `-f`; `git reset --hard`; `DROP TABLE`; `curl|wget … | sh|bash`;
  order-free `Remove-Item`/`ri` + `-Recurse` + `-Force` against drive
  root/home; `.env` piped into a network tool.
- **Secrets (warn default):** structured `Write`/`Edit`-style content
  (`AKIA…`, `ghp_…`, `sk-…`, PEM private-key block) AND shell write forms
  in command text (`>`/`>>` to a real file, heredoc, `| tee`,
  `Set-Content`/`Out-File`/`Add-Content`) combined with a secret pattern.
  `2>&1` and `/dev/null` are not file writes.
- **Error storms:** one execution counts once where the harness supplies a
  stable result id (Claude `tool_use_id`, OpenCode V1 `callID`, OpenCode V2
  `event.id`); dedupe set is hashed + bounded (200) and persisted. Without
  an id, every delivery counts — exact storm counting is not claimed there.

## Default deny vs warn

| Rule | Default | Deny switches it |
|---|---|---|
| identical / near repeats | `deny` (`mode`) | `AGENT_RUN_GUARD_MODE=warn` logs only |
| call / time / cost budgets | `deny` (`mode`) | same |
| error storm | `deny` (`mode`) | same |
| dangerous commands | **`warn`** | `AGENT_RUN_GUARD_DANGEROUS_MODE=deny` |
| secret writes (structured + shell) | **`warn`** | `AGENT_RUN_GUARD_SECRET_MODE=deny` |

## Support matrix (proof level per runtime)

| Runtime / harness | Repeats | Budgets | Cost | Storm | Dangerous / secrets | Loop-stop | Proof |
|---|---|---|---|---|---|---|---|
| OpenCode 1.18.31, dual entry from **installed tarball** (`server()`) | yes | calls yes; time unit | dormant (no cost in events; `message.updated` still absent) | yes, single latch line, id-deduped | yes, warn default | V1 `session.abort` (single attempt); inject ≤1/30 s; `guard_status` live | **tested live** |
| OpenCode dev 0.0.0-dev-202609190806, dual entry | V1 path enforced (block observed) | — | dormant | — | — | — | **partially live**: `setup()` invoked but host ctx lacks `tool`/`session` → V2 hooks inert; V2 wiring unit-only |
| OpenCode V2 wiring (`setup()` hooks, transform tool, compaction, interrupt, event cost watch) | yes | yes | observed-only | id-deduped | yes | `interrupt({sessionID})` | **unit/dry-run only** (9 tests, fake ctx) |
| OpenCode 1.18.27 (v0.2) | yes | calls yes | dormant | yes (`metadata.exit`) | yes | abort proven to stop `run --auto` | **tested live** (prior sprint) |
| Claude Code / Codex / Gemini / Crush via CLI | yes | yes | n/a | id-deduped only with result ids | yes | gemini `continue:false`, crush `halt:true`, claude/codex deny+reason | **simulated** (allow/deny/kill + 24-proc concurrency) |
| Kilo Code | same V1-compatible shape | — | — | — | — | — | **documented, untested** |
| Crush on Windows | — | — | — | — | — | — | **documented, untested** |

## Not covered

- Codex hosted tools (hooks do not apply).
- Crash fail-open (see top): the guard is accident-reduction, not a boundary.
- Exact storm counting without harness result ids (every delivery counts).
- Cost budgets anywhere until a harness delivers cost observations (delta vs
  cumulative + id-dedupe implemented, dormant; `message.updated` absent on
  1.18.27 and 1.18.31 `opencode run`).
- `tui.showToast` headless (attempted, fails silently, harmless).
- Claude `additionalContext`: not used (schema unverified).
- V1 `v:1` raw-key state files: keys discarded on load, not migrated; delete
  old `<cwd>/.agent-run-guard-state` dirs.
- Multi-instance sharing one log file may still double-log a storm latch
  (per-instance 10 s dedupe only) — harmless noise.

## Tests

```
npm test
```

113/113 green: config validation (0/negative/NaN/strings, both paths);
repeats + R5 numeric profiles (FP pagination + FN collapse); budgets;
R6/R7 detection both ways; R2 concurrency (24 parallel, no lost updates;
stale-lock takeover; lock-timeout fail-open); R3 result dedupe (dup/distinct/
restart/bounded/hash-only); R10 cost semantics; harness mappings; CLI
regressions (secret in no file, one line per block, empty stdin ignored);
V1 hooks (incl. measured `metadata.exit` shape) and V2 dry-runs (fake ctx:
allow/deny, compaction, guard_status, synthetic-first inject, interrupt
shape, dual entry); log/state redaction.

## Provenance

- v0.1 (2026-09-18, OpenCode 1.18.31): identical-repeat block.
- v0.2 (2026-09-19, 1.18.27): cross-harness core, live + simulated proofs;
  post-audit (hash-keyed state, single append, latch dedupe, empty-stdin).
- v0.2.1 (2026-09-19): release-hardening pass; live proofs on **1.18.31**
  (installed tarball + dual entry) and **dev-202609190806** (dual loads,
  V1 path enforces, V2 inert — unit-only); 113/113 tests. See CHANGELOG.

---

Need to analyze what already happened in an OpenCode session? **Agent Run
Inspector** turns `opencode export` data into a local HTML/JSON report —
free sample pack: https://payhip.com/b/I6OnS
