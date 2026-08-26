import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { getConversation } from "@/lib/server/conversation-store";
import { publishConversationMessage } from "@/lib/server/message-store";
import { dispatchNextAgentTask } from "@/lib/server/task-dispatcher";

export const maxDuration = 300;

const messageSchema = z.object({
  id: z.string().uuid(),
  content: z.string().trim().min(1).max(100_000),
}).strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    const conversation = await getConversation(ownerId, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    const body = messageSchema.parse(await request.json());
    const message = await publishConversationMessage({
      ownerId,
      id: body.id,
      conversationId,
      senderType: "human",
      senderId: ownerId,
      recipientType: "agent",
      recipientId: conversation.agentId,
      content: body.content,
    });
    after(() =>
      dispatchNextAgentTask({
        ownerId,
        agentId: conversation.agentId,
      }).catch(() => undefined)
    );
    return NextResponse.json({ message }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    const status = message === "Unauthorized"
      ? 401
      : message === "Conversation not found"
        ? 404
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
