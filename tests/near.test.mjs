import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";
import { normalizeText } from "../core/canonical.js";

test("near-duplicate: whitespace-only differences count as repeats", async () => {
  const eng = createEngine({ maxIdentical: 100, maxNearDuplicate: 2, maxCalls: 100 });
  let d = await eng.before({ tool: "bash", args: { command: "echo hello" } });
  assert.equal(d.action, "allow");
  d = await eng.before({ tool: "bash", args: { command: "echo   hello" } });
  assert.equal(d.action, "allow");
  d = await eng.before({ tool: "bash", args: { command: "echo hello " } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "near_repeat");
});

test("near-duplicate: timestamps/uuids stripped before hashing", async () => {
  const eng = createEngine({ maxIdentical: 100, maxNearDuplicate: 1, maxCalls: 100 });
  await eng.before({ tool: "bash", args: { command: "run job 2026-09-19T12:00:00Z id 550e8400-e29b-41d4-a716-446655440000" } });
  const d = await eng.before({ tool: "bash", args: { command: "run job 2026-09-19T12:05:00Z id 123e4567-e89b-12d3-a456-426614174000" } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "near_repeat");
});

test("near-duplicate: genuinely different commands are not repeats", async () => {
  const eng = createEngine({ maxIdentical: 100, maxNearDuplicate: 1, maxCalls: 100 });
  await eng.before({ tool: "bash", args: { command: "echo one" } });
  const d = await eng.before({ tool: "bash", args: { command: "echo two" } });
  assert.equal(d.action, "allow");
});

test("normalizeText collapses whitespace and masks volatile tokens", () => {
  const a = normalizeText("echo   hello\tworld");
  assert.equal(a, "echo hello world");
  assert.match(normalizeText("at 2026-09-19T12:34:56Z done"), /<TS>/);
  assert.match(normalizeText("id 550e8400-e29b-41d4-a716-446655440000"), /<ID>/);
  assert.match(normalizeText("pid 12345 crashed"), /<PID>/);
});
