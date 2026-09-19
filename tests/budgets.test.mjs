import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";

test("time budget off by default (maxMinutes=0)", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxMinutes: 0 });
  const d = await eng.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "allow");
});

test("time budget blocks when elapsed exceeds limit", async () => {
  const eng = createEngine({
    maxIdentical: 100, maxCalls: 100, maxMinutes: 60,
    startedAt: Date.now() - 61 * 60_000,
  });
  const d = await eng.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "budget");
  assert.equal(d.event.kind, "time");
  assert.equal(d.hardLimit, true);
});

test("cost budget off by default; blocks once spent >= limit", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxCost: 0.01 });
  let d = await eng.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "allow");
  eng.recordCost(0.02);
  d = await eng.before({ tool: "bash", args: { command: "echo hi2" } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.kind, "cost");
  assert.equal(d.hardLimit, true);
});

test("call budget marks hardLimit for loop-stop adapters", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 1 });
  await eng.before({ tool: "read", args: { f: "a" } });
  const d = await eng.before({ tool: "read", args: { f: "b" } });
  assert.equal(d.action, "deny");
  assert.equal(d.hardLimit, true);
});
