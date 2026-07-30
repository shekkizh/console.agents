import { NextResponse } from "next/server";
import { z } from "zod";
import { humanParticipant, postChannelMessage } from "@/lib/server/channel-store";
import { requireOwner } from "@/lib/server/auth";
import { runPeerChannel } from "@/lib/server/peer-runner";
import { getWorkspace } from "@/lib/server/store";

export const maxDuration = 300;

const messageSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  recipientIds: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  replyToId: z.string().uuid().optional(),
});

export async function POST(request: Request, context: { params: Promise<{ channelId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { channelId } = await context.params;
    const input = messageSchema.parse(await request.json());
    const human = humanParticipant(ownerId);
    await postChannelMessage(ownerId, channelId, {
      senderId: human.id, senderType: "human", senderName: human.name,
      content: input.content, recipientIds: input.recipientIds, replyToId: input.replyToId,
    });
    await runPeerChannel(ownerId, channelId);
    return NextResponse.json(await getWorkspace(ownerId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send channel message";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : message === "Channel not found" ? 404 : 400 });
  }
}
