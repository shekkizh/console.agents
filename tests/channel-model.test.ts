import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import { orderChannelMessages, resolveDeliveryRecipients } from "../lib/channel-model.ts";
import type { Channel, ChannelMessage, ChannelParticipant } from "../lib/types.ts";

const human: ChannelParticipant = {
  id: "human:sarath",
  type: "human",
  name: "Sarath",
  initials: "SA",
  color: "#ffffff",
  status: "ready",
};

const general: ChannelParticipant = {
  id: "agent:general",
  agentId: "general",
  type: "agent",
  name: "General",
  initials: "GE",
  specialty: "Generalist",
  color: "#c8f169",
  status: "ready",
};

const researcher: ChannelParticipant = {
  id: "agent:researcher",
  agentId: "researcher",
  type: "agent",
  name: "Researcher",
  initials: "RE",
  specialty: "Research",
  color: "#8bb8ff",
  status: "ready",
};

const participants = [human, general, researcher];

test("named humans and agents use the same participant contract", () => {
  assert.deepEqual(participants.map(({ id, type, name }) => ({ id, type, name })), [
    { id: "human:sarath", type: "human", name: "Sarath" },
    { id: "agent:general", type: "agent", name: "General" },
    { id: "agent:researcher", type: "agent", name: "Researcher" },
  ]);

  const channel = {
    id: "channel-1",
    title: "Ship the peer mesh",
    summary: "Coordinate as peers",
    status: "running",
    participantIds: participants.map((participant) => participant.id),
    participants,
    messages: [],
    artifacts: [],
    createdAt: "2026-07-29T17:00:00.000Z",
    updatedAt: "2026-07-29T17:00:00.000Z",
  } satisfies Channel;

  assert.equal(channel.participants[0].name, "Sarath");
  assert.equal("parentChannelId" in channel, false, "peer channels must be flat rather than parent/child tasks");
});

test("broadcast routing is sender-agnostic and schedules every other agent", () => {
  assert.deepEqual(resolveDeliveryRecipients(participants, human.id).map((participant) => participant.id), [general.id, researcher.id]);
  assert.deepEqual(resolveDeliveryRecipients(participants, general.id, []).map((participant) => participant.id), [researcher.id]);
});

test("direct routing is exact, deduplicated, and can address a human peer", () => {
  assert.deepEqual(
    resolveDeliveryRecipients(participants, general.id, [researcher.id, human.id, researcher.id]).map((participant) => participant.id),
    [researcher.id, human.id],
  );
  assert.throws(
    () => resolveDeliveryRecipients(participants, general.id, [general.id]),
    /sender|self/i,
  );
  assert.throws(
    () => resolveDeliveryRecipients(participants, human.id, ["agent:unknown"]),
    /participant|recipient|member/i,
  );
});

test("the persisted transcript has deterministic chronological and id ordering", () => {
  const later: ChannelMessage = {
    id: "message-c",
    role: "agent",
    author: "Researcher",
    authorId: researcher.id,
    authorName: researcher.name,
    authorType: "agent",
    recipientIds: [human.id],
    delivery: "direct",
    content: "The report is ready.",
    createdAt: "2026-07-29T17:00:02.000Z",
  };
  const sameTimeSecond: ChannelMessage = {
    id: "message-b",
    role: "agent",
    author: "General",
    authorId: general.id,
    authorName: general.name,
    authorType: "agent",
    recipientIds: [researcher.id],
    delivery: "direct",
    content: "Please research this.",
    createdAt: "2026-07-29T17:00:01.000Z",
  };
  const sameTimeFirst: ChannelMessage = {
    id: "message-a",
    role: "user",
    author: "Sarath",
    authorId: human.id,
    authorName: human.name,
    authorType: "human",
    recipientIds: [general.id, researcher.id],
    delivery: "broadcast",
    content: "Work together on this.",
    createdAt: "2026-07-29T17:00:01.000Z",
  };

  const ordered = orderChannelMessages([later, sameTimeSecond, sameTimeFirst]);
  assert.deepEqual(ordered.map((message) => message.id), ["message-a", "message-b", "message-c"]);
  assert.deepEqual([later, sameTimeSecond, sameTimeFirst].map((message) => message.id), [
    "message-c",
    "message-b",
    "message-a",
  ], "ordering must not mutate the persisted snapshot");
});

test("file output remains attached to the unified transcript and channel artifact collection", () => {
  const output: ChannelMessage = {
    id: "message-file",
    role: "agent",
    author: "Researcher",
    authorId: researcher.id,
    authorName: researcher.name,
    authorType: "agent",
    recipientIds: [],
    delivery: "broadcast",
    content: "Attached the final report.",
    createdAt: "2026-07-29T17:00:03.000Z",
    steps: [{
      id: "step-file",
      kind: "file",
      label: "Final report",
      detail: "/workspace/final-report.md",
      createdAt: "2026-07-29T17:00:03.000Z",
    }],
  };
  const channel = {
    id: "channel-1",
    title: "Ship the peer mesh",
    summary: "Coordinate as peers",
    status: "completed",
    participantIds: participants.map((participant) => participant.id),
    participants,
    messages: orderChannelMessages([output]),
    artifacts: [{ id: "artifact-1", name: "final-report.md", kind: "Markdown", url: "/workspace/final-report.md" }],
    createdAt: "2026-07-29T17:00:00.000Z",
    updatedAt: "2026-07-29T17:00:03.000Z",
  } satisfies Channel;

  assert.equal(channel.messages[0].steps?.[0].kind, "file");
  assert.equal(channel.artifacts[0].name, "final-report.md");
});
