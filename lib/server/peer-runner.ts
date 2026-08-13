import "server-only";

import { isAgentSandboxBusyError } from "@/lib/agent-sandbox-lifecycle";
import { runAgentTurn } from "@/lib/server/agent-runtime";
import {
  channelHasQueuedDeliveries,
  claimChannelDeliveries,
  completeChannelDelivery,
  getChannel,
  postChannelMessage,
  recordChannelArtifacts,
  setChannelStatus,
  updateChannelMemberRun,
} from "@/lib/server/channel-store";
import { getAgent } from "@/lib/server/store";
import type { Channel, ChannelParticipant } from "@/lib/types";

function systemInstructions(recipient: ChannelParticipant, specialty: string, instructions: string) {
  return `You are ${recipient.name}, a ${specialty}. ${instructions}`;
}

function transcriptPrompt(channel: Channel, recipient: ChannelParticipant, messageId: string) {
  const recent = channel.messages
    .slice(-30)
    .map((message) => {
      const target = message.delivery === "direct"
        ? ` -> ${message.recipientIds.map((id) => channel.participants.find((peer) => peer.id === id)?.name ?? id).join(", ")}`
        : " -> team";
      return `[${message.authorName}${target}] ${message.content}`;
    })
    .join("\n");
  return `You are ${recipient.name}, an equal peer in the shared channel “${channel.title}”. Every line below is persisted in the shared transcript. Coordinate by name with send_channel_message; do not invent parent or child tasks. Respond to the message identified as ${messageId}.\n\n${recent}`;
}

async function activatePeer(ownerId: string, channelId: string, participant: ChannelParticipant) {
  const deliveries = await claimChannelDeliveries(ownerId, channelId, participant.id, 1);
  const delivery = deliveries[0];
  if (!delivery) return false;
  const agent = await getAgent(ownerId, participant.agentId ?? participant.id);
  if (!agent) {
    await completeChannelDelivery(ownerId, delivery.id, "failed", "Agent is no longer available");
    return true;
  }
  await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "working" });
  try {
    const channel = await getChannel(ownerId, channelId);
    if (!channel) throw new Error("Channel not found");
    const result = await runAgentTurn({
      ownerId,
      agent,
      channelId,
      systemInstructions: systemInstructions(participant, agent.specialty, agent.instructions),
      prompt: transcriptPrompt(channel, participant, delivery.message.id),
    });
    await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "ready" });
    await postChannelMessage(ownerId, channelId, {
      senderId: participant.id,
      senderType: "agent",
      senderName: participant.name,
      content: result.output || (result.status === "failed" ? "I could not complete this channel turn." : "Done."),
      recipientIds: [delivery.message.authorId],
      steps: result.steps,
    });
    await recordChannelArtifacts(ownerId, channelId, agent.id, result.steps);
    await completeChannelDelivery(
      ownerId,
      delivery.id,
      result.status === "failed" ? "failed" : "delivered",
      result.status === "failed" ? result.output : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to run channel peer";
    if (isAgentSandboxBusyError(error)) {
      await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "ready" });
      await completeChannelDelivery(ownerId, delivery.id, "queued");
      return false;
    }
    if (message.includes("429") || /rate.?limit/i.test(message)) {
      await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "offline" });
      await completeChannelDelivery(ownerId, delivery.id, "queued");
      return false;
    }
    await postChannelMessage(ownerId, channelId, {
      senderId: participant.id,
      senderType: "agent",
      senderName: participant.name,
      content: message,
      recipientIds: [delivery.message.authorId],
    });
    await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "ready" });
    await completeChannelDelivery(ownerId, delivery.id, "failed", message);
  }
  return true;
}

/** Drain persisted peer inboxes. Each round is parallel across agents, ordered within each inbox. */
export async function runPeerChannel(ownerId: string, channelId: string): Promise<void> {
  await setChannelStatus(ownerId, channelId, "running");
  for (let round = 0; round < 12; round += 1) {
    const channel = await getChannel(ownerId, channelId);
    if (!channel) throw new Error("Channel not found");
    const agents = channel.participants.filter((participant) => participant.type === "agent" && participant.status !== "offline");
    const activated = await Promise.all(agents.map((participant) => activatePeer(ownerId, channelId, participant)));
    if (!activated.some(Boolean)) break;
  }
  await setChannelStatus(ownerId, channelId, (await channelHasQueuedDeliveries(ownerId, channelId)) ? "waiting" : "completed");
}
