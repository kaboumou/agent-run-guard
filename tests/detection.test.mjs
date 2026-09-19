import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../core/engine.js";
import { matchDangerous, matchShellWriteSecrets, shellWriteForms } from "../core/patterns.js";
import { normalizeArgsForTool } from "../core/canonical.js";

// ---- R5: tool-aware numeric normalization ----

test("R5 default: pagination across line ranges does NOT collapse", async () => {
  const eng = createEngine({ maxIdentical: 100, maxNearDuplicate: 1, maxCalls: 100 });
  await eng.before({ tool: "read", args: { file: "a.txt", offset: 10, limit: 10 } });
  const d = await eng.before({ tool: "read", args: { file: "a.txt", offset: 20, limit: 10 } });
  assert.equal(d.action, "allow");
});

test("R5 opt-in: same read at shifted line numbers collapses", async () => {
  const eng = createEngine({
    maxIdentical: 100, maxNearDuplicate: 1, maxCalls: 100, nearNormalizeNumerics: true,
  });
  await eng.before({ tool: "read", args: { file: "a.txt", start_line: 10 } });
  const d = await eng.before({ tool: "read", args: { file: "a.txt", start_line: 20 } });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "near_repeat");
});

test("R5 opt-in: only read tools + numeric fields are masked", () => {
  const masked = normalizeArgsForTool("read", { file: "a", offset: 10, limit: "20" }, { nearNormalizeNumerics: true });
  assert.equal(masked.offset, "<N>");
  assert.equal(masked.limit, "<N>");
  assert.equal(masked.file, "a");
  // Non-read tools untouched even when opted in.
  const bash = normalizeArgsForTool("bash", { command: "echo 10" }, { nearNormalizeNumerics: true });
  assert.equal(bash.command, "echo 10");
  // Non-numeric fields untouched.
  const other = normalizeArgsForTool("read", { file: "a", offset: "ten" }, { nearNormalizeNumerics: true });
  assert.equal(other.offset, "ten");
});

// ---- R6: dangerous flag variants ----

const R6_CASES = [
  ["rm -r -f /", "rm-rf-root"],
  ["rm -fr /", "rm-rf-root"],
  ["rm --recursive --force /", "rm-rf-root"],
  ["rm -rf --no-preserve-root /", "rm-rf-root"],
  ["rm -r -f ~", "rm-rf-home"],
  ["rm --recursive --force $HOME", "rm-rf-home"],
  ["git push -f origin main", "git-push-force"],
  ["git push origin main", null],
  ["Remove-Item -Force -Recurse C:\\", "ps-remove-root"],
  ["rm -rf ./build", null],
  ["rm /tmp/x", null],
  ["rm --no-preserve-root /tmp/x", null],
];

for (const [cmd, want] of R6_CASES) {
  test(`R6: ${JSON.stringify(cmd)} -> ${want ?? "no hit"}`, () => {
    const hits = matchDangerous("bash", { command: cmd });
    if (want === null) assert.deepEqual(hits, []);
    else assert.ok(hits.includes(want), `expected ${want} in ${JSON.stringify(hits)}`);
  });
}

test("R6 dangerous default stays warn", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100 });
  assert.equal(eng.config.dangerousMode, "warn");
  const d = await eng.before({ tool: "bash", args: { command: "rm -r -f /" } });
  assert.equal(d.action, "warn");
  assert.deepEqual(d.patternIds, ["rm-rf-root"]);
});

// ---- R7: shell write forms ----

test("R7: echo secret > file is flagged (any tool)", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, secretMode: "deny" });
  const d = await eng.before({
    tool: "bash",
    args: { command: "echo sk-abc123XYZ456 > key.txt" },
  });
  assert.equal(d.action, "deny");
  assert.equal(d.event.event, "secret_write");
  assert.equal(d.event.via, "shell");
  assert.ok(d.event.forms.includes("redirect"));
  assert.ok(d.patternIds.includes("sk-secret"));
});

test("R7: clean redirect is not flagged", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100, secretMode: "deny" });
  const d = await eng.before({ tool: "bash", args: { command: "echo hello > out.txt" } });
  assert.equal(d.action, "allow");
});

test("R7: heredoc + tee forms with secrets flagged; stderr redirect ignored", () => {
  const heredoc = matchShellWriteSecrets("bash", {
    command: "cat > k <<'EOF'\nAKIAIOSFODNN7EXAMPLE\nEOF",
  });
  assert.ok(heredoc.patterns.includes("aws-key"));
  assert.ok(heredoc.forms.includes("heredoc") || heredoc.forms.includes("redirect"));

  const tee = matchShellWriteSecrets("bash", { command: "echo data | tee f.txt" });
  assert.deepEqual(tee.patterns, []); // no secret, no hit
  assert.ok(tee.forms.includes("tee"));

  const stderr = shellWriteForms("node x 2>&1");
  assert.deepEqual(stderr, []);
});

test("R7: PowerShell cmdlets with secrets flagged", () => {
  const hit = matchShellWriteSecrets("powershell", {
    command: "Set-Content -Path k.txt -Value 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'",
  });
  assert.ok(hit.patterns.includes("github-token"));
  assert.ok(hit.forms.includes("set-content"));
});

test("R7: default secretMode stays warn for shell forms", async () => {
  const eng = createEngine({ maxIdentical: 100, maxCalls: 100 });
  const d = await eng.before({
    tool: "bash",
    args: { command: "echo sk-abc123XYZ456 >> key.txt" },
  });
  assert.equal(d.action, "warn");
});
