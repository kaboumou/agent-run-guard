import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeHook } from "../adapters/harness-map.js";
import { createEngine } from "../core/engine.js";
import { HASH_KEY_RE } from "../core/canonical.js";

const GUARD = fileURLToPath(new URL("../bin/guard.js", import.meta.url));
const SECRET = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";

function runCLI({ payload, extraEnv = {}, stateDir, harness = "claude-code" }) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "arg-cli-"));
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync(process.execPath, [GUARD, "--harness", harness, "--state-dir", dir], {
    input: payload,
    encoding: "utf8",
    env,
  });
  return { result: r, dir };
}

/** Every file under dir (recursive) as absolute paths. */
function allFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

test("P1 auditor probe: secret in Write content appears in NO state/log file", () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-secret-"));
  const logFile = join(dir, "audit.jsonl");
  const stateDir = join(dir, "state");
  const payload = JSON.stringify({
    session_id: "aud-secret",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file: "k.txt", content: `api key ${SECRET} inside` },
    cwd: "C:\\tmp",
  });
  const { result } = runCLI({
    payload,
    stateDir,
    extraEnv: { AGENT_RUN_GUARD_SECRET_MODE: "deny", AGENT_RUN_GUARD_LOG: logFile },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  // Log: exactly one line, clean.
  const lines = readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(SECRET), "log must not contain the secret");
  // State + every file under dir: no literal secret anywhere.
  for (const f of allFiles(dir)) {
    const text = readFileSync(f, "utf8");
    assert.ok(!text.includes(SECRET), `secret leaked in ${f}`);
  }
  // Counter keys are hash-shaped.
  const stateFiles = allFiles(stateDir).filter((f) => f.endsWith(".json"));
  assert.ok(stateFiles.length >= 1);
  for (const f of stateFiles) {
    const snap = JSON.parse(readFileSync(f, "utf8"));
    for (const k of [...Object.keys(snap.identicalCounts), ...Object.keys(snap.nearCounts)]) {
      assert.match(k, HASH_KEY_RE, `non-hash counter key in ${f}`);
    }
  }
});

test("P2: exactly one JSONL line per blocked call", () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-oneline-"));
  const logFile = join(dir, "audit.jsonl");
  const payload = JSON.stringify({
    session_id: "aud-oneline",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
    cwd: "C:\\tmp",
  });
  const { result } = runCLI({
    payload,
    stateDir: join(dir, "state"),
    extraEnv: { AGENT_RUN_GUARD_DANGEROUS_MODE: "deny", AGENT_RUN_GUARD_LOG: logFile },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /rm-rf-root/);
  assert.equal(readFileSync(logFile, "utf8").trim().split("\n").length, 1);
});

test("P3: empty / unparseable / non-hook stdin → exit 0, no files, no budget", () => {
  for (const input of ["", "   \n", "not-json", "{}", "[]", '{"hello":1}']) {
    const dir = mkdtempSync(join(tmpdir(), "arg-empty-"));
    const stateDir = join(dir, "state-will-not-exist");
    const { result } = runCLI({ payload: input, stateDir });
    assert.equal(result.status, 0, `exit for ${JSON.stringify(input)}`);
    assert.equal(result.stdout, "", `stdout for ${JSON.stringify(input)}`);
    assert.deepEqual(allFiles(stateDir), [], `no state for ${JSON.stringify(input)}`);
  }
});

test("cross-process identical repeat still fires with hash-keyed state", () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-xproc-"));
  const stateDir = join(dir, "state");
  const payload = JSON.stringify({
    session_id: "aud-xproc",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hash-state" },
    cwd: "C:\\tmp",
  });
  const env = { AGENT_RUN_GUARD_MAX_IDENTICAL: "1" };
  const first = runCLI({ payload, stateDir, extraEnv: env });
  assert.equal(first.result.status, 0);
  assert.equal(first.result.stdout, "");
  const second = runCLI({ payload, stateDir, extraEnv: env });
  assert.equal(second.result.status, 0);
  assert.match(second.result.stdout, /already run 1 times/);
  const snap = JSON.parse(
    readFileSync(allFiles(stateDir).find((f) => f.endsWith(".json")), "utf8")
  );
  assert.ok(Object.keys(snap.identicalCounts).every((k) => HASH_KEY_RE.test(k)));
});

test("P2 latch dedupe: double delivery logs one latch; recovery re-latches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-latch-"));
  const logFile = join(dir, "audit.jsonl");
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, maxConsecutiveErrors: 2, logFile });
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" }); // stormActive: no new latch line
  let lines = readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.filter((l) => l.includes('"event":"error_storm"')).length, 1);
  await eng.after({ ok: true, tool: "bash" }); // recovery resets dedupe
  await eng.after({ ok: false, tool: "bash" });
  await eng.after({ ok: false, tool: "bash" });
  lines = readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.filter((l) => l.includes('"event":"error_storm"')).length, 2);
});

test("legacy v1 raw-arg state keys are discarded on load", async () => {
  const eng = createEngine({
    maxIdentical: 1,
    maxCalls: 100,
    snapshot: {
      totalCalls: 5,
      identicalCounts: { 'Bash|{"command":"echo legacy"}': 5 },
      nearCounts: {},
    },
  });
  // Legacy count ignored: same call starts at 1 → allowed (limit 1).
  const d = await eng.before({ tool: "Bash", args: { command: "echo legacy" } });
  assert.equal(d.action, "allow");
  const snap = eng.toSnapshot();
  assert.equal(snap.totalCalls, 6); // scalar counters still honored
  assert.ok(Object.keys(snap.identicalCounts).every((k) => HASH_KEY_RE.test(k)));
});

test("looksLikeHook gates non-payload JSON", () => {
  assert.equal(looksLikeHook({}), false);
  assert.equal(looksLikeHook([]), false);
  assert.equal(looksLikeHook(null), false);
  assert.equal(looksLikeHook("x"), false);
  assert.equal(looksLikeHook({ hello: 1 }), false);
  assert.equal(looksLikeHook({ tool_name: "Bash", tool_input: {} }), true);
  assert.equal(looksLikeHook({ hook_event_name: "PreToolUse" }), true);
});

void dirname;
