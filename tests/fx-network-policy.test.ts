import assert from "node:assert/strict";
import test from "node:test";
import {
  activeFxNetworkPolicy,
  idleFxNetworkPolicy,
  usesStaticFxNetworkPolicy,
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

test("allows the AI Gateway only while an agent turn is active", () => {
  const policy = activeFxNetworkPolicy();
  const allow = allowMap(policy);
  assert.deepEqual(allow["ai-gateway.vercel.sh"], []);
});

test("uses static policy only on the stoppable Microsandbox backend", () => {
  assert.equal(usesStaticFxNetworkPolicy(undefined), true);
  assert.equal(usesStaticFxNetworkPolicy("1"), false);
});
