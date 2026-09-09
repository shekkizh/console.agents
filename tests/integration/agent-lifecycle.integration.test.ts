import assert from "node:assert/strict";
import test from "node:test";
import { withAgentLifecycleLock } from "../../lib/server/agent-lifecycle.ts";

const databaseEnabled = process.env.RUN_DATABASE_TESTS === "1" && Boolean(process.env.DATABASE_URL);

test("agent lifecycle locks serialize independent callers and permit nested operations", { skip: !databaseEnabled }, async () => {
  const input = { ownerId: `lock-test-${process.pid}-${Date.now()}`, agentId: "agent" };
  const order: string[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = withAgentLifecycleLock(input, async () => {
    order.push("first");
    await withAgentLifecycleLock(input, async () => { order.push("nested"); });
    entered();
    await gate;
    order.push("released");
  });
  await started;
  const second = withAgentLifecycleLock(input, async () => { order.push("second"); });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(order, ["first", "nested"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "nested", "released", "second"]);
});

test("lifecycle lock releases after errors", { skip: !databaseEnabled }, async () => {
  const input = { ownerId: `lock-failure-${process.pid}-${Date.now()}`, agentId: "agent" };
  await assert.rejects(withAgentLifecycleLock(input, async () => { throw new Error("planned failure"); }), /planned failure/);
  assert.equal(await withAgentLifecycleLock(input, async () => "acquired"), "acquired");
});

test("async descendants reacquire the lifecycle lock after its original scope releases", { skip: !databaseEnabled }, async () => {
  const input = { ownerId: `lock-descendant-${process.pid}-${Date.now()}`, agentId: "agent" };
  let startChild!: () => void;
  const childGate = new Promise<void>((resolve) => { startChild = resolve; });
  let child!: Promise<void>;
  let childEntered = false;
  await withAgentLifecycleLock(input, async () => {
    child = childGate.then(() => withAgentLifecycleLock(input, async () => { childEntered = true; }));
  });
  let blockerEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { blockerEntered = resolve; });
  let releaseBlocker!: () => void;
  const blockerGate = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const blocker = withAgentLifecycleLock(input, async () => { blockerEntered(); await blockerGate; });
  await blocked;
  startChild();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(childEntered, false);
  releaseBlocker();
  await Promise.all([blocker, child]);
  assert.equal(childEntered, true);
});
