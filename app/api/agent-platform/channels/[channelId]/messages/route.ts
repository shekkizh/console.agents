import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgentPlatformIdentity } from "@/lib/server/agent-platform-auth";
import { getChannel, postChannelMessage } from "@/lib/server/channel-store";

const sendMessageSchema = z.object({
  recipient: z.string().trim().min(1).max(80).optional(),
  message: z.string().trim().min(1).max(8_000),
});

function failure(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Agent platform request failed";
  return NextResponse.json({ success: false, error: message }, { status: message.startsWith("Unauthorized") ? 401 : status });
}

/**
 * Control-plane endpoint the in-sandbox `send_channel_message` tool calls to talk to peers.
 * The bearer token scopes the request to a single { ownerId, agentId }; the agent may only
 * post as its own channel participant.
 */
export async function POST(request: Request, context: { params: Promise<{ channelId: string }> }) {
  try {
    const { ownerId, agentId } = await requireAgentPlatformIdentity(request);
    const { channelId } = await context.params;
    const input = sendMessageSchema.parse(await request.json());

    const channel = await getChannel(ownerId, channelId);
    if (!channel) return failure(new Error("Channel not found"), 404);

    const sender = channel.participants.find(
      (participant) => participant.type === "agent" && (participant.agentId ?? participant.id) === agentId,
    );
    if (!sender) return failure(new Error("You are not a member of this channel"), 403);

    let recipientIds: string[] | undefined;
    if (input.recipient) {
      const target = channel.participants.find(
        (participant) =>
          participant.id !== sender.id && participant.name.toLowerCase() === input.recipient!.toLowerCase(),
      );
      if (!target) return failure(new Error(`No channel member named "${input.recipient}"`), 404);
      recipientIds = [target.id];
    }

    const message = await postChannelMessage(ownerId, channelId, {
      senderId: sender.id,
      senderType: "agent",
      senderName: sender.name,
      content: input.message,
      recipientIds,
    });
    return NextResponse.json({ success: true, message });
  } catch (error) {
    return failure(error);
  }
}
