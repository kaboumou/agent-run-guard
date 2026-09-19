/**
 * Agent Run Guard — adapters/opencode-v1/plugin.js
 * OpenCode V1 adapter (live-proven on 1.18.27; object entrypoints require
 * OpenCode >= 1.18.29 — see the dual entry at adapters/opencode/index.js).
 * Imports the core engine: no duplicated policy.
 *
 * Hooks:
 * - tool.execute.before: all rules (repeats, budgets, dangerous, secrets)
 * - tool.execute.after:  error-storm recording (V1 has NO status field in
 *   1.18.27: failure comes from bash-style metadata.exit; stable identity
 *   from input.callID where present)
 * - message.updated:      cost-budget input where the event carries cost
 *   (never observed in `opencode run`; dormant unless a version delivers it)
 * - experimental.session.compacting: inject known failures + active budgets
 * - tool guard_status:    custom tool returning budget/block counters
 *
 * Steering on block (best-effort, never throws except the block itself):
 * - corrective reason is the thrown Error (reaches the model)
 * - optional context inject via client.session.prompt ≤1/30s
 * - optional single-attempt session.abort on hard limits (configurable;
 *   default cost-only; proven to stop `opencode run --auto` on 1.18.27)
 * - optional tui.showToast
 *
 * Fail-open: if this plugin crashes, OpenCode proceeds without it.
 * Best-effort guardrails, not an enforcement boundary.
 */

import { createEngine } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

