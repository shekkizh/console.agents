import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import type { AgentProfile } from "../lib/types.ts";
import type { AgentSandbox } from "../lib/server/agent-sandbox.ts";
import {
  extractCommittedFxCompletion,
  finalizeDetachedFxTurn,
  ensureFxInstalled,
  hasLiveFxWorker,
  recoverDetachedFxCompletion,
  parseRunnerDelivery,
} from "../lib/server/fx-runtime.ts";

function fakeSandbox(input: {
  commands: Array<{ stdout: string; exitCode?: number; commandIncludes?: string }>;
  files?: Record<string, string>;
}): AgentSandbox {
  const commands = [...input.commands];
  return {
    id: "sandbox-1",
    root: "/workspace",
    async run(input) {
      const result = commands.shift();
      if (!result) throw new Error("Unexpected sandbox command");
      if (result.commandIncludes) assert.ok(input.command.includes(result.commandIncludes));
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

test("recovers committed history from HOME when the workspace is elsewhere", async () => {
  const messageId = "request-1";
  const eventPath = "/home/agent/.fx/sessions/session-1/events.jsonl";
  const sandbox = fakeSandbox({
    commands: [
      { stdout: "stopped" },
      { stdout: "/home/agent" },
      { stdout: `${eventPath}\n`, commandIncludes: "find '/home/agent/.fx/sessions'" },
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


test("rejects an unsafe sandbox HOME before searching history", async () => {
  const sandbox = fakeSandbox({
    commands: [{ stdout: "stopped" }, { stdout: "/home/../etc" }],
  });
  await assert.rejects(
    recoverDetachedFxCompletion({ sandbox, incomingMessageId: "request-1" }),
    /invalid home directory/,
  );
});

test("recovers the launcher's exact completion and selected artifacts after a callback loss", async () => {
  const key = createHash("sha256").update("request-1").digest("hex").slice(0, 24);
  const sandbox = fakeSandbox({
    commands: [{ stdout: "stopped" }],
    files: {
      [`.console/jobs/${key}/delivery.json`]: JSON.stringify({
        operation: "complete", arguments: {
          content: "Top-level result", session_id: "parent-session",
          artifacts: [{ path: ".console/outbox/report.md", content_base64: Buffer.from("Report").toString("base64") }],
        },
      }),
    },
  });
  const result = await recoverDetachedFxCompletion({ sandbox, incomingMessageId: "request-1" });
  assert.ok(result && typeof result === "object" && !("failed" in result));
  assert.equal(result.sessionId, "parent-session");
  assert.equal(result.artifacts?.[0]?.name, "report.md");
});

test("reports a stopped managed worker instead of treating it as running", async () => {
  const key = createHash("sha256").update("request-1").digest("hex").slice(0, 24);
  const sandbox = fakeSandbox({ commands: [{ stdout: "stopped" }], files: { [`.console/jobs/${key}/runner.py`]: "runner" } });
  const result = await recoverDetachedFxCompletion({ sandbox, incomingMessageId: "request-1" });
  assert.ok(result && typeof result === "object" && "failed" in result);
  assert.equal(result.failed, true);
});

test("refuses invalid runner payloads and unknown process state", async () => {
  assert.throws(() => parseRunnerDelivery(JSON.stringify({ operation: "complete", arguments: { content: "Missing session" } })), /session id/);
  const sandbox = fakeSandbox({ commands: [{ stdout: "", exitCode: 1 }] });
  await assert.rejects(recoverDetachedFxCompletion({ sandbox, incomingMessageId: "request-1" }), /worker state/);
});


test("keeps the current pinned FX binary without downloading", async () => {
  const { config } = await import("../lib/server/config.ts");
  const sandbox = fakeSandbox({ commands: [
    { stdout: config.fxVersion.slice(1), commandIncludes: "--version" },
    { stdout: "", commandIncludes: "install -m 0755" },
  ] });
  await ensureFxInstalled(sandbox);
});

test("upgrades a stale binary using a checksum-verified server download", async (t) => {
  const archive = Buffer.from("official release fixture");
  const checksum = createHash("sha256").update(archive).digest("hex");
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(url);
    return new Response(url.endsWith(".sha256") ? checksum + "  fx-linux-aarch64.tar.gz" : archive);
  });
  const sandbox = fakeSandbox({ commands: [
    { stdout: "0.0.1", commandIncludes: "--version" },
    { stdout: "aarch64", commandIncludes: "uname -m" },
    { stdout: "", commandIncludes: "/.console/bin/fx.new" },
    { stdout: "", commandIncludes: "install -m 0755" },
  ] });
  await ensureFxInstalled(sandbox);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.startsWith("https://github.com/vercel-labs/fx/releases/download/")));
});

test("rejects a release checksum mismatch before installing", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    new Response(url.endsWith(".sha256") ? "0".repeat(64) : "tampered archive"));
  await assert.rejects(ensureFxInstalled(fakeSandbox({ commands: [
    { stdout: "0.0.1" }, { stdout: "aarch64" },
  ] })), /checksum mismatch/);
});

test("worker detection fails closed when process inspection is unavailable", async () => {
  await assert.rejects(hasLiveFxWorker(fakeSandbox({ commands: [{ stdout: "", exitCode: 1 }] })), /verify FX worker state/);
  assert.equal(await hasLiveFxWorker(fakeSandbox({ commands: [{ stdout: "running" }] })), true);
});


const controlAgent: AgentProfile = {
  id: "agent-control", name: "Control", specialty: "Test control requests", instructions: "Validate control requests.",
  fxConfig: { model: "test/model", networkAccess: "full", networkAllowlist: [], skills: [], mcpServers: {} },
  configVersion: 1, createdByAgentId: null, enabled: true,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

for (const raw of ["not json", '{"requests":[{"type":"unknown"}]}', "x".repeat(64_001)]) {
  test(`quarantines malformed control data (${raw.length} bytes) before settling`, async () => {
    const sandbox = fakeSandbox({ commands: [], files: { ".console/control-plane.json": raw } });
    const written = new Map<string, string>();
    const removed: string[] = [];
    sandbox.writeTextFile = async (path, content) => { written.set(path, content); };
    sandbox.removePath = async (path) => { removed.push(path); };
    const result = await finalizeDetachedFxTurn({ ownerId: "owner", agent: controlAgent, sandbox });
    assert.equal(result[0]?.status, "rejected");
    const [diagnosticPath, diagnostic] = [...written.entries()][0];
    assert.match(diagnosticPath, /^\.console\/diagnostics\/control-plane-/);
    assert.equal(JSON.parse(diagnostic).raw, raw);
    assert.ok(removed.includes(".console/control-plane.json"));
    assert.ok(removed.includes(".console/outbox"));
  });
}

test("does not settle when control-file reads or cleanup fail transiently", async () => {
  const sandbox = fakeSandbox({ commands: [] });
  sandbox.readTextFile = async () => { throw new Error("temporary storage failure"); };
  let removed = false;
  sandbox.removePath = async () => { removed = true; };
  await assert.rejects(finalizeDetachedFxTurn({ ownerId: "owner", agent: controlAgent, sandbox }), /temporary storage failure/);
  assert.equal(removed, false);
  sandbox.readTextFile = async () => null;
  sandbox.removePath = async () => { throw new Error("cleanup unavailable"); };
  await assert.rejects(finalizeDetachedFxTurn({ ownerId: "owner", agent: controlAgent, sandbox }), /cleanup unavailable/);
});
