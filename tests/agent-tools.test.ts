import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import { agentPlatformTools, toFunctionResultStep } from "../lib/server/agent-tools.ts";

test("every agent receives first-class roster and peer-task tools", () => {
  const names = agentPlatformTools.map((tool) => tool.name);
  assert.deepEqual(names, ["list_console_agents", "create_console_agent", "send_agent_task"]);

  const createTool = agentPlatformTools.find((tool) => tool.name === "create_console_agent");
  assert.ok(createTool);
  assert.deepEqual(createTool.parameters.required, ["name", "specialty", "instructions"]);
  assert.match(createTool.description, /only way to fulfill/i);

  const sendTool = agentPlatformTools.find((tool) => tool.name === "send_agent_task");
  assert.ok(sendTool);
  assert.deepEqual(sendTool.parameters.required, ["agent_id", "title", "message"]);
});

test("function results use the current Interactions content wrapper", () => {
  assert.deepEqual(toFunctionResultStep({ callId: "call-1", name: "list_console_agents", result: { ok: true } }), {
    type: "function_result",
    name: "list_console_agents",
    call_id: "call-1",
    result: { content: [{ type: "text", text: '{"ok":true}' }] },
  });
});
