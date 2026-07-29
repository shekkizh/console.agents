import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import { buildManagedEnvironment } from "../lib/server/agent-environment-config.ts";

const agent = {
  id: "general",
  name: "General",
  specialty: "General-purpose operator",
  instructions: "Complete the user's request.",
};

test("a new managed environment mounts editable instructions, the platform skill, and scoped credentials", () => {
  const environment = buildManagedEnvironment(
    agent,
    "signed-token",
    "https://console.shekkizh.com",
    undefined,
    "https://github.com/example/repository",
  );

  assert.equal(environment.type, "remote");
  assert.deepEqual(environment.sources?.map((source) => source.target), [
    ".agents/skills/console-platform/SKILL.md",
    ".agents/AGENTS.md",
    "/workspace/repository",
  ]);
  assert.deepEqual(environment.network.allowlist[0], {
    domain: "console.shekkizh.com",
    transform: { Authorization: "Bearer signed-token" },
  });
});

test("a reused environment refreshes credentials without remounting or overwriting durable agent files", () => {
  const environment = buildManagedEnvironment(agent, "fresh-token", "https://console.shekkizh.com", "env_123");

  assert.equal(environment.environment_id, "env_123");
  assert.equal(environment.sources, undefined);
  assert.equal(environment.network.allowlist[0].transform?.Authorization, "Bearer fresh-token");
});
