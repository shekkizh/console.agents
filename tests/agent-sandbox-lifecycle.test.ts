import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import * as lifecycle from "../lib/agent-sandbox-lifecycle.ts";

const {
  AGENT_COMMAND_TIMEOUT_MS, AGENT_SANDBOX_LEASE_MS, AgentSandboxBusyError,
  SANDBOX_SESSION_TIMEOUT_MS, agentRunInputPath, isAgentSandboxBusyError,
} = lifecycle;

test("the runner deadline ends before its session and lease", () => {
  assert.ok(AGENT_COMMAND_TIMEOUT_MS < SANDBOX_SESSION_TIMEOUT_MS);
  assert.ok(SANDBOX_SESSION_TIMEOUT_MS < AGENT_SANDBOX_LEASE_MS);
});

test("each turn gets an isolated runtime input path", () => {
  const first = agentRunInputPath("12345678-1234-1234-1234-123456789abc");
  const second = agentRunInputPath("abcdefab-cdef-cdef-cdef-abcdefabcdef");
  assert.notEqual(first, second);
  assert.match(first, /^\/vercel\/sandbox\/runtime\/task-input-[a-f0-9-]{36}\.json$/);
  assert.throws(() => agentRunInputPath("../../workspace/input.json"), /invalid/i);
});

test("busy sandbox failures are distinguishable from agent failures", () => {
  const error = new AgentSandboxBusyError();
  assert.equal(isAgentSandboxBusyError(error), true);
  assert.equal(isAgentSandboxBusyError(new Error("model failed")), false);
});
