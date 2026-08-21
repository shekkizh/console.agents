import assert from "node:assert/strict";
import test from "node:test";
import {
  fxAgentInstructions,
  fxMcpProfileConfig,
  fxProjectConfig,
  fxSkillFile,
  fxReleaseBase,
  parseFxAskResult,
  validateFxVersion,
} from "../lib/fx-config.ts";
import type { AgentProfile } from "../lib/types.ts";

const agent: AgentProfile = {
  id: "agent-1",
  name: "Builder",
  specialty: "Builds software",
  instructions: "Work carefully and verify the result.",
  fxConfig: {
    model: "zai/glm-5.2",
    maxSteps: 32,
    permissionMode: "yolo",
    skills: [],
    mcpServers: {},
  },
  configVersion: 3,
  eveSessionId: null,
  createdByAgentId: null,
  enabled: true,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

test("serializes agent workspace configuration", () => {
  assert.deepEqual(JSON.parse(fxProjectConfig(agent)), {
    model: "zai/glm-5.2",
    max_agent_steps: 32,
    sandbox: "none",
  });
});

test("serializes skills and MCP configuration for fx", () => {
  const configured: AgentProfile = {
    ...agent,
    fxConfig: {
      ...agent.fxConfig,
      skills: [{ name: "review", description: "Review changes", instructions: "Inspect the work carefully." }],
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp", bearerTokenEnv: "DOCS_TOKEN" },
      },
    },
  };
  assert.match(fxSkillFile(configured.fxConfig.skills[0]!), /name: review/);
  assert.deepEqual(JSON.parse(fxMcpProfileConfig(configured)), {
    mcp: {
      docs: { type: "http", url: "https://example.com/mcp", bearer_token_env: "DOCS_TOKEN" },
    },
  });
});

test("renders the sandbox boundary into fx instructions", () => {
  const instructions = fxAgentInstructions(agent);
  assert.match(instructions, /full control of this sandbox/);
  assert.match(instructions, /never claim access outside it/i);
  assert.match(instructions, /Prefer flexible model judgment and reusable skills/);
  assert.match(instructions, /console-platform/);
  assert.doesNotMatch(instructions, /sk_[A-Za-z0-9]/);
});

test("parses fx ask JSON output", () => {
  assert.deepEqual(
    parseFxAskResult(
      JSON.stringify({
        output: "Done",
        exit_code: 0,
        model: "zai/glm-5.2",
        session_id: "session.1",
        steps: 4,
        tool_calls: [{ name: "terminal" }],
      }),
    ),
    {
      output: "Done",
      exitCode: 0,
      model: "zai/glm-5.2",
      sessionId: "session.1",
      steps: 4,
      toolCalls: [{ name: "terminal" }],
    },
  );
});

test("rejects unpinned fx versions", () => {
  assert.equal(validateFxVersion("v0.0.4"), "v0.0.4");
  assert.throws(() => validateFxVersion("latest"), /stable tag/);
  assert.throws(() => validateFxVersion("v0.0.4; curl bad"), /stable tag/);
});

test("resolves pinned versions to the official release", () => {
  assert.equal(
    fxReleaseBase("v0.0.4"),
    "https://github.com/vercel-labs/fx/releases/download/v0.0.4",
  );
});
