import assert from "node:assert/strict";
import test from "node:test";
import { flattenInboundMessage, validConsoleMessageId } from "../lib/inbound-message.ts";

test("validates idempotency keys accepted by the Eve ingress", () => {
  assert.equal(validConsoleMessageId("0193f73a-1234-4abc-9123-123456789abc"), true);
  assert.equal(validConsoleMessageId("short"), false);
  assert.equal(validConsoleMessageId("bad value"), false);
  assert.equal(validConsoleMessageId(undefined), false);
});

test("preserves text and attachment names in inbound messages", () => {
  assert.equal(flattenInboundMessage("hello"), "hello");
  assert.equal(
    flattenInboundMessage([
      { type: "text", text: "inspect this" },
      { type: "file", data: "data:text/plain;base64,QQ==", mediaType: "text/plain", filename: "a.txt" },
    ]),
    "inspect this\n[file: a.txt]",
  );
});
