import { test } from "node:test";
import assert from "node:assert/strict";
import v2default, {
  PLUGIN_ID,
  setupGuard,
  memoryText,
  extractEventCost,
} from "../adapters/opencode-v2/plugin.js";
import dualDefault, { createOpenCodeHooks } from "../adapters/opencode/index.js";

function fakeCtx() {
  const hooks = {};
  const added = [];
  const calls = { synthetic: [], prompt: [], interrupt: [] };
  const ctx = {
    options: {},
    tool: {
      hook: async (name, cb) => {
        hooks[name] = cb;
        return { dispose: async () => {} };
      },
      transform: async (cb) => {
        cb({ add: (t) => added.push(t) });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, cb) => {
        hooks["session:" + name] = cb;
        return { dispose: async () => {} };
      },
      synthetic: async (a) => {
        calls.synthetic.push(a);
        return {};
      },
      prompt: async (a) => {
        calls.prompt.push(a);
        return {};
      },
      interrupt: async (a) => {
        calls.interrupt.push(a);
        return {};
      },
    },
    event: {
      subscribe: async function* () {
        // empty stream ends immediately
      },
    },
  };
  return { ctx, hooks, added, calls };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

const V2EVENT = (tool, input, id = "call-1") => ({
  tool,
  sessionID: "sess-v2",
  agent: "build",
  messageID: "msg-1",
  id,
  input,
});

test("R1 V2: allow passes; identical repeat throws with reason", async () => {
  await withEnv({ AGENT_RUN_GUARD_MAX_IDENTICAL: "1" }, async () => {
    const { ctx, hooks } = fakeCtx();
    await setupGuard(ctx);
    await hooks["execute.before"](V2EVENT("bash", { command: "echo v2" }));
    await assert.rejects(
      hooks["execute.before"](V2EVENT("bash", { command: "echo v2" }, "call-2")),
      /already run 1 times/
    );
  });
});

test("R1 V2: near-repeat + call budget enforced", async () => {
  await withEnv(
    { AGENT_RUN_GUARD_MAX_NEAR: "1", AGENT_RUN_GUARD_MAX_CALLS: "3" },
    async () => {
      const { ctx, hooks } = fakeCtx();
      await setupGuard(ctx);
      await hooks["execute.before"](V2EVENT("bash", { command: "echo hello" }, "c1"));
      await assert.rejects(
        hooks["execute.before"](V2EVENT("bash", { command: "echo  hello" }, "c2")),
        /nearly identical/
      );
      await hooks["execute.before"](V2EVENT("bash", { command: "echo other" }, "c3"));
      await assert.rejects(
        hooks["execute.before"](V2EVENT("bash", { command: "echo fourth" }, "c4")),
        /budget exceeded/
      );
    }
  );
});

test("R1 V2: after() honors deterministic status + id dedupe", async () => {
  await withEnv({ AGENT_RUN_GUARD_MAX_ERRORS: "5" }, async () => {
    const { ctx, hooks, calls } = fakeCtx();
    const { engine } = await setupGuard(ctx);
    const fail = { tool: "bash", sessionID: "s", agent: "b", messageID: "m", id: "dup-1", input: {}, status: "error", error: { message: "x" } };
    await hooks["execute.after"](fail);
    await hooks["execute.after"](fail); // duplicate delivery
    assert.equal(engine.status().consecutiveErrors, 1);
    await hooks["execute.after"]({ ...fail, id: "dup-2" });
    assert.equal(engine.status().consecutiveErrors, 2);
    void calls;
  });
});

test("R1 V2: block injects via synthetic first; interrupt shape has no continue field", async () => {
  await withEnv(
    {
      AGENT_RUN_GUARD_MAX_CALLS: "1",
      AGENT_RUN_GUARD_ABORT: "always",
    },
    async () => {
      const { ctx, hooks, calls } = fakeCtx();
      await setupGuard(ctx);
      await hooks["execute.before"](V2EVENT("bash", { command: "echo one" }, "k1"));
      await assert.rejects(hooks["execute.before"](V2EVENT("bash", { command: "echo two" }, "k2")), /budget/);
      assert.equal(calls.synthetic.length, 1);
      assert.equal(calls.prompt.length, 0); // synthetic won, no prompt fallback
      assert.equal(calls.interrupt.length, 1);
      assert.deepEqual(Object.keys(calls.interrupt[0]).sort(), ["sessionID"]);
    }
  );
});

test("R1 V2: compaction appends memory to system, never sets result", async () => {
  const { ctx, hooks } = fakeCtx();
  const { engine } = await setupGuard(ctx);
  await engine.before({ tool: "bash", args: { command: "echo hi" } });
  const event = { system: [], messages: [] };
  await hooks["session:compaction"](event);
  assert.equal(event.system.length, 1);
  assert.match(event.system[0].text, /Agent Run Guard memory/);
  assert.equal(event.result, undefined);
});

test("R1 V2: guard_status tool registered with JSON schema; execute works", async () => {
  const { ctx, added } = fakeCtx();
  const { engine } = await setupGuard(ctx);
  await engine.before({ tool: "bash", args: { command: "echo hi" } });
  const tool = added.find((t) => t.name === "guard_status");
  assert.ok(tool);
  assert.equal(tool.input.type, "object");
  const out = await tool.execute({});
  assert.equal(JSON.parse(out.content).totalCalls, 1);
});

test("R1 V2: memoryText + extractEventCost units", () => {
  const st = { totalCalls: 3, limits: { maxCalls: 10, maxConsecutiveErrors: 5 }, blockedCount: 1, warnedCount: 0, consecutiveErrors: 2, knownFailures: ["bash failed 2x in a row"] };
  assert.match(memoryText(st), /tool calls used: 3\/10/);
  assert.equal(extractEventCost({ cost: 0.04 }), 0.04);
  assert.equal(extractEventCost({ usage: { cost: 0.1 } }), 0.1);
  assert.equal(extractEventCost({ hello: 1 }), null);
});

test("R1 dual entry: V2 definition + V1 server() in one default export", async () => {
  assert.equal(PLUGIN_ID, "agent-run-guard");
  assert.equal(typeof v2default.id, "string");
  assert.equal(typeof v2default.setup, "function");
  assert.equal(typeof dualDefault.setup, "function");
  assert.equal(typeof dualDefault.server, "function");
  assert.equal(dualDefault.id, "agent-run-guard");
  // server() yields the live-proven V1 hooks object shape.
  const hooks = await dualDefault.server({});
  assert.equal(typeof hooks["tool.execute.before"], "function");
  assert.equal(typeof hooks["tool.execute.after"], "function");
  assert.ok(hooks.tool.guard_status);
  void createOpenCodeHooks;
});

test("R1 V2 setup returns a working cleanup", async () => {
  const { ctx } = fakeCtx();
  const { cleanup } = await setupGuard(ctx);
  assert.equal(typeof cleanup, "function");
  cleanup(); // must not throw
});
