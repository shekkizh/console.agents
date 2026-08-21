import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_RUNTIME_VERSION,
  visibleConversationSessionId,
} from "../lib/conversation-runtime.ts";

test("hides stale Eve sessions so the next send creates the mailbox runtime", () => {
  assert.equal(visibleConversationSessionId(CONVERSATION_RUNTIME_VERSION - 1, "old"), null);
  assert.equal(visibleConversationSessionId(CONVERSATION_RUNTIME_VERSION, "current"), "current");
  assert.equal(visibleConversationSessionId(CONVERSATION_RUNTIME_VERSION, null), null);
});
