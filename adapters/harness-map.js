/**
 * Agent Run Guard — adapters/harness-map.js
 * Pure ESM, stdlib-only. Maps per-harness hook stdin JSON to a canonical
 * event and maps a canonical decision back to harness stdout JSON + exit code.
 *
 * Supported --harness values: opencode (unused by CLI; plugin path),
 * claude-code, codex, gemini-cli, crush, generic.
 */

export const HARNESSES = ["claude-code", "codex", "gemini-cli", "crush", "generic", "opencode"];

/**
 * Parse hook stdin into a canonical call.
 * Returns { tool, args, sessionId, cwd, hookEvent, failureHint, resultId, raw }.
 * resultId is the harness's stable per-execution identity where provided
 * (Claude tool_use_id; OpenCode V1 callID; best-effort elsewhere) — used to
 * dedupe duplicate result deliveries. Never throws on odd shapes.
 */
export function toCanonical(input = {}, harness = "generic") {
  const raw = input && typeof input === "object" ? input : {};
  const h = String(harness || "generic").toLowerCase();
  let tool = raw.tool_name ?? raw.tool ?? "unknown";
  let args = raw.tool_input ?? raw.args ?? raw.input ?? {};
  let sessionId = raw.session_id ?? raw.sessionId ?? null;
  let cwd = raw.cwd ?? null;
  let hookEvent = raw.hook_event_name ?? raw.hookEventName ?? raw.event ?? null;

  if (h === "crush") {
    tool = raw.tool_name ?? tool;
    args = raw.tool_input ?? args;
    sessionId = raw.session_id ?? sessionId;
    hookEvent = raw.event ?? hookEvent;
  }

  if (typeof tool !== "string" || !tool) tool = "unknown";
  if (args === null || args === undefined) args = {};
  if (typeof sessionId !== "string") sessionId = sessionId == null ? null : String(sessionId);
  if (typeof cwd !== "string") cwd = cwd == null ? null : String(cwd);
  if (typeof hookEvent !== "string") hookEvent = hookEvent == null ? null : String(hookEvent);

  // PostToolUse-style payloads may carry the result; surface a failure hint
  // so the CLI can record error-storm data where the harness provides it.
  const failureHint = detectFailureHint(raw, hookEvent);

  // Stable per-execution identity for result dedupe (R3). Only trusted on
  // result-style events; before-events are distinct calls by definition.
  const resultId = extractResultId(raw, hookEvent);

  return { tool, args, sessionId, cwd, hookEvent, failureHint, resultId, raw };
}

/**
 * Extract a stable result identity where the harness provides one:
 * Claude tool_use_id; OpenCode V1 after input.callID; best-effort call/id
 * fields elsewhere. Null when absent — then every delivery counts
 * (documented per harness in the README).
 */
export function extractResultId(raw = {}, hookEvent = null) {
  try {
    const ev = String(hookEvent || "").toLowerCase();
    if (!/post|after|result/.test(ev)) return null;
    const id =
      raw.tool_use_id ?? raw.toolUseId ?? raw.callID ?? raw.call_id ?? raw.callId ?? null;
    if (id === null || id === undefined) return null;
    const s = String(id);
    return s ? s : null;
  } catch {
    return null;
  }
}

function detectFailureHint(raw, hookEvent) {
  try {
    const ev = String(hookEvent || "").toLowerCase();
    if (!/post|after|result/.test(ev)) return null;
    const resp = raw.tool_response ?? raw.toolResponse ?? raw.result ?? raw.output;
    if (resp === null || resp === undefined) return null;
    if (typeof resp === "object") {
      if (resp.success === false || resp.is_error === true || resp.isError === true) return true;
      const status = String(resp.status ?? "").toLowerCase();
      if (status === "error" || status === "failed") return true;
      const err = resp.error ?? resp.stderr;
      if (typeof err === "string" && err.trim()) return true;
    }
    if (typeof resp === "string" && /^\s*{\s*"[^}]*"(error|failed)/i.test(resp)) return true;
    return false;
  } catch {
    return null;
  }
}

/**
 * Map a canonical decision to harness output.
 * decision: { action: "allow"|"warn"|"deny", reason, hardLimit }
 * Returns { stdout: object|null, exitCode: number }.
 *
 * Conventions (per verified harness docs):
 * - claude-code PreToolUse: exit 0 + hookSpecificOutput permissionDecision deny; no output = allow.
 * - codex PreToolUse: same envelope family; exit 2 + stderr also blocks (we use stdout JSON).
 * - gemini-cli BeforeTool: {"decision":"deny","reason"} or {"continue":false,"stopReason"} to kill.
 * - crush PreToolUse: {"decision":"deny"|"allow","reason","halt"}; exit 2 also denies.
 * - warn/allow: no blocking output (exit 0, stdout null).
 */
export function fromDecision(decision = {}, harness = "generic") {
  const h = String(harness || "generic").toLowerCase();
  const action = decision.action ?? "allow";
  const reason = String(decision.reason || "Blocked by Agent Run Guard.");
  const hardLimit = decision.hardLimit === true;

  if (action === "allow" || action === "warn") {
    return { stdout: null, exitCode: 0 };
  }

  // deny path per harness
  if (h === "claude-code" || h === "codex") {
    const eventName = h === "codex" ? "PreToolUse" : "PreToolUse";
    return {
      exitCode: 0,
      stdout: {
        hookSpecificOutput: {
          hookEventName: eventName,
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      },
    };
  }
  if (h === "gemini-cli") {
    if (hardLimit) {
      return { exitCode: 0, stdout: { continue: false, stopReason: reason } };
    }
    return { exitCode: 0, stdout: { decision: "deny", reason } };
  }
  if (h === "crush") {
    const out = { decision: "deny", reason };
    if (hardLimit) out.halt = true;
    return { exitCode: 0, stdout: out };
  }
  // generic / opencode fallback
  const generic = { decision: "deny", reason };
  if (hardLimit) generic.halt = true;
  return { exitCode: 0, stdout: generic };
}

/** Session key inputs for the CLI state file (session id or cwd fallback). */
export function sessionKeyInput(canonicalEvt, cliCwd) {
  return {
    sessionId: canonicalEvt.sessionId || null,
    cwd: canonicalEvt.cwd || cliCwd || null,
  };
}

const HOOK_KEYS = [
  "tool_name",
  "tool_input",
  "tool",
  "args",
  "input",
  "hook_event_name",
  "hookEventName",
  "event",
  "session_id",
  "sessionId",
  "sessionID",
  "transcript_path",
  "tool_use_id",
  "cwd",
];

/**
 * True when a parsed stdin value looks like a harness hook payload.
 * Empty objects, arrays, and unrelated JSON are NOT hook payloads — the CLI
 * ignores them (exit 0, no state write, no budget consumed).
 */
export function looksLikeHook(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  return HOOK_KEYS.some((k) => payload[k] !== undefined && payload[k] !== null);
}
