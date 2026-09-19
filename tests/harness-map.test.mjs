import { test } from "node:test";
import assert from "node:assert/strict";
import { toCanonical, fromDecision } from "../adapters/harness-map.js";

test("claude-code: allow maps to no output; deny maps to permissionDecision", () => {
  const canon = toCanonical(
    { session_id: "s1", cwd: "/x", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } },
    "claude-code"
  );
  assert.equal(canon.tool, "Bash");
  assert.equal(canon.sessionId, "s1");
  let m = fromDecision({ action: "allow", reason: "" }, "claude-code");
  assert.equal(m.stdout, null);
  assert.equal(m.exitCode, 0);
  m = fromDecision({ action: "deny", reason: "nope" }, "claude-code");
  assert.equal(m.stdout.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(m.stdout.hookSpecificOutput.permissionDecisionReason, "nope");
});

test("codex: deny uses the documented envelope", () => {
  const m = fromDecision({ action: "deny", reason: "bad" }, "codex");
  assert.equal(m.stdout.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(m.exitCode, 0);
});

test("gemini: deny vs kill (continue:false on hard limits)", () => {
  let m = fromDecision({ action: "deny", reason: "bad", hardLimit: false }, "gemini-cli");
  assert.deepEqual(m.stdout, { decision: "deny", reason: "bad" });
  m = fromDecision({ action: "deny", reason: "over budget", hardLimit: true }, "gemini-cli");
  assert.equal(m.stdout.continue, false);
  assert.equal(m.stdout.stopReason, "over budget");
});

test("crush: deny vs halt on hard limits", () => {
  let m = fromDecision({ action: "deny", reason: "bad", hardLimit: false }, "crush");
  assert.equal(m.stdout.decision, "deny");
  assert.equal(m.stdout.halt, undefined);
  m = fromDecision({ action: "deny", reason: "over budget", hardLimit: true }, "crush");
  assert.equal(m.stdout.halt, true);
});

test("crush stdin shape maps (event/session_id/tool_name/tool_input)", () => {
  const canon = toCanonical(
    { event: "PreToolUse", session_id: "c1", cwd: "/y", tool_name: "Bash", tool_input: { command: "ls" } },
    "crush"
  );
  assert.equal(canon.tool, "Bash");
  assert.equal(canon.hookEvent, "PreToolUse");
  assert.equal(canon.sessionId, "c1");
});

test("gemini stdin shape maps (BeforeTool + hook_event_name)", () => {
  const canon = toCanonical(
    { session_id: "g1", hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls" } },
    "gemini-cli"
  );
  assert.equal(canon.tool, "run_shell_command");
  assert.equal(canon.hookEvent, "BeforeTool");
});

test("warn/allow never block in any harness", () => {
  for (const h of ["claude-code", "codex", "gemini-cli", "crush", "generic"]) {
    assert.equal(fromDecision({ action: "warn", reason: "x" }, h).stdout, null);
  }
});
