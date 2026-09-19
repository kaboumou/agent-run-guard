import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";
import { createOpenCodeHooks, afterFailed, extractExitCode } from "../adapters/opencode/plugin.js";

function before(hooks, tool, args) {
  return hooks["tool.execute.before"]({ tool }, { args });
}
function after(hooks, tool, status) {
  return hooks["tool.execute.after"]({ tool }, { status });
}

test("opencode: before blocks identical repeats with corrective reason", async () => {
  const eng = createEngine({ maxIdentical: 1, maxCalls: 100 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await before(hooks, "bash", { command: "echo hi" });
  await assert.rejects(() => before(hooks, "bash", { command: "echo hi" }), /Change the approach/);
});

test("opencode: after(error) x N latches storm; next before blocks", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 2 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await after(hooks, "bash", "completed");
  await after(hooks, "bash", "error");
  await after(hooks, "bash", "error");
  await assert.rejects(() => before(hooks, "bash", { command: "echo hi" }), /consecutive tool failures/);
});

test("opencode: message.updated records cost when present", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxCost: 0.01 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await hooks["message.updated"]({}, { cost: 0.05 });
  await assert.rejects(() => before(hooks, "bash", { command: "echo hi" }), /cost budget/);
});

test("opencode: compacting hook injects guard memory into output.context", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await before(hooks, "bash", { command: "echo hi" });
  const output = {};
  await hooks["experimental.session.compacting"]({}, output);
  assert.match(output.context, /Agent Run Guard memory/);
});

test("opencode: guard_status tool returns counters JSON", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await before(hooks, "bash", { command: "echo hi" });
  const text = await hooks.tool.guard_status.execute({}, {});
  const st = JSON.parse(text);
  assert.equal(st.totalCalls, 1);
});

test("opencode: block path never throws from steering (no client)", async () => {
  const eng = createEngine({ maxIdentical: 1, maxCalls: 100 });
  const hooks = createOpenCodeHooks({ engine: eng, ctx: {} });
  await before(hooks, "bash", { command: "echo hi" });
  // Second call must reject with the guard reason (not a steering TypeError).
  await assert.rejects(() => before(hooks, "bash", { command: "echo hi" }), /Agent Run Guard/);
});

test("afterFailed: 1.18.27 metadata exit codes (measured 2026-09-19)", () => {
  // Failing bash: metadata JSON string with exit 1.
  assert.equal(
    afterFailed(
      { tool: "bash" },
      { title: "x", metadata: '{"output":"(no output)","exit":1}', output: '"(no output)"' }
    ),
    true
  );
  // Successful bash: exit 0.
  assert.equal(
    afterFailed({ tool: "bash" }, { metadata: '{"output":"hi","exit":0}', output: '"hi"' }),
    false
  );
  // Object-form metadata.
  assert.equal(afterFailed({}, { metadata: { exit: 2 } }), true);
  assert.equal(afterFailed({}, { metadata: { exit: 0 } }), false);
  // Legacy documented shape still counts.
  assert.equal(afterFailed({}, { status: "error" }), true);
  assert.equal(afterFailed({}, { error: { message: "boom" } }), true);
  // Unknown shape without signals: success (never assume failure).
  assert.equal(afterFailed({ tool: "bash" }, { title: "x", output: '"hi"' }), false);
});

test("extractExitCode handles string/object/missing metadata", () => {
  assert.equal(extractExitCode('{"exit":1}'), 1);
  assert.equal(extractExitCode({ exit: 0 }), 0);
  assert.equal(extractExitCode(undefined), null);
  assert.equal(extractExitCode("not json"), null);
});
