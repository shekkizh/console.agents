import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSandbox } from "../lib/server/agent-sandbox.ts";
import {
  extractCommittedFxCompletion,
  recoverDetachedFxCompletion,
} from "../lib/server/fx-runtime.ts";

function fakeSandbox(input: {
  commands: Array<{ stdout: string; exitCode?: number }>;
  files?: Record<string, string>;
}): AgentSandbox {
  const commands = [...input.commands];
  return {
    id: "sandbox-1",
    root: "/workspace",
    async run() {
      const result = commands.shift();
      if (!result) throw new Error("Unexpected sandbox command");
      return { exitCode: result.exitCode ?? 0, stdout: result.stdout, stderr: "" };
    },
    async readTextFile(path) {
      return input.files?.[path] ?? null;
    },
    async spawn() {
      throw new Error("Unexpected sandbox spawn");
    },
    async writeTextFile() {},
    async writeBinaryFile() {},
    async removePath() {},
    async setNetworkPolicy() {},
    async stop() {},
  };
}

test("extracts the committed assistant response for the correlated request", () => {
  const messageId = "44cb6574-220d-4241-bafa-e32f61e349d8";
  const events = [
    "not-json",
    JSON.stringify({
      kind: "history_turn_committed",
      payload: {
        turn: {
          user: { text: "[message]\nmessageId: another-request" },
          assistant: "Wrong response",
        },
      },
    }),
    JSON.stringify({
      kind: "history_turn_committed",
      payload: {
        turn: {
          user: { text: `[message]\nmessageId: ${messageId}` },
          assistant: "  Recovered final response.  ",
        },
      },
    }),
  ].join("\n");

  assert.equal(
    extractCommittedFxCompletion(events, messageId),
    "Recovered final response.",
  );
});

test("does not recover an uncommitted or unrelated response", () => {
  assert.equal(
    extractCommittedFxCompletion(
      JSON.stringify({
        kind: "recovery_checkpoint_set",
        payload: {
          turn: {
            user: { text: "messageId: request-1" },
            assistant: "Draft response",
          },
        },
      }),
      "request-1",
    ),
    undefined,
  );
});

test("recovers the committed response after the detached worker stops", async () => {
  const messageId = "request-1";
  const eventPath = "/workspace/.fx/sessions/session-1/events.jsonl";
  const sandbox = fakeSandbox({
    commands: [
      { stdout: "stopped" },
      { stdout: `${eventPath}\n` },
    ],
    files: {
      [eventPath]: JSON.stringify({
        kind: "history_turn_committed",
        payload: {
          turn: {
            user: { text: `messageId: ${messageId}` },
            assistant: "Recovered response",
          },
        },
      }),
    },
  });

  assert.deepEqual(
    await recoverDetachedFxCompletion({ sandbox, incomingMessageId: messageId }),
    { content: "Recovered response", sessionId: "session-1" },
  );
});

test("does not inspect history while the detached worker is alive", async () => {
  const sandbox = fakeSandbox({ commands: [{ stdout: "running" }] });
  assert.equal(
    await recoverDetachedFxCompletion({ sandbox, incomingMessageId: "request-1" }),
    "running",
  );
});
