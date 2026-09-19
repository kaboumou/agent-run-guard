import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";

test("error-storm latches after N consecutive failures and blocks next call", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 3 });
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" });
  let r = await eng.after({ ok: false, tool: "bash" });
  assert.equal(r.storm, true);
  const d = await eng.before({ tool: "bash", args: { command: "echo retry" } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "error_storm");
});

test("a success resets the consecutive-failure counter", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 2 });
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: true, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" });
  const d = await eng.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "allow");
});

test("tool.execute.after error status counts as failure", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 1 });
  const r = await eng.after({ ok: true, status: "error", tool: "bash" });
  assert.equal(r.storm, true);
});

test("warn mode logs storm instead of blocking", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 1, mode: "warn" });
  await eng.after({ ok: false, tool: "bash" });
  const d = await eng.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "warn");
});