function debugEventsOn() {
  const v = String(process.env.AGENT_RUN_GUARD_DEBUG_EVENTS || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function appendJsonl(logFile, event) {
  if (!logFile) return;
  try {
    const fs = await import("node:fs");
    fs.appendFileSync(logFile, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // Logging must never break a session.
  }
}

/** Extract a numeric cost (USD) from a message.updated payload, if present. */
export function extractCostUsd(event) {
  if (!event || typeof event !== "object") return null;
  const candidates = [
    event.cost,
    event.totalCost,
    event.usage?.cost,
    event.message?.cost,
    event.message?.info?.cost,
    event.info?.cost,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Extract a numeric process exit code from bash-style metadata, if present. */
export function extractExitCode(holder) {
  if (holder === null || holder === undefined) return null;
  let obj = holder;
  if (typeof holder === "string") {
    try {
      obj = JSON.parse(holder);
    } catch {
      const m = /"exit"\s*:\s*(-?\d+)/.exec(holder);
      return m ? Number(m[1]) : null;
    }
  }
  if (obj && typeof obj === "object" && Number.isFinite(Number(obj.exit))) {
    return Number(obj.exit);
  }
  return null;
}

/**
 * Decide whether a tool.execute.after payload means failure.
 * OpenCode 1.18.27 (measured 2026-09-19, sandbox): the after payload has NO
 * status field — keys are [title, metadata, output, attachments], and a
 * failing bash call surfaces as metadata {"output":"...","exit":1,...}.
 * We treat (a) status "error", (b) a non-empty error message, or (c) an
 * explicit numeric exit code !== 0 as failure. Absence of all three means
 * success (never assume failure from an unknown shape).
 */
export function afterFailed(input, output) {
  const status = output?.status ?? input?.status ?? null;
  if (status === "error" || status === "failed") return true;
  const err = output?.error?.message ?? input?.error?.message ?? output?.error ?? input?.error;
  if (typeof err === "string" && err.trim()) return true;
  if (err && typeof err === "object" && typeof err.message === "string" && err.message.trim())
    return true;
  for (const holder of [output?.metadata, input?.metadata]) {
    const exit = extractExitCode(holder);
    if (exit !== null) return exit !== 0;
  }
  return false;
}

/** Stable per-execution identity for result dedupe (R3): V1 after callID. */
export function afterResultId(input, output) {
  try {
    const id = input?.callID ?? input?.id ?? output?.callID ?? output?.id ?? null;
    if (id === null || id === undefined) return null;
    const s = String(id);
    return s ? s : null;
  } catch {
    return null;
  }
}

export function describeKeys(event, depth = 0) {
  if (!event || typeof event !== "object" || depth > 2) return typeof event;
  const out = {};
  for (const k of Object.keys(event).slice(0, 30)) {
    const v = event[k];
    out[k] = v && typeof v === "object" ? describeKeys(v, depth + 1) : typeof v;
  }
  return out;
}

export function createOpenCodeHooks({ engine, ctx, getConfig } = {}) {
  const loaded = loadConfig({ env: process.env });
  const eng = engine || createEngine(loaded.config);
  const cfgOf = typeof getConfig === "function" ? getConfig : () => eng.config;
  let lastInjectAt = 0;

  function sessionIdFrom(...cands) {
    for (const c of cands) {
      if (c && typeof c === "object") {
        const id = c.sessionId ?? c.sessionID ?? c.id ?? c.session?.id ?? c.session?.ID;
        if (typeof id === "string" && id) return id;
      } else if (typeof c === "string" && c) return c;
    }
    return null;
  }

  async function injectContext(sessionId, text) {
    const cfg = cfgOf();
    if (!cfg.injectContext) return "disabled";
    const now = Date.now();
    if (now - lastInjectAt < 30_000) return "rate-limited";
    try {
      const client = ctx?.client;
      if (!client?.session?.prompt) return "no-client";
      const body = { noReply: true, parts: [{ type: "text", text: String(text).slice(0, 2000) }] };
      // Session id shapes vary across SDK versions; try with then without path.
      try {
        if (sessionId) await client.session.prompt({ path: { id: sessionId }, body });
        else await client.session.prompt({ body });
      } catch {
        await client.session.prompt({ body });
      }
      lastInjectAt = now;
      return "injected";
    } catch {
      return "failed";
    }
  }

  // R9: single best-effort abort attempt. No retry loop — the old code
  // retried the identical expression, which could not succeed where the
  // first attempt failed. V2 uses ctx.session.interrupt (see opencode-v2).
  async function abortSession(sessionId) {
    try {
      const client = ctx?.client;
      if (!client?.session?.abort) return "no-client";
      if (!sessionId) return "no-session-id";
      await client.session.abort({ path: { id: sessionId } });
      return "aborted";
    } catch {
      return "failed";
    }
  }

  async function toast(message) {
    try {
      const t = ctx?.client?.tui?.showToast;
      if (typeof t === "function") {
        await t({ body: { message: String(message).slice(0, 300) } });
        return "toasted";
      }
      return "no-client";
    } catch {
      return "failed";
    }
  }

  async function onBlock({ sessionId, decision, event }) {
    const cfg = cfgOf();
    const tasks = [];
    tasks.push(injectContext(sessionId, `Agent Run Guard blocked a tool call: ${decision.reason}`));
    tasks.push(toast(`Agent Run Guard: ${event?.event || "blocked"}`));
    if (decision.hardLimit) {
      const kind = event?.kind || null;
      const want =
        cfg.abortMode === "always" || (cfg.abortMode === "cost-only" && kind === "cost");
      if (want) tasks.push(abortSession(sessionId));
    }
    const results = await Promise.all(tasks);
    await appendJsonl(cfg.logFile, {
      ts: Date.now(),
      event: "steer",
      block: event?.event || "unknown",
      inject: results[0],
      toast: results[1],
      abort: results[2] ?? "skipped",
    });
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? output?.tool ?? "unknown");
      const args = output?.args ?? input?.args ?? {};
      const decision = await eng.before({ tool, args });
      if (decision.action === "deny") {
        const sessionId = sessionIdFrom(input, output);
        await onBlock({ sessionId, decision, event: decision.event });
        throw new Error(decision.reason);
      }
      // warn/allow: proceed (warn already logged by the engine).
    },

    "tool.execute.after": async (input, output) => {
      try {
        const tool = String(input?.tool ?? output?.tool ?? "unknown");
        const ok = !afterFailed(input, output);
        await eng.after({ ok, tool, resultId: afterResultId(input, output) });
      } catch {
        // after-hooks must never break the session.
      }
    },

    "message.updated": async (input, output) => {
      try {
        const evt = output ?? input ?? {};
        const cost = extractCostUsd(evt);
        if (typeof cost === "number") eng.recordCost(cost);
        if (debugEventsOn()) {
          await appendJsonl(cfgOf().logFile, {
            ts: Date.now(),
            event: "debug_event",
            name: "message.updated",
            keys: describeKeys(evt),
            costFound: cost,
          });
        }
      } catch {
        // Never break the session.
      }
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const st = eng.status();
        const lines = [];
        lines.push("Agent Run Guard memory:");
        lines.push(`- tool calls used: ${st.totalCalls}/${st.limits.maxCalls}; blocked: ${st.blockedCount}; warned: ${st.warnedCount}.`);
        if (st.consecutiveErrors > 0)
          lines.push(`- consecutive tool failures: ${st.consecutiveErrors} (limit ${st.limits.maxConsecutiveErrors}).`);
        for (const f of st.knownFailures.slice(-5)) lines.push(`- failure: ${f}`);
        const text = lines.join("\n");
        if (output && typeof output === "object") {
          if (typeof output.context === "string") output.context += "\n" + text;
          else if (output.context === undefined) output.context = text;
        }
      } catch {
        // Never break compaction.
      }
    },

    tool: {
      guard_status: {
        description: "Agent Run Guard counters: tool-call budget use, blocks, warnings, failures.",
        args: {},
        async execute() {
          try {
            return JSON.stringify(eng.status());
          } catch {
            return '{"error":"status unavailable"}';
          }
        },
      },
    },

    __engine: eng,
  };
}

/** The OpenCode V1 plugin entry point (loaded with ctx). */
export const AgentRunGuard = async (ctx) => {
  const { config } = loadConfig({ env: process.env });
  return createOpenCodeHooks({ engine: createEngine(config), ctx });
};

export default AgentRunGuard;
