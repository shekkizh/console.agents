import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { runManagedAgent } from "@/lib/server/gemini";
import { appendUserMessage, completeRun, markRunStarted } from "@/lib/server/store";

const messageSchema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { taskId } = await context.params;
    const { content } = messageSchema.parse(await request.json());
    const task = await appendUserMessage(ownerId, taskId, content);
    const result = await runManagedAgent(content, task.interactionId, task.environmentId, task.repositoryUrl);

    const updated = result.status === "running"
      ? await markRunStarted(ownerId, taskId, result)
      : await completeRun(ownerId, taskId, result);

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to send message";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
