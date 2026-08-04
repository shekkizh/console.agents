import "server-only";

import { z } from "zod";
import {
  channelHasQueuedDeliveries,
  claimChannelDeliveries,
  completeChannelDelivery,
  getChannel,
  getChannelMemberRun,
  postChannelMessage,
  recordChannelArtifacts,
  setChannelStatus,
  updateChannelMemberRun,
} from "@/lib/server/channel-store";
import {
  continueManagedAgentWithFunctionResults,
  runManagedAgent,
  type DelegationCall,
  type FunctionResultInput,
  type ManagedRunResult,
} from "@/lib/server/gemini";
import { getAgent } from "@/lib/server/store";
import type { Channel, ChannelParticipant } from "@/lib/types";

const peerMessageSchema = z.object({ recipient: z.string().trim().min(1).max(80).optional(), message: z.string().trim().min(1).max(8_000) });

function argumentsObject(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function transcriptContext(channel: Channel, recipient: ChannelParticipant, messageId: string) {
  const recent = channel.messages.slice(-30).map((message) => {
    const target = message.delivery === "direct" ? ` -> ${message.recipientIds.map((id) => channel.participants.find((peer) => peer.id === id)?.name ?? id).join(", ")}` : " -> team";
    return `[${message.authorName}${target}] ${message.content}`;
  }).join("\n");
  return `You are ${recipient.name}, an equal peer in the shared channel “${channel.title}”. Every line below is persisted in the shared transcript. Coordinate by name with send_channel_message; do not invent parent or child tasks. Respond to the message identified as ${messageId}.\n\n${recent}`;
}

async function executePeerCall(ownerId: string, channel: Channel, sender: ChannelParticipant, call: DelegationCall): Promise<FunctionResultInput> {
  if (call.name === "list_console_agents") {
    return { callId: call.id, name: call.name, result: { status: "completed", participants: channel.participants.map(({ id, name, type, specialty }) => ({ id, name, type, specialty })) } };
  }

  if (call.name === "send_channel_message") {
    const parsed = peerMessageSchema.safeParse(argumentsObject(call.arguments));
    if (!parsed.success) return { callId: call.id, name: call.name, result: { status: "failed", error: "Invalid peer message" } };
    const recipient = parsed.data.recipient
      ? channel.participants.find((participant) => participant.name.toLocaleLowerCase() === parsed.data.recipient!.toLocaleLowerCase())
      : undefined;
    if (parsed.data.recipient && !recipient) return { callId: call.id, name: call.name, result: { status: "failed", error: `No channel participant named ${parsed.data.recipient}` } };
    const posted = await postChannelMessage(ownerId, channel.id, {
      senderId: sender.id, senderType: "agent", senderName: sender.name, content: parsed.data.message,
      recipientIds: recipient ? [recipient.id] : undefined,
    });
    return { callId: call.id, name: call.name, result: { status: "queued", message_id: posted.id, recipient: recipient?.name ?? "team" } };
  }

  return { callId: call.id, name: call.name, result: { status: "failed", error: `Tool ${call.name} is not available during a channel activation` } };
}

async function finishPeerCalls(ownerId: string, channel: Channel, sender: ChannelParticipant, initial: ManagedRunResult): Promise<ManagedRunResult> {
  let result = initial;
  for (let depth = 0; result.status === "requires_action" && depth < 12; depth += 1) {
    const accepted = result.pendingCalls.slice(0, 6);
    const functionResults = await Promise.all(accepted.map((call) => executePeerCall(ownerId, channel, sender, call)));
    const agent = await getAgent(ownerId, sender.agentId ?? sender.id);
    if (!agent) throw new Error(`${sender.name} is no longer available`);
    result = await continueManagedAgentWithFunctionResults(ownerId, agent, result.interactionId, result.environmentId, functionResults);
  }
  if (result.status === "requires_action") throw new Error("Peer coordination action limit reached");
  return result;
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
    const state = await getChannelMemberRun(ownerId, channelId, participant.id);
    let result = await runManagedAgent(transcriptContext(channel, participant, delivery.message.id), state.interactionId, state.environmentId, channel.repositoryUrl, agent, {
      enablePlatformTools: true, ownerId,
    });
    result = await finishPeerCalls(ownerId, channel, participant, result);
    if (result.status !== "completed" && result.status !== "failed") throw new Error("Agent activation did not finish synchronously");
    await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "ready", interactionId: result.interactionId, environmentId: result.environmentId });
    await postChannelMessage(ownerId, channelId, {
      senderId: participant.id, senderType: "agent", senderName: participant.name,
      content: result.output || (result.status === "failed" ? "I could not complete this channel turn." : "Done."),
      recipientIds: [delivery.message.authorId], steps: result.steps,
    });
    await recordChannelArtifacts(ownerId, channelId, result.steps);
    await completeChannelDelivery(ownerId, delivery.id, result.status === "failed" ? "failed" : "delivered", result.status === "failed" ? result.output : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to run channel peer";
    if (message.includes("429")) {
      await updateChannelMemberRun(ownerId, channelId, participant.id, { status: "offline" });
      await completeChannelDelivery(ownerId, delivery.id, "queued");
      return false;
    }
    await postChannelMessage(ownerId, channelId, {
      senderId: participant.id, senderType: "agent", senderName: participant.name,
      content: message, recipientIds: [delivery.message.authorId],
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
  await setChannelStatus(ownerId, channelId, await channelHasQueuedDeliveries(ownerId, channelId) ? "waiting" : "completed");
}
