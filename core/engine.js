/**
 * Agent Run Guard — core/engine.js
 * Pure ESM, stdlib-only, no harness imports. The single policy engine used by
 * the OpenCode plugin and the universal hook CLI.
 *
 * Decision shape: { action, reason, event, hardLimit, patternIds }
 *   action: "allow" | "warn" | "deny"   (hardLimit:true hints loop-stop)
 * Raw argument values are NEVER placed in events/reasons/logs/snapshots —
 * only hash keys and the redacted fingerprint (hash + length), plus pattern
 * ids. Repeat counters are keyed by deterministic hashes (exactHash/nearHash)
 * so cross-process counting works without persisting raw args.
 */

import { DEFAULTS } from "./config.js";
import {
  canonical,
  exactHash,
  nearHash,
  HASH_KEY_RE,
  sha256hex,
  fingerprint,
  normalizeText,
} from "./canonical.js";
import { matchDangerous, matchSecrets, matchShellWriteSecrets } from "./patterns.js";
import { blankSnapshot } from "./state.js";

export function createEngine(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const snap = blankSnapshot();
  if (Number.isFinite(Number(options.startedAt)) && Number(options.startedAt) > 0) {
    snap.startedAt = Number(options.startedAt);
  }

  const identicalCounts = new Map();
  const nearCounts = new Map();
  let totalCalls = 0;
  let consecutiveErrors = 0;
  let stormActive = false;
  let spentCost = 0;
  let blockedCount = 0;
  let warnedCount = 0;
  const knownFailures = [];
  const startedAt = snap.startedAt;
  // Bounded set of hashed result identities (R3): one execution is never
  // counted twice, even across restarts. Hash-only, never raw ids.
  const seenResultIds = [];
  const seenResultSet = new Set();
  // Bounded set of hashed cost-observation identities (R10, dormant path).
  const seenCostIds = new Set();
  // Dedupe for storm-latch logging (double `after` delivery guard).
  let lastLatchAt = 0;
  let lastLatchCount = -1;

  /** Restore counters from a persisted snapshot (CLI cross-process state).
   * Only hash-shaped counter keys are accepted; legacy v1 keys holding raw
   * canonical args are discarded (never trusted, never re-persisted). */
  function hydrate(s) {
    if (!s || typeof s !== "object") return;
    if (Number.isFinite(Number(s.totalCalls))) totalCalls = Math.max(0, Math.floor(Number(s.totalCalls)));
    if (Number.isFinite(Number(s.consecutiveErrors)))
      consecutiveErrors = Math.max(0, Math.floor(Number(s.consecutiveErrors)));
    if (s.stormActive === true) stormActive = true;
    if (Number.isFinite(Number(s.spentCost))) spentCost = Math.max(0, Number(s.spentCost));
    if (Number.isFinite(Number(s.blockedCount))) blockedCount = Math.max(0, Math.floor(Number(s.blockedCount)));
    if (Number.isFinite(Number(s.warnedCount))) warnedCount = Math.max(0, Math.floor(Number(s.warnedCount)));
    if (s.identicalCounts && typeof s.identicalCounts === "object") {
      for (const [k, v] of Object.entries(s.identicalCounts)) {
        const n = Math.floor(Number(v));
        if (k && HASH_KEY_RE.test(k) && Number.isFinite(n) && n > 0) identicalCounts.set(k, n);
      }
    }
    if (s.nearCounts && typeof s.nearCounts === "object") {
      for (const [k, v] of Object.entries(s.nearCounts)) {
        const n = Math.floor(Number(v));
        if (k && HASH_KEY_RE.test(k) && Number.isFinite(n) && n > 0) nearCounts.set(k, n);
      }
    }
    if (Array.isArray(s.knownFailures)) {
      for (const f of s.knownFailures) {
        if (typeof f === "string" && knownFailures.length < 20) knownFailures.push(f);
      }
    }
    if (Array.isArray(s.seenResultIds)) {
      for (const h of s.seenResultIds) {
        if (typeof h === "string" && h.length >= 12 && seenResultIds.length < 200) {
          seenResultIds.push(h);
          seenResultSet.add(h);
        }
      }
    }
  }

  if (options.snapshot) hydrate(options.snapshot);

  function toSnapshot() {
    return {
      v: 2,
      totalCalls,
      identicalCounts: Object.fromEntries(identicalCounts),
      nearCounts: Object.fromEntries(nearCounts),
      consecutiveErrors,
      stormActive,
      spentCost,
      startedAt,
      lastSeen: Date.now(),
      blockedCount,
      warnedCount,
      knownFailures: [...knownFailures],
      seenResultIds: [...seenResultIds],
    };
  }

  async function appendLog(event) {
    if (!cfg.logFile) return;
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(cfg.logFile, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Logging must never break a session.
    }
  }

  function fp(tool, args) {
    try {
      return fingerprint(tool, args);
    } catch {
      return { hash: "unknown", len: 0 };
    }
  }

  function maybeWarn(eventName) {
    return cfg.mode === "warn" && (eventName === "identical_repeat" || eventName === "near_repeat" || eventName === "budget" || eventName === "error_storm");
  }

  /**
   * Inspect an upcoming tool call. Never executes anything.
   * @param {{tool: string, args: unknown}} call
   */
  async function before(call = {}) {
    const tool = String(call.tool ?? "unknown");
    const args = call.args ?? {};
    const now = Date.now();
    totalCalls += 1;
    const print = fp(tool, args);

    // --- hard budgets first ---
    if (totalCalls > cfg.maxCalls) {
      const event = {
        ts: now, event: "budget", kind: "calls", tool,
        fp: print.hash, argLen: print.len,
        total: totalCalls, limit: cfg.maxCalls,
      };
      return finish(event, true,
        `Agent Run Guard: tool-call budget exceeded (${totalCalls} calls, limit ${cfg.maxCalls}). ` +
        "Stop calling tools and report what has been done so far, including what is incomplete.");
    }
    if (cfg.maxMinutes > 0 && now - startedAt > cfg.maxMinutes * 60_000) {
      const elapsed = Math.round((now - startedAt) / 60000);
      const event = {
        ts: now, event: "budget", kind: "time", tool,
        fp: print.hash, argLen: print.len,
        elapsedMin: elapsed, limitMin: cfg.maxMinutes,
      };
      return finish(event, true,
        `Agent Run Guard: wall-clock budget exceeded (${elapsed} min, limit ${cfg.maxMinutes} min). ` +
        "Stop calling tools and report what has been done so far, including what is incomplete.");
    }
    if (cfg.maxCost > 0 && spentCost >= cfg.maxCost) {
      const event = {
        ts: now, event: "budget", kind: "cost", tool,
        fp: print.hash, argLen: print.len,
        spent: spentCost, limit: cfg.maxCost,
      };
      return finish(event, true,
        `Agent Run Guard: cost budget exceeded ($${spentCost.toFixed(4)} spent, limit $${cfg.maxCost}). ` +
        "Stop calling tools and report what has been done so far, including what is incomplete.");
    }

    // --- error storm (latched by after()) ---
    if (stormActive) {
      const event = {
        ts: now, event: "error_storm", tool,
        fp: print.hash, argLen: print.len,
        consecutive: consecutiveErrors, limit: cfg.maxConsecutiveErrors,
      };
      return finish(event, true,
        `Agent Run Guard: ${consecutiveErrors} consecutive tool failures (limit ${cfg.maxConsecutiveErrors}). ` +
        "Something is systematically wrong — stop repeating tool calls, summarize the failures, " +
        "and ask the user how to proceed.");
    }

    // --- identical repeats (hash of the exact canonical key; raw args
    // --- are transient and never stored — see exactHash) ---
    const ekey = exactHash(tool, args);
    const identical = (identicalCounts.get(ekey) || 0) + 1;
    identicalCounts.set(ekey, identical);
    if (identical > cfg.maxIdentical) {
      const event = {
        ts: now, event: "identical_repeat", tool,
        fp: print.hash, argLen: print.len,
        identical, limit: cfg.maxIdentical,
      };
      return finish(event, false,
        `Agent Run Guard: this exact ${tool} call has already run ${identical - 1} times ` +
        `(limit ${cfg.maxIdentical}). It is blocked. Change the approach, or ask the user ` +
        "how to proceed — do not repeat it again.");
    }

    // --- near-duplicate repeats (hash of the normalized key) ---
    const nkey = nearHash(tool, args, { nearNormalizeNumerics: cfg.nearNormalizeNumerics });
    const near = (nearCounts.get(nkey) || 0) + 1;
    nearCounts.set(nkey, near);
    if (near > cfg.maxNearDuplicate) {
      const event = {
        ts: now, event: "near_repeat", tool,
        fp: print.hash, argLen: print.len,
        near, limit: cfg.maxNearDuplicate,
      };
      return finish(event, false,
        `Agent Run Guard: a nearly identical ${tool} call has already run ${near - 1} times ` +
        `(limit ${cfg.maxNearDuplicate}; only timestamps/ids/paths differ). It is blocked. ` +
        "Change the approach instead of retrying with cosmetic changes, or ask the user how to proceed.");
    }

    // --- dangerous commands ---
    let dangerousHits = [];
    try {
      dangerousHits = matchDangerous(tool, args);
    } catch {
      dangerousHits = [];
    }
    if (dangerousHits.length > 0) {
      const event = {
        ts: now, event: "dangerous_command", tool,
        fp: print.hash, argLen: print.len,
        patterns: dangerousHits,
      };
      const msg =
        `Agent Run Guard: this ${tool} call matches dangerous pattern(s): ${dangerousHits.join(", ")}. ` +
        "Do NOT run it. Restate what you intended and ask the user for explicit confirmation of a safer command.";
      if (cfg.dangerousMode === "deny") return finish(event, false, msg, "deny");
      return finish(event, false, msg, "warn");
    }

    // --- secrets in file writes ---
    let secretHits = [];
    try {
      secretHits = matchSecrets(tool, args);
    } catch {
      secretHits = [];
    }
    if (secretHits.length > 0) {
      const event = {
        ts: now, event: "secret_write", tool,
        fp: print.hash, argLen: print.len,
        patterns: secretHits,
      };
      const msg =
        `Agent Run Guard: this ${tool} write looks like it contains secret material (${secretHits.join(", ")}). ` +
        "Do NOT write real secrets to files. Use a placeholder or environment reference instead, " +
        "and ask the user how the secret should be provided.";
      if (cfg.secretMode === "deny") return finish(event, false, msg, "deny");
      return finish(event, false, msg, "warn");
    }

    // --- secrets via shell write forms (>, >>, heredoc, tee, PS cmdlets) ---
    let shellHits = { patterns: [], forms: [] };
    try {
      shellHits = matchShellWriteSecrets(tool, args);
    } catch {
      shellHits = { patterns: [], forms: [] };
    }
    if (shellHits.patterns.length > 0) {
      const event = {
        ts: now, event: "secret_write", tool,
        fp: print.hash, argLen: print.len,
        patterns: shellHits.patterns,
        via: "shell",
        forms: shellHits.forms,
      };
      const msg =
        `Agent Run Guard: this ${tool} command writes secret-like material (${shellHits.patterns.join(", ")}) ` +
        `to a file via shell redirection (${shellHits.forms.join(", ")}). ` +
        "Do NOT write real secrets to files. Use a placeholder or environment reference instead, " +
        "and ask the user how the secret should be provided.";
      if (cfg.secretMode === "deny") return finish(event, false, msg, "deny");
      return finish(event, false, msg, "warn");
    }

    return { action: "allow", reason: "", event: null, hardLimit: false, patternIds: [] };
  }

  async function finish(event, hardLimit, message, forceAction) {
    let action;
    if (forceAction) {
      action = forceAction;
    } else if (hardLimit) {
      action = cfg.mode === "deny" ? "deny" : "warn";
    } else {
      action = cfg.mode === "deny" ? "deny" : "warn";
    }
    if (action === "deny") blockedCount += 1;
    else warnedCount += 1;
    event.action = action === "deny" ? "blocked" : "warned";
    if (hardLimit) event.hardLimit = true;
    await appendLog(event);
    if (action === "deny") {
      return { action: "deny", reason: message, event, hardLimit, patternIds: event.patterns || [] };
    }
    return { action: "warn", reason: message, event, hardLimit, patternIds: event.patterns || [] };
  }

  /**
   * Record a tool result. ok=false increments the consecutive-failure
   * counter and latches the storm flag at the threshold.
   *
   * R3: when the harness supplies a stable result identity
   * (result.resultId — e.g. Claude tool_use_id, OpenCode call id),
   * duplicates are ignored: one execution is never counted twice, even
   * across restarts (identities persist hashed + bounded in the snapshot).
   * Without an identity, every delivery counts (documented per harness).
   */
  async function after(result = {}) {
    const ok = result.ok !== false && result.status !== "error" && !result.error;
    if (typeof result.cost === "number" && Number.isFinite(result.cost) && result.cost > 0) {
      recordCost(result.cost, { id: result.costId });
    }
    const rid = resultIdHash(result.resultId);
    if (rid) {
      if (seenResultSet.has(rid)) {
        return { storm: stormActive, duplicate: true };
      }
      seenResultSet.add(rid);
      seenResultIds.push(rid);
      while (seenResultIds.length > 200) {
        const dropped = seenResultIds.shift();
        if (!seenResultIds.includes(dropped)) seenResultSet.delete(dropped);
      }
    }
    if (ok) {
      consecutiveErrors = 0;
      stormActive = false;
      lastLatchAt = 0;
      lastLatchCount = -1;
      return { storm: false };
    }
    consecutiveErrors += 1;
    const tool = String(result.tool ?? "unknown");
    const summary = `${tool} failed ${consecutiveErrors}x in a row`;
    knownFailures.push(summary);
    while (knownFailures.length > 20) knownFailures.shift();
    if (consecutiveErrors >= cfg.maxConsecutiveErrors && !stormActive) {
      stormActive = true;
      // Double `after` delivery (observed live: two latch lines ~1 ms apart)
      // must not double-log: suppress a repeat latch for the same count
      // within a short window. A genuine new storm after recovery logs again
      // because success resets the dedupe markers above.
      const now = Date.now();
      if (now - lastLatchAt < 10_000 && lastLatchCount === consecutiveErrors) {
        return { storm: true, event: null };
      }
      lastLatchAt = now;
      lastLatchCount = consecutiveErrors;
      const event = {
        ts: Date.now(), event: "error_storm", tool,
        consecutive: consecutiveErrors, limit: cfg.maxConsecutiveErrors,
        action: cfg.mode === "deny" ? "blocked" : "warned",
      };
      if (cfg.mode === "deny") blockedCount += 1;
      else warnedCount += 1;
      await appendLog(event);
      return { storm: true, event };
    }
    return { storm: false };
  }

  function recordCost(amount, opts = {}) {
    // R10: identity-dedupe + delta-vs-cumulative semantics. Dormant unless a
    // harness delivers cost observations (none observed as of 1.18.27/1.18.31).
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return;
    const cid = resultIdHash(opts.id);
    if (cid) {
      if (seenCostIds.has(cid)) return; // same observation twice: ignore
      seenCostIds.add(cid);
      if (seenCostIds.size > 200) {
        const first = seenCostIds.values().next().value;
        seenCostIds.delete(first);
      }
    }
    if (opts.cumulative === true) {
      if (n > spentCost) spentCost = n; // provider_running total: take the max
    } else {
      spentCost += n; // default: each observation is a delta
    }
  }

  /** Hash a result/cost identity for dedupe; null when none supplied. */
  function resultIdHash(id) {
    if (id === undefined || id === null) return null;
    const s = String(id);
    if (!s) return null;
    try {
      return "rid@" + sha256hex("result|" + s).slice(0, 32);
    } catch {
      return null;
    }
  }

  function status() {
    return {
      totalCalls,
      blockedCount,
      warnedCount,
      consecutiveErrors,
      stormActive,
      spentCost,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      limits: {
        maxIdentical: cfg.maxIdentical,
        maxNearDuplicate: cfg.maxNearDuplicate,
        maxCalls: cfg.maxCalls,
        maxMinutes: cfg.maxMinutes,
        maxCost: cfg.maxCost,
        maxConsecutiveErrors: cfg.maxConsecutiveErrors,
      },
      knownFailures: [...knownFailures],
    };
  }

  // Keep canonical/normalizeText referenced for tree-shakers and tests.
  void canonical;
  void normalizeText;

  return { config: cfg, before, after, recordCost, status, hydrate, toSnapshot };
}
