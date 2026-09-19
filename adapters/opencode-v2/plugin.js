/**
 * Agent Run Guard — adapters/opencode-v2/plugin.js
 * OpenCode V2 adapter (primary). Written against the published
 * `@opencode/plugin@2.0.9` types (inspected locally; `Plugin.define` is the
 * identity function, so this file has NO runtime dependency on that package —
 * it exports the `{ id, setup }` shape directly).
 *
 * Verified V2 shapes used (dist/promise/*.d.ts + migrate-v1 guide):
 * - ctx.tool.hook("execute.before", (event) => ...) — event { tool,
 *   sessionID, agent, messageID, id, input }; throw = block.
 * - ctx.tool.hook("execute.after", ...) — same + status "completed"|"error";
 *   event.id (CallID) is the stable result identity for R3 dedupe.
 * - ctx.session.hook("compaction", ...) — SessionCompaction carries system/
 *   messages; we append a memory line to system (best-effort, never set
 *   `result` so the model compaction still runs).
 * - ctx.tool.transform((editor) => editor.add({ name, description,
 *   input: <JSON schema>, execute })) — guard_status tool.
 * - ctx.event.subscribe({ signal }) — async iterable; observed for cost
 *   fields (R10; dormant unless a version delivers cost).
 * - ctx.session.synthetic({ sessionID, text }) preferred for context inject,
 *   ctx.session.prompt({ sessionID, text }) as fallback.
 * - ctx.session.interrupt({ sessionID }) — single best-effort attempt on
 *   hard limits (R9). NOTE: the published 2.0.9 type has NO `continue`
 *   field; earlier notes mentioning `continue:false` were corrected.
 *
 * Live status: V2 wiring is exercised by unit/dry-run tests only — no
 * V2-capable runtime is installable in this sandbox (see report). The V1
 * path (adapters/opencode-v1) is the live-proven one.
 */

import { createEngine } from "../../core/engine.js";
import { loadConfig } from "../../core/config.js";

export const PLUGIN_ID = "agent-run-guard";

/** Shared compaction/context memory text (same content as the V1 hook). */
export function memoryText(st) {
  const lines = [];
  lines.push("Agent Run Guard memory:");
  lines.push(
    `- tool calls used: ${st.totalCalls}/${st.limits.maxCalls}; blocked: ${st.blockedCount}; warned: ${st.warnedCount}.`
  );
  if (st.consecutiveErrors > 0)
    lines.push(
      `- consecutive tool failures: ${st.consecutiveErrors} (limit ${st.limits.maxConsecutiveErrors}).`
    );
  for (const f of st.knownFailures.slice(-5)) lines.push(`- failure: ${f}`);
  return lines.join("\n");
}

