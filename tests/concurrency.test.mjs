import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("../bin/guard.js", import.meta.url));

function runOne(payload, { stateDir, extraEnv = {}, harness = "generic" }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn(process.execPath, [GUARD, "--harness", harness, "--state-dir", stateDir], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}

function stateJson(stateDir) {
  const files = readdirSync(stateDir).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected one state file, got ${JSON.stringify(files)}`);
  return JSON.parse(readFileSync(join(stateDir, files[0]), "utf8"));
}

const BIG = {
  AGENT_RUN_GUARD_MAX_CALLS: "100000",
  AGENT_RUN_GUARD_MAX_IDENTICAL: "100000",
  AGENT_RUN_GUARD_MAX_NEAR: "100000",
  AGENT_RUN_GUARD_MAX_ERRORS: "100000",
};

test("R2: 24 parallel hook processes lose no updates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-conc-"));
  const stateDir = join(dir, "state");
  const N = 24;
  const jobs = [];
  for (let i = 0; i < N; i++) {
    const payload = JSON.stringify({
      session_id: "conc-24",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: `echo conc-${i}` },
      cwd: "C:\\tmp",
    });
    jobs.push(runOne(payload, { stateDir, extraEnv: BIG }));
  }
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.code, 0);
  const snap = stateJson(stateDir);
  assert.equal(snap.totalCalls, N);
  assert.equal(Object.keys(snap.identicalCounts).length, N);
  for (const n of Object.values(snap.identicalCounts)) assert.equal(n, 1);
});

test("R2: 16 parallel identical calls count every one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-concsame-"));
  const stateDir = join(dir, "state");
  const N = 16;
  const payload = JSON.stringify({
    session_id: "conc-same",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo same" },
    cwd: "C:\\tmp",
  });
  const results = await Promise.all(
    Array.from({ length: N }, () => runOne(payload, { stateDir, extraEnv: BIG }))
  );
  for (const r of results) assert.equal(r.code, 0);
  const snap = stateJson(stateDir);
  assert.equal(snap.totalCalls, N);
  const counts = Object.values(snap.identicalCounts);
  assert.equal(counts.length, 1);
  assert.equal(counts[0], N);
});

test("R2: stale lock (crashed writer) does not deadlock — takeover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-stale-"));
  const stateDir = join(dir, "state");
  // Prime one state file so we know its name, then plant a stale lock on it.
  const prime = JSON.stringify({
    session_id: "conc-stale",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo prime" },
    cwd: "C:\\tmp",
  });
  await runOne(prime, { stateDir, extraEnv: BIG });
  const lockFile = join(stateDir, readdirSync(stateDir).find((f) => f.endsWith(".json")) + ".lock");
  writeFileSync(lockFile, JSON.stringify({ pid: 999999, ts: Date.now() - 120000, token: "dead" }), "utf8");
  const backdate = new Date(Date.now() - 120000);
  utimesSync(lockFile, backdate, backdate);
  const payload = JSON.stringify({
    session_id: "conc-stale",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo after-crash" },
    cwd: "C:\\tmp",
  });
  const r = await runOne(payload, { stateDir, extraEnv: BIG });
  assert.equal(r.code, 0);
  const snap = stateJson(stateDir);
  assert.equal(snap.totalCalls, 2);
});

test("R2: lock timeout falls open (applies once, exits 0)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-lockto-"));
  const stateDir = join(dir, "state");
  const prime = JSON.stringify({
    session_id: "conc-lockto",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo prime" },
    cwd: "C:\\tmp",
  });
  await runOne(prime, { stateDir, extraEnv: BIG });
  const lockFile = join(stateDir, readdirSync(stateDir).find((f) => f.endsWith(".json")) + ".lock");
  writeFileSync(lockFile, JSON.stringify({ pid: 999999, ts: Date.now(), token: "fresh-holder" }), "utf8");
  // Fresh lock + tiny timeout: waiter cannot acquire, must still exit 0.
  const payload = JSON.stringify({
    session_id: "conc-lockto",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo fallback" },
    cwd: "C:\\tmp",
  });
  const r = await runOne(payload, {
    stateDir,
    extraEnv: { ...BIG, AGENT_RUN_GUARD_LOCK_TIMEOUT_MS: "300" },
  });
  assert.equal(r.code, 0);
});
