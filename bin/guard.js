#!/usr/bin/env node
/**
 * Agent Run Guard — bin/guard.js (universal hook CLI)
 * Usage:
 *   node bin/guard.js --harness claude-code|codex|gemini-cli|crush|generic
 *     [--state-dir <dir>] [--config <file>] [--print-decision] [--reset-state]
 *
 * Reads one hook JSON payload from stdin, evaluates the core engine, persists
 * session state (per-session lock + atomic tmp+rename) keyed by
 * sha256(harness + session-or-cwd), and prints the harness decision JSON
 * (or nothing on allow/warn).
 *
 * State lives outside the project tree by default
 * (`os.tmpdir()/agent-run-guard-state`, overridable via --state-dir or
 * AGENT_RUN_GUARD_STATE_DIR). State files hold hash keys + counters only —
 * never raw argument values. Idle sessions expire after 24 h of inactivity;
 * --reset-state deletes the session file explicitly.
 *
 * Concurrency (R2): exactly one event is applied per lock hold — the state
 * is (re)loaded while holding the lock, one event applied, atomically saved.
 * Lock env: AGENT_RUN_GUARD_LOCK_TIMEOUT_MS (default 5000),
 * AGENT_RUN_GUARD_LOCK_STALE_MS (default 15000). On lock timeout the CLI
 * applies the event unlocked once (documented fail-open fallback) rather
 * than dropping the hook; any other internal error exits 0 silently.
 *
 * Never executes user commands. Empty, unparseable, or non-hook stdin is
 * ignored (exit 0, no state write, no budget consumed).
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEngine } from "../core/engine.js";
import { loadConfig, fromFile } from "../core/config.js";
import { toCanonical, fromDecision, looksLikeHook } from "../adapters/harness-map.js";
import {
  sessionFileName,
  isExpired,
  STATE_TTL_MS,
  loadSnapshot,
  saveSnapshotBestEffort,
  blankSnapshot,
} from "../core/state.js";
import { withSessionLock, LockTimeoutError } from "../core/lock.js";

function parseArgs(argv) {
  const out = { harness: "generic", stateDir: null, config: null, printDecision: false, resetState: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--harness" && argv[i + 1]) out.harness = argv[++i];
    else if (a.startsWith("--harness=")) out.harness = a.slice("--harness=".length);
    else if (a === "--state-dir" && argv[i + 1]) out.stateDir = argv[++i];
    else if (a.startsWith("--state-dir=")) out.stateDir = a.slice("--state-dir=".length);
    else if (a === "--config" && argv[i + 1]) out.config = argv[++i];
    else if (a.startsWith("--config=")) out.config = a.slice("--config=".length);
    else if (a === "--print-decision") out.printDecision = true;
    else if (a === "--reset-state") out.resetState = true;
  }
  return out;
}

function readStdin() {
  // Synchronous read keeps Windows PowerShell piping simple.
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function lockOpts() {
  const t = Number(process.env.AGENT_RUN_GUARD_LOCK_TIMEOUT_MS);
  const s = Number(process.env.AGENT_RUN_GUARD_LOCK_STALE_MS);
  return {
    timeoutMs: Number.isFinite(t) && t > 0 ? Math.floor(t) : 5000,
    staleMs: Number.isFinite(s) && s > 0 ? Math.floor(s) : 15000,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const harness = String(opts.harness || "generic").toLowerCase();
  const rawStdin = readStdin();
  const trimmed = rawStdin.trim();
  if (!trimmed) {
    process.exitCode = 0;
    return;
  }
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    process.exitCode = 0;
    return;
  }
  if (!looksLikeHook(payload)) {
    process.exitCode = 0;
    return;
  }

  try {
    const fileObj = await fromFile(opts.config);
    const { config: cfg } = loadConfig({ fileObj, env: process.env });
    const canon = toCanonical(payload, harness);

    const evName = String(canon.hookEvent || "").toLowerCase();
    const isResultEvent = /post|after|result/.test(evName);

    const stateDir =
      opts.stateDir ||
      process.env.AGENT_RUN_GUARD_STATE_DIR ||
      join(tmpdir(), "agent-run-guard-state");
    const fileName = sessionFileName({
      harness,
      sessionId: canon.sessionId,
      cwd: canon.cwd || process.cwd(),
    });
    const stateFile = resolve(join(resolve(stateDir), fileName));

    if (opts.resetState) {
      try {
        const fs = await import("node:fs");
        fs.unlinkSync(stateFile);
      } catch {
        // Missing file is a successful reset.
      }
      process.exitCode = 0;
      return;
    }

    const applyOnce = async () => {
      // Reload INSIDE the lock (R2): never trust a pre-lock snapshot.
      let snapshot = await loadSnapshot(stateFile);
      if (isExpired(snapshot, Date.now(), STATE_TTL_MS)) snapshot = blankSnapshot();
      const engine = createEngine({ ...cfg, snapshot });
      let decision;
      if (isResultEvent) {
        const ok = canon.failureHint !== true;
        await engine.after({ ok, tool: canon.tool, resultId: canon.resultId });
        decision = { action: "allow", reason: "", event: null, hardLimit: false, patternIds: [] };      } else {
        decision = await engine.before({ tool: canon.tool, args: canon.args });
      }
      await saveSnapshotBestEffort(stateFile, engine.toSnapshot());
      return decision;
    };

    let decision;
    try {
      decision = await withSessionLock(stateFile, applyOnce, lockOpts());
    } catch (err) {
      if (err instanceof LockTimeoutError || err?.code === "AGENT_RUN_GUARD_LOCK_TIMEOUT") {
        // Fail-open fallback: apply once unlocked rather than drop the hook.
        decision = await applyOnce();
      } else {
        throw err;
      }
    }

    // NOTE: no audit-log write here — the engine already appended the block/
    // warn line once via cfg.logFile. A second append would double-log.
    const mapped = fromDecision(decision, harness);
    if (mapped.stdout && (decision.action === "deny" || opts.printDecision)) {
      process.stdout.write(JSON.stringify(mapped.stdout));
    } else if (opts.printDecision) {
      process.stdout.write(JSON.stringify({ decision: decision.action, reason: decision.reason || "" }));
    }
    process.exitCode = mapped.exitCode || 0;
  } catch {
    // Fail open: broken hook lets the tool proceed.
    process.exitCode = 0;
  }
}

await main();