/** Numeric cost scan over an unknown event shape (R10 observation path). */
export function extractEventCost(event) {
  if (!event || typeof event !== "object") return null;
  try {
    const candidates = [
      event.cost,
      event.totalCost,
      event.usage?.cost,
      event.message?.cost,
      event.tokens?.cost,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // never break on odd shapes
  }
  return null;
}

function eventIdOf(event) {
  try {
    const id = event?.messageID ?? event?.id ?? event?.message?.id ?? null;
    if (id === null || id === undefined) return null;
    const s = String(id);
    return s ? s : null;
  } catch {
    return null;
  }
}

/**
 * Wire the guard onto a V2 plugin context. Returns { engine, cleanup }.
 * Every host interaction is best-effort try/catch: a failed steering call
 * must never break the session (fail-open).
 */
export async function setupGuard(ctx, opts = {}) {
  const fileCfg = opts.fileObj || {};
  const optOverrides = (ctx && typeof ctx === "object" ? ctx.options : null) || {};
  const { config } = loadConfig({ fileObj: fileCfg, env: process.env, overrides: optOverrides });
  const engine = opts.engine || createEngine(config);
  const cleanups = [];
  let lastInjectAt = 0;

  const has = (path) => {
    try {
      const parts = path.split(".");
      let o = ctx;
      for (const p of parts) {
        if (o === null || o === undefined) return false;
        o = o[p];
      }
      return typeof o === "function";
    } catch {
      return false;
    }
  };

  async function injectContext(sessionID, text) {
    if (!config.injectContext) return "disabled";
    const now = Date.now();
    if (now - lastInjectAt < 30_000) return "rate-limited";
    const short = String(text).slice(0, 2000);
    if (has("session.synthetic")) {
      try {
        await ctx.session.synthetic({ sessionID, text: short });
        lastInjectAt = now;
        return "injected-synthetic";
      } catch {
        // fall through to prompt
      }
    }
    if (has("session.prompt")) {
      try {
        await ctx.session.prompt({ sessionID, text: short });
        lastInjectAt = now;
        return "injected-prompt";
      } catch {
        return "failed";
      }
    }
    return "no-client";
  }

  async function interruptSession(sessionID) {
    if (!has("session.interrupt")) return "no-client";
    if (!sessionID) return "no-session-id";
    try {
      await ctx.session.interrupt({ sessionID });
      return "interrupted";
    } catch {
      return "failed";
    }
  }

  async function onBlock({ sessionID, decision, event }) {
    const results = [];
    results.push(await injectContext(sessionID, `Agent Run Guard blocked a tool call: ${decision.reason}`));
    if (decision.hardLimit) {
      const kind = event?.kind || null;
      const want =
        config.abortMode === "always" || (config.abortMode === "cost-only" && kind === "cost");
      results.push(want ? await interruptSession(sessionID) : "skipped");
    } else {
      results.push("skipped");
    }
    if (config.logFile) {
      try {
        const fs = await import("node:fs");
        fs.appendFileSync(
          config.logFile,
          JSON.stringify({
            ts: Date.now(),
            event: "steer",
            runtime: "opencode-v2",
            block: event?.event || "unknown",
            inject: results[0],
            interrupt: results[1],
          }) + "\n",
          "utf8"
        );
      } catch {
        // Logging must never break a session.
      }
    }
    return results;
  }

  if (ctx && ctx.tool && typeof ctx.tool.hook === "function") {
    try {
      await ctx.tool.hook("execute.before", async (event) => {
        const tool = String(event?.tool ?? "unknown");
        const args = event?.input ?? {};
        const decision = await engine.before({ tool, args });
        if (decision.action === "deny") {
          await onBlock({ sessionID: event?.sessionID, decision, event: decision.event });
          throw new Error(decision.reason);
        }
      });
    } catch {
      // Hook registration failed: fail open.
    }
    try {
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          const tool = String(event?.tool ?? "unknown");
          const ok = event?.status !== "error";
          await engine.after({ ok, tool, resultId: event?.id ?? null });
        } catch {
          // after-hooks must never break the session.
        }
      });
    } catch {
      // Hook registration failed: fail open.
    }
    try {
      await ctx.tool.transform((editor) => {
        try {
          editor.add({
            name: "guard_status",
            description:
              "Agent Run Guard counters: tool-call budget use, blocks, warnings, failures.",
            input: {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            },
            execute: async () => {
              try {
                return { content: JSON.stringify(engine.status()) };
              } catch {
                return { content: '{"error":"status unavailable"}' };
              }
            },
          });
        } catch {
          // Editor failures must not break setup.
        }
      });
    } catch {
      // Transform failed: guard_status unavailable, guard still runs.
    }
  }

  if (ctx && ctx.session && typeof ctx.session.hook === "function") {
    try {
      await ctx.session.hook("compaction", (event) => {
        try {
          if (event && Array.isArray(event.system)) {
            event.system.push({ type: "text", text: memoryText(engine.status()) });
            return "appended-system";
          }
          return "no-system";
        } catch {
          return "failed";
        }
      });
    } catch {
      // fail open
    }
  }

  // Cost observation via the public event stream (R10). Dormant unless a
  // version delivers cost fields; abortable via the setup cleanup.
  try {
    if (ctx && ctx.event && typeof ctx.event.subscribe === "function") {
      const controller = new AbortController();
      const pump = (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              const cost = extractEventCost(event);
              if (typeof cost === "number") {
                engine.recordCost(cost, { id: eventIdOf(event) });
              }
            } catch {
              // per-event errors must not kill the loop
            }
          }
        } catch {
          // Subscription ended/aborted: fail open.
        }
      })();
      void pump;
      cleanups.push(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // fail open
  }

  const cleanup = () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };

  return { engine, config, cleanup, injectContext, interruptSession };
}

/**
 * The V2 plugin definition. Plain object literal — `Plugin.define` from
 * `@opencode/plugin` is the identity function (verified in 2.0.9 dist), so
 * no runtime dependency is needed. With TS: `Plugin.define({...})`.
 */
const definition = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const { cleanup } = await setupGuard(ctx);
    return cleanup;
  },
};

export default definition;
