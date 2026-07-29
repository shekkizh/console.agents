import { NextResponse } from "next/server";
import { z } from "zod";
import { GENERAL_AGENT_ID } from "@/lib/general-agent";
import { requireOwner } from "@/lib/server/auth";
import { runManagedAgent } from "@/lib/server/gemini";
import { completeRun, createTask, failRun, getLatestAgentEnvironment, getTaskAgent, markRunStarted } from "@/lib/server/store";

const createTaskSchema = z.object({
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().min(4).max(8_000),
  agentId: z.string().trim().min(1).max(80),
  repositoryUrl: z.string().trim().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  }, "Use an HTTPS github.com repository URL").optional().or(z.literal("").transform(() => undefined)),
});

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const input = createTaskSchema.parse(await request.json());
    const task = await createTask(ownerId, input);
    const agent = await getTaskAgent(ownerId, task.id);
    if (!agent) throw new Error("This task's agent is no longer available");
    let updated;
    try {
      const environmentId = await getLatestAgentEnvironment(ownerId, task.agentId);
      const result = await runManagedAgent(task.summary, undefined, environmentId, task.repositoryUrl, agent, {
        allowDelegation: agent.id === GENERAL_AGENT_ID,
        ownerId,
      });
      updated = result.status === "completed" || result.status === "failed"
        ? await completeRun(ownerId, task.id, { ...result, status: result.status })
        : await markRunStarted(ownerId, task.id, result);
    } catch (error) {
      updated = await failRun(ownerId, task.id, error instanceof Error ? error.message : "Unable to start the managed run.");
    }
    return NextResponse.json(updated, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create task";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
