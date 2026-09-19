/**
 * Agent Run Guard — plugin/agent-run-guard.js (compat shim, v0.1 path)
 * Re-exports the real OpenCode adapter at adapters/opencode/plugin.js.
 * The named `createGuard` factory is preserved so existing tests and
 *Prototype-era configs keep working; new code should import core/engine.js.
 */

import { createEngine } from "../core/engine.js";
import { afterFailed, afterResultId } from "../adapters/opencode/plugin.js";

export { AgentRunGuard, createOpenCodeHooks, default } from "../adapters/opencode/plugin.js";

/** Pure factory — same v0.1 semantics (identical repeats + call budget). */
export function createGuard(options = {}) {
  const engine = createEngine({ ...options });
  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "unknown");
      const args = output?.args ?? {};
      const decision = await engine.before({ tool, args });
      if (decision.action === "deny") throw new Error(decision.reason);
    },
    "tool.execute.after": async (input, output) => {
      try {
        const ok = !afterFailed(input, output);
        await engine.after({
          ok,
          tool: String(input?.tool ?? "unknown"),
          resultId: afterResultId(input, output),
        });
      } catch {
        // Never break the session.
      }
    },
    __engine: engine,
  };
}
