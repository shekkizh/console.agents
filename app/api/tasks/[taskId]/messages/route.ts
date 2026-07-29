import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERAL_AGENT_ID } from "@/lib/general-agent";
import { requireOwner } from "@/lib/server/auth";
import { runManagedAgent } from "@/lib/server/gemini";
import { appendUserMessage, completeRun, failRun, getTaskAgent, markRunStarted } from "@/lib/server/store";

const messageSchema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { taskId } = await context.params;
    const { content } = messageSchema.parse(await request.json());
    const task = await appendUserMessage(ownerId, taskId, content);
    const agent = await getTaskAgent(ownerId, taskId);
    if (!agent) throw new Error("This task's agent is no longer available");
    let updated;
    try {
      const result = await runManagedAgent(content, task.interactionId, task.environmentId, task.repositoryUrl, agent, {
        allowDelegation: agent.id === GENERAL_AGENT_ID && !task.parentTaskId,
        ownerId,
      });
      updated = result.status === "completed" || result.status === "failed"
        ? await completeRun(ownerId, taskId, { ...result, status: result.status })
        : await markRunStarted(ownerId, taskId, result);
    } catch (error) {
      updated = await failRun(ownerId, taskId, error instanceof Error ? error.message : "Unable to start the managed run.");
    }

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
