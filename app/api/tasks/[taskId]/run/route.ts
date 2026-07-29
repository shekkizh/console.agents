import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { getManagedAgentRun } from "@/lib/server/gemini";
import { completeRun, getWorkspace, markRunStarted } from "@/lib/server/store";

export async function GET(_request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { taskId } = await context.params;
    const task = (await getWorkspace(ownerId)).tasks.find((item) => item.id === taskId);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!task.interactionId) return NextResponse.json(task);

    const result = await getManagedAgentRun(task.interactionId);
    const updated = result.status === "running"
      ? await markRunStarted(ownerId, taskId, result)
      : await completeRun(ownerId, taskId, result);
    return NextResponse.json(updated);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to refresh run" }, { status: 400 });
  }
}
