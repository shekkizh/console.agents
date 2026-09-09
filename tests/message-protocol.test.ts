import assert from "node:assert/strict";
import test from "node:test";
import { completionDestination, messagePurpose, messagePurposeSql } from "../lib/message-protocol.ts";

test("reply obligations come from the envelope, never the final answer's wording", () => {
  const peer = { senderType: "agent", senderId: "peer" };
  assert.equal(messagePurpose(peer), "request");
  for (const envelope of [
    { inReplyTo: "request" }, { kind: "error" }, { metadata: { activity: "completion" } },
  ]) {
    assert.equal(messagePurpose({ ...peer, ...envelope }), "reply");
    assert.deepEqual(completionDestination({ ...peer, ...envelope }, "owner", "self"), {
      recipientType: "agent", recipientId: "self", messagePurpose: "receipt",
    });
  }
  assert.deepEqual(completionDestination(peer, "owner", "self"), {
    recipientType: "agent", recipientId: "peer", messagePurpose: "reply",
  });
  assert.equal(messagePurpose({ ...peer, metadata: { activity: "completion", messagePurpose: "receipt" } }), "receipt");
  assert.equal(messagePurpose({ ...peer, inReplyTo: "request", metadata: { activity: "progress" } }), "progress");
  assert.throws(() => messagePurposeSql("m; DROP TABLE agents"), /Invalid SQL alias/);
});
