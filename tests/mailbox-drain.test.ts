import assert from "node:assert/strict";
import test from "node:test";
import { drainMailbox } from "../lib/server/mailbox-drain.ts";

test("drains messages in FIFO order with one activation at a time", async () => {
  const inbox = ["alpha", "beta"];
  const started: string[] = [];
  let active = 0;
  let maxActive = 0;

  const replies: string[] = [];
  for await (const reply of drainMailbox({
    next: async () => inbox.shift(),
    activate: async (message) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(message);
      if (message === "alpha") inbox.push("gamma");
      await Promise.resolve();
      active -= 1;
      return `reply:${message}`;
    },
  })) {
    replies.push(reply);
  }

  assert.deepEqual(started, ["alpha", "beta", "gamma"]);
  assert.deepEqual(replies, ["reply:alpha", "reply:beta", "reply:gamma"]);
  assert.equal(maxActive, 1);
});

test("does not activate an empty mailbox", async () => {
  let activations = 0;
  const replies = [];
  for await (const reply of drainMailbox({
    next: async () => undefined,
    activate: async () => {
      activations += 1;
      return "unexpected";
    },
  })) {
    replies.push(reply);
  }
  assert.deepEqual(replies, []);
  assert.equal(activations, 0);
});

test("honors cancellation before claiming another message", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const iterator = drainMailbox({
    abortSignal: controller.signal,
    next: async () => "work",
    activate: async (message) => message,
  });
  await assert.rejects(iterator.next(), /cancelled/);
});
