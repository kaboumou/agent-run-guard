import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";
import { extractResultId } from "../adapters/harness-map.js";
import { afterResultId } from "../adapters/opencode-v1/plugin.js";

// ---- R3: duplicate result delivery must not manufacture storms ----

test("R3: same result id twice counts one failure", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 5 });
  let r = await eng.after({ ok: false, tool: "bash", resultId: "call-1" });
  assert.equal(r.duplicate, undefined);
  r = await eng.after({ ok: false, tool: "bash", resultId: "call-1" });
  assert.equal(r.duplicate, true);
  assert.equal(eng.status().consecutiveErrors, 1);
});

test("R3: two distinct ids count twice", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 5 });
  await eng.after({ ok: false, tool: "bash", resultId: "call-a" });
  await eng.after({ ok: false, tool: "bash", resultId: "call-b" });
  assert.equal(eng.status().consecutiveErrors, 2);
});

test("R3: duplicate success changes no state", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 5 });
  await eng.after({ ok: false, tool: "bash", resultId: "f-1" });
  const before = eng.status().consecutiveErrors;
  const r = await eng.after({ ok: true, tool: "bash", resultId: "s-1" });
  assert.equal(eng.status().consecutiveErrors, 0);
  const r2 = await eng.after({ ok: true, tool: "bash", resultId: "s-1" });
  assert.equal(r2.duplicate, true);
  assert.equal(eng.status().consecutiveErrors, 0);
  void r;
  void before;
});

test("R3: restart between duplicates still dedupes (persisted ids)", async () => {
  const e1 = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 2 });
  await e1.after({ ok: false, tool: "bash", resultId: "call-x" });
  const snap = e1.toSnapshot();
  const e2 = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 2, snapshot: snap });
  const r = await e2.after({ ok: false, tool: "bash", resultId: "call-x" });
  assert.equal(r.duplicate, true);
  assert.equal(e2.status().consecutiveErrors, 1);
  assert.equal(e2.status().stormActive, false);
});

test("R3: persisted ids are bounded and hash-only", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 1000, maxConsecutiveErrors: 100000 });
  for (let i = 0; i < 250; i++) {
    await eng.after({ ok: false, tool: "bash", resultId: `call-${i}` });
  }
  const snap = eng.toSnapshot();
  assert.ok(snap.seenResultIds.length <= 200);
  for (const h of snap.seenResultIds) {
    assert.match(h, /^rid@[0-9a-f]{32}$/);
  }
  assert.ok(!JSON.stringify(snap).includes("call-42"));
});

test("R3: no identity — every delivery counts (documented fallback)", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 5 });
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" });
  assert.equal(eng.status().consecutiveErrors, 2);
});

test("R3: harness identity extraction", () => {
  // Claude PostToolUse with tool_use_id.
  assert.equal(
    extractResultId({ tool_use_id: "tu_123" }, "PostToolUse"),
    "tu_123"
  );
  // PreToolUse carries no result identity.
  assert.equal(extractResultId({ tool_use_id: "tu_123" }, "PreToolUse"), null);
  // OpenCode V1 after input.callID (measured key).
  assert.equal(afterResultId({ tool: "bash", callID: "c-9" }, {}), "c-9");
  assert.equal(afterResultId({ tool: "bash" }, {}), null);
  assert.equal(extractResultId({}, "PostToolUse"), null);
});

// ---- R10: cost identity-dedupe + delta/cumulative ----

test("R10: delta costs add; same observation id adds once", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxCost: 10 });
  eng.recordCost(0.02, { id: "obs-1" });
  eng.recordCost(0.02, { id: "obs-1" });
  eng.recordCost(0.03, { id: "obs-2" });
  assert.equal(eng.status().spentCost.toFixed(2), "0.05");
});

test("R10: cumulative observations take the max", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxCost: 10 });
  eng.recordCost(0.05, { cumulative: true });
  eng.recordCost(0.03, { cumulative: true });
  assert.equal(eng.status().spentCost.toFixed(2), "0.05");
  eng.recordCost(0.09, { cumulative: true });
  assert.equal(eng.status().spentCost.toFixed(2), "0.09");
});

test("R10: invalid costs ignored", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100 });
  eng.recordCost(NaN);
  eng.recordCost(-1);
  eng.recordCost(0);
  eng.recordCost("nope");
  assert.equal(eng.status().spentCost, 0);
});
