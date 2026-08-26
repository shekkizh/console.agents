import { after, NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { stopConversation } from "@/lib/server/conversation-store";
import { cancelSandboxTask } from "@/lib/server/agent-sandbox";
import { getAgent } from "@/lib/server/agent-store";
import { config } from "@/lib/server/config";
import { dispatchNextAgentTask } from "@/lib/server/task-dispatcher";

export async function POST(
  _request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const ownerId = await requireOwner();
    const { conversationId } = await context.params;
    const result = await stopConversation(ownerId, conversationId);
    after(async () => {
      if (!config.e2eFakeFx) {
        await Promise.allSettled(result.targets.map(async (target) => {
          const agent = await getAgent(ownerId, target.agentId);
          if (agent) {
            await cancelSandboxTask({
              ownerId,
              agent,
              messageId: target.messageId,
            });
          }
        }));
      }
      const agentIds = [...new Set(result.targets.map((target) => target.agentId))];
      await Promise.allSettled(agentIds.map((agentId) =>
        dispatchNextAgentTask({ ownerId, agentId })
      ));
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to stop conversation";
    return NextResponse.json(
      { error: message },
      { status: message === "Unauthorized" ? 401 : message === "Conversation not found" ? 404 : 400 },
    );
  }
}
