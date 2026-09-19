import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, validateConfig, DEFAULTS } from "../core/config.js";

test("R4 file path: 0/negative/NaN/string counts fall back with warnings", () => {
  let r = loadConfig({ fileObj: { maxCalls: 0 }, env: {} });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);
  assert.ok(r.warnings.some((w) => w.includes("maxCalls")));

  r = loadConfig({ fileObj: { maxCalls: -5 }, env: {} });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);

  r = loadConfig({ fileObj: { maxCalls: NaN }, env: {} });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);

  r = loadConfig({ fileObj: { maxCalls: "abc" }, env: {} });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);

  r = loadConfig({ fileObj: { maxCalls: "10" }, env: {} });
  assert.equal(r.config.maxCalls, 10); // numeric strings accepted

  r = loadConfig({ fileObj: { maxCalls: 2.9 }, env: {} });
  assert.equal(r.config.maxCalls, 2); // floored

  r = loadConfig({ fileObj: { maxConsecutiveErrors: 0 }, env: {} });
  assert.equal(r.config.maxConsecutiveErrors, DEFAULTS.maxConsecutiveErrors);
});

test("R4 env path: 0/negative/NaN/strings behave like the file path", () => {
  let r = loadConfig({ env: { AGENT_RUN_GUARD_MAX_CALLS: "0" } });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);
  assert.ok(r.warnings.length > 0);

  r = loadConfig({ env: { AGENT_RUN_GUARD_MAX_CALLS: "-3" } });
  assert.equal(r.config.maxCalls, DEFAULTS.maxCalls);

  r = loadConfig({ env: { AGENT_RUN_GUARD_MAX_IDENTICAL: "NaN" } });
  assert.equal(r.config.maxIdentical, DEFAULTS.maxIdentical);

  r = loadConfig({ env: { AGENT_RUN_GUARD_MAX_NEAR: "4" } });
  assert.equal(r.config.maxNearDuplicate, 4);
});

test("R4 maxMinutes: 0 disabled, else >= 1", () => {
  assert.equal(loadConfig({ fileObj: { maxMinutes: 0 }, env: {} }).config.maxMinutes, 0);
  assert.equal(loadConfig({ fileObj: {}, env: {} }).config.maxMinutes, 0);
  assert.equal(loadConfig({ fileObj: { maxMinutes: -1 }, env: {} }).config.maxMinutes, 0);
  assert.equal(loadConfig({ fileObj: { maxMinutes: 30 }, env: {} }).config.maxMinutes, 30);
});

test("R4 maxCost: 0 disabled, else positive finite", () => {
  assert.equal(loadConfig({ fileObj: { maxCost: 0 }, env: {} }).config.maxCost, 0);
  assert.equal(loadConfig({ fileObj: { maxCost: 0.05 }, env: {} }).config.maxCost, 0.05);
  let r = loadConfig({ fileObj: { maxCost: -2 }, env: {} });
  assert.equal(r.config.maxCost, 0);
  assert.ok(r.warnings.some((w) => w.includes("maxCost")));
  r = loadConfig({ env: { AGENT_RUN_GUARD_MAX_COST: "nope" } });
  assert.equal(r.config.maxCost, 0);
});

test("R4 modes/flags validated with warnings", () => {
  let r = loadConfig({ fileObj: { mode: "block" }, env: {} });
  assert.equal(r.config.mode, "deny");
  assert.ok(r.warnings.some((w) => w.includes("mode")));

  r = loadConfig({ fileObj: { dangerousMode: "WARN" }, env: {} });
  assert.equal(r.config.dangerousMode, "warn"); // case-insensitive

  r = loadConfig({ env: { AGENT_RUN_GUARD_ABORT: "sometimes" } });
  assert.equal(r.config.abortMode, "cost-only");
  assert.ok(r.warnings.some((w) => w.includes("abortMode")));

  r = loadConfig({ fileObj: { nearNormalizeNumerics: true }, env: {} });
  assert.equal(r.config.nearNormalizeNumerics, true);
});

test("R4 valid config passes with no warnings", () => {
  const r = loadConfig({
    fileObj: { maxCalls: 50, mode: "warn" },
    env: { AGENT_RUN_GUARD_MAX_ERRORS: "2" },
  });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.config.maxCalls, 50);
  assert.equal(r.config.mode, "warn");
  assert.equal(r.config.maxConsecutiveErrors, 2);
});

test("R4 validateConfig used directly", () => {
  const { config, warnings } = validateConfig({ maxIdentical: 0, maxCost: -1, mode: "x" });
  assert.equal(config.maxIdentical, 3);
  assert.equal(config.maxCost, 0);
  assert.equal(config.mode, "deny");
  assert.equal(warnings.length, 3);
});
