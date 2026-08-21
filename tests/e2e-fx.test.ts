import assert from "node:assert/strict";
import test from "node:test";
import { parseE2EFakeRequest, runE2EFakeFxTurn } from "../lib/server/e2e-fx.ts";
import type { AgentProfile } from "../lib/types.ts";

const agent = {
  id: "agent-test",
  name: "Test",
  specialty: "Tests",
  instructions: "Run deterministic tests.",
  fxConfig: { model: "test/model", maxSteps: 1, networkAccess: "full", networkAllowlist: [], skills: [], mcpServers: {} },
  configVersion: 1,
  eveSessionId: null,
  createdByAgentId: null,
  enabled: true,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
} satisfies AgentProfile;

test("parses only bounded deterministic E2E requests", () => {
  assert.deepEqual(parseE2EFakeRequest("E2E_FAKE delay=25 reply=ALPHA"), {
    delayMs: 25,
    reply: "ALPHA",
  });
  assert.throws(() => parseE2EFakeRequest("do real work"), /Invalid E2E/);
  assert.throws(() => parseE2EFakeRequest("E2E_FAKE delay=1 reply=has spaces"), /Invalid E2E/);
});

test("returns a deterministic fx-shaped outcome", async () => {
  const result = await runE2EFakeFxTurn({ agent, prompt: "E2E_FAKE delay=0 reply=DONE" });
  assert.equal(result.output, "DONE");
  assert.equal(result.model, "e2e/fake-fx");
  assert.equal(result.sessionId, "e2e-agent-test");
});

test("aborts a delayed fake activation", async () => {
  const controller = new AbortController();
  const running = runE2EFakeFxTurn({
    agent,
    prompt: "E2E_FAKE delay=5000 reply=NEVER",
    abortSignal: controller.signal,
  });
  controller.abort(new Error("cancelled"));
  await assert.rejects(running, /cancelled/);
});

test("does not start an activation after cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await assert.rejects(
    runE2EFakeFxTurn({
      agent,
      prompt: "E2E_FAKE delay=1 reply=NEVER",
      abortSignal: controller.signal,
    }),
    /already cancelled/,
  );
});
