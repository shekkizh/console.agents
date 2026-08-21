import assert from "node:assert/strict";
import test from "node:test";
import { projectAgentTranscript, type AgentEventRow } from "../lib/agent-transcript.ts";

const at = "2026-08-20T00:00:00.000Z";

test("projects one visible reply for each request without collapsing duplicate text", () => {
  const rows: AgentEventRow[] = [
    { id: "u1", event_type: "message.user", payload: { message: "same", requestId: "r1" }, created_at: at },
    { id: "u2", event_type: "message.user", payload: { message: "same", requestId: "r2" }, created_at: at },
    { id: "a1", event_type: "message.assistant", payload: { message: "first", requestId: "r1" }, created_at: at },
    { id: "a2", event_type: "message.assistant", payload: { message: "second", requestId: "r2" }, created_at: at },
  ];

  assert.deepEqual(
    projectAgentTranscript(rows).map(({ requestId, role, text }) => ({ requestId, role, text })),
    [
      { requestId: "r1", role: "user", text: "same" },
      { requestId: "r2", role: "user", text: "same" },
      { requestId: "r1", role: "assistant", text: "first" },
      { requestId: "r2", role: "assistant", text: "second" },
    ],
  );
});

test("marks the matching request failed without creating a phantom assistant message", () => {
  const messages = projectAgentTranscript([
    { id: "u1", event_type: "message.user", payload: { message: "work", requestId: "r1" }, created_at: at },
    { id: "f1", event_type: "message.failed", payload: { requestId: "r1", diagnostic: "boom" }, created_at: at },
  ]);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.failed, true);
});

test("keeps legacy events without request IDs readable", () => {
  const messages = projectAgentTranscript([
    { id: "legacy", event_type: "message.user", payload: { message: "old" }, created_at: at },
  ]);
  assert.equal(messages[0]?.requestId, "legacy");
});

test("projects validated inline preview metadata", () => {
  const messages = projectAgentTranscript([
    {
      id: "assistant",
      event_type: "message.assistant",
      payload: {
        message: "Here is the chart.",
        requestId: "request",
        artifacts: [
          {
            id: "artifact-id",
            name: "chart.png",
            title: "Revenue chart",
            mediaType: "image/png",
            kind: "image",
            size: 2048,
          },
          { id: "invalid", kind: "executable" },
        ],
      },
      created_at: at,
    },
  ]);

  assert.deepEqual(messages[0]?.artifacts, [
    {
      id: "artifact-id",
      name: "chart.png",
      title: "Revenue chart",
      mediaType: "image/png",
      kind: "image",
      size: 2048,
    },
  ]);
});
