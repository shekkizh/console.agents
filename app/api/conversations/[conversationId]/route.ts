import { after, NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import {
  deleteConversation,
  getConversation,
  listConversationActivity,
  listConversationMessages,
} from "@/lib/server/conversation-store";
import {
  dispatchNextAgentTask,
  recoverCompletedConversationTask,
  settleCompletedAgentTask,
} from "@/lib/server/task-dispatcher";

export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    let conversation = await getConversation(ownerId, conversationId);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    if (
      conversation.status === "working" &&
      new URL(request.url).searchParams.get("recover") === "1"
    ) {
      const recovered = await recoverCompletedConversationTask({ ownerId, conversationId });
      if (recovered.status === "completed") {
        const agentId = conversation.agentId;
        after(() =>
          settleCompletedAgentTask({ ownerId, agentId }).catch(() => undefined)
        );
        conversation = (await getConversation(ownerId, conversationId)) ?? conversation;
      }
    }
    if (conversation.status === "working") {
      after(() =>
        dispatchNextAgentTask({
          ownerId,
          agentId: conversation.agentId,
        }).catch(() => undefined)
      );
    }
    return NextResponse.json({
      conversation,
      messages: await listConversationMessages(ownerId, conversationId),
      activity: await listConversationActivity(ownerId, conversationId),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load conversation";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    await deleteConversation(ownerId, conversationId);
    return new Response(null, { status: 204 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete conversation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Conversation not found" ? 404 : 400 },
    );
  }
}
