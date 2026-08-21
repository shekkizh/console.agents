import assert from "node:assert/strict";
import test from "node:test";
import { fxNetworkAllowlistSchema } from "../lib/agent-capabilities.ts";
import {
  activeFxNetworkPolicy,
  idleFxNetworkPolicy,
  stopsFxSandboxAfterTurn,
} from "../lib/server/fx-network-policy.ts";

function allowMap(policy: ReturnType<typeof idleFxNetworkPolicy>) {
  if (typeof policy === "string") throw new Error("Expected a structured network policy");
  assert.ok(policy.allow && !Array.isArray(policy.allow));
  return policy.allow;
}

test("keeps model and development egress closed while the sandbox is idle", () => {
  const allow = allowMap(idleFxNetworkPolicy());
  assert.deepEqual(Object.keys(allow), ["github.com", "*.githubusercontent.com"]);
});

test("allows unrestricted egress in full mode", () => {
  assert.equal(activeFxNetworkPolicy("full"), "allow-all");
});

test("keeps only the model connection in none mode", () => {
  const policy = activeFxNetworkPolicy("none");
  const allow = allowMap(policy);
  assert.deepEqual(Object.keys(allow), ["ai-gateway.vercel.sh"]);
});

test("adds configured domains in allowlist mode", () => {
  const policy = activeFxNetworkPolicy("allowlist", ["github.com", "*.npmjs.org"]);
  const allow = allowMap(policy);
  assert.deepEqual(Object.keys(allow), ["ai-gateway.vercel.sh", "github.com", "*.npmjs.org"]);
});

test("normalizes and validates allowlist domains", () => {
  assert.deepEqual(
    fxNetworkAllowlistSchema.parse(["GitHub.com", "github.com", "*.npmjs.org"]),
    ["github.com", "*.npmjs.org"],
  );
  assert.throws(() => fxNetworkAllowlistSchema.parse(["https://github.com"]));
});

test("stops compute after local Microsandbox turns", () => {
  assert.equal(stopsFxSandboxAfterTurn(undefined), true);
  assert.equal(stopsFxSandboxAfterTurn("1"), false);
});
