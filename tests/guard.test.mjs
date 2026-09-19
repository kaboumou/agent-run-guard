import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGuard } from "../plugin/agent-run-guard.js";

function call(hooks, tool, args) {
  return hooks["tool.execute.before"]({ tool }, { args });
}

test("allows identical calls up to the limit, blocks the next one", async () => {
  const guard = createGuard({ maxIdentical: 3, maxCalls: 100 });
  await call(guard, "bash", { command: "pytest -x -q" });
  await call(guard, "bash", { command: "pytest -x -q" });
  await call(guard, "bash", { command: "pytest -x -q" });
  await assert.rejects(
    () => call(guard, "bash", { command: "pytest -x -q" }),
    /identical.*blocked|blocked/i
  );
});

test("identical means canonical args, not key order", async () => {
  const guard = createGuard({ maxIdentical: 1, maxCalls: 100 });
  await call(guard, "bash", { b: 2, a: 1 });
  await assert.rejects(() => call(guard, "bash", { a: 1, b: 2 }), /blocked/i);
});

test("a different argument is not a repeat", async () => {
  const guard = createGuard({ maxIdentical: 1, maxCalls: 100 });
  await call(guard, "bash", { command: "echo one" });
  await call(guard, "bash", { command: "echo two" });
  await call(guard, "read", { filePath: "a.txt" });
  // reaching here without a throw is the assertion
});

test("budget blocks after the configured number of calls", async () => {
  const guard = createGuard({ maxIdentical: 100, maxCalls: 2 });
  await call(guard, "read", { filePath: "a" });
  await call(guard, "read", { filePath: "b" });
  await assert.rejects(() => call(guard, "read", { filePath: "c" }), /budget/i);
});

test("warn mode never throws but logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-"));
  const logFile = join(dir, "guard.jsonl");
  const guard = createGuard({ maxIdentical: 1, maxCalls: 100, mode: "warn", logFile });
  await call(guard, "bash", { command: "same" });
  await call(guard, "bash", { command: "same" });
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "identical_repeat");
  assert.equal(event.action, "warned");
});

test("deny mode logs the block event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-"));
  const logFile = join(dir, "guard.jsonl");
  const guard = createGuard({ maxIdentical: 1, maxCalls: 100, mode: "deny", logFile });
  await call(guard, "bash", { command: "same" });
  await assert.rejects(() => call(guard, "bash", { command: "same" }), /blocked/i);
  const event = JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0]);
  assert.equal(event.action, "blocked");
});
