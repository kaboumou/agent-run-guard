import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromEnv, fromObject, resolveConfig, DEFAULTS } from "../core/config.js";
import { fingerprint } from "../core/canonical.js";
import { sessionFileName, isExpired, STATE_TTL_MS, loadSnapshot, saveSnapshotAtomic } from "../core/state.js";
import { extractCostUsd } from "../adapters/opencode/plugin.js";
import { createEngine } from "../core/engine.js";

test("config: v0.1 env names still work", () => {
  const cfg = resolveConfig({
    env: {
      AGENT_RUN_GUARD_MAX_IDENTICAL: "1",
      AGENT_RUN_GUARD_MAX_CALLS: "50",
      AGENT_RUN_GUARD_MODE: "warn",
      AGENT_RUN_GUARD_LOG: "/tmp/x.jsonl",
    },
  });
  assert.equal(cfg.maxIdentical, 1);
  assert.equal(cfg.maxCalls, 50);
  assert.equal(cfg.mode, "warn");
  assert.equal(cfg.logFile, "/tmp/x.jsonl");
});

test("config: new env names + file + defaults", () => {
  const cfg = resolveConfig({
    fileObj: fromObject({ maxNearDuplicate: 7, dangerousMode: "deny" }),
    env: { AGENT_RUN_GUARD_MAX_NEAR: "2" },
  });
  assert.equal(cfg.maxNearDuplicate, 2); // env wins over file
  assert.equal(cfg.dangerousMode, "deny");
  assert.equal(cfg.maxMinutes, DEFAULTS.maxMinutes);
  assert.equal(fromEnv({}).maxIdentical, undefined); // no overrides from empty env
});

test("fingerprint never contains raw values", () => {
  const fp = fingerprint("write", { content: "ghp_supersecret123" });
  assert.ok(!JSON.stringify(fp).includes("ghp_supersecret123"));
  assert.equal(typeof fp.hash, "string");
  assert.ok(fp.len > 0);
});

test("state round-trips across engine instances (cross-process shape)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-state-"));
  const file = join(dir, sessionFileName({ harness: "claude-code", sessionId: "abc" }));
  const e1 = createEngine({ maxIdentical: 1, maxCalls: 100 });
  await e1.before({ tool: "bash", args: { command: "echo hi" } });
  await saveSnapshotAtomic(file, e1.toSnapshot());
  assert.ok(existsSync(file));
  const snap = await loadSnapshot(file);
  const e2 = createEngine({ maxIdentical: 1, maxCalls: 100, snapshot: snap });
  const d = await e2.before({ tool: "bash", args: { command: "echo hi" } });
  assert.equal(d.action, "deny"); // second process sees the first call
});

test("sessionFileName is sha256(harness + session), deterministic, unreadable", () => {
  const a = sessionFileName({ harness: "claude-code", sessionId: "s1" });
  assert.match(a, /^[0-9a-f]{64}\.json$/);
  assert.equal(a, sessionFileName({ harness: "claude-code", sessionId: "s1" }));
  assert.notEqual(a, sessionFileName({ harness: "codex", sessionId: "s1" }));
  assert.ok(!a.includes("s1"));
  const cwdFallback = sessionFileName({ harness: "generic", cwd: "/x/y" });
  assert.match(cwdFallback, /^[0-9a-f]{64}\.json$/);
  assert.equal(cwdFallback, sessionFileName({ harness: "generic", cwd: "/x/y" }));
});

test("isExpired resets idle sessions after TTL", () => {
  assert.equal(isExpired({ lastSeen: Date.now() - STATE_TTL_MS - 1000 }), true);
  assert.equal(isExpired({ lastSeen: Date.now() }), false);
  assert.equal(isExpired({}), true);
});

test("extractCostUsd finds numeric cost fields, ignores missing", () => {
  assert.equal(extractCostUsd({ cost: 0.02 }), 0.02);
  assert.equal(extractCostUsd({ usage: { cost: 0.5 } }), 0.5);
  assert.equal(extractCostUsd({ hello: 1 }), null);
  assert.equal(extractCostUsd(null), null);
});

test("engine log lines carry fp hash+len, never raw args", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-log-"));
  const logFile = join(dir, "g.jsonl");
  const eng = createEngine({ maxIdentical: 1, maxCalls: 100, logFile });
  await eng.before({ tool: "bash", args: { command: "echo SECRETVALUE123" } });
  await eng.before({ tool: "bash", args: { command: "echo SECRETVALUE123" } }).catch(() => {});
  const text = readFileSync(logFile, "utf8");
  assert.ok(!text.includes("SECRETVALUE123"));
  const evt = JSON.parse(text.trim().split("\n")[0]);
  assert.ok(evt.fp && typeof evt.argLen === "number");
});
