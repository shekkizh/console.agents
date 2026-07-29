import "server-only";

import { z } from "zod";
import { generalAgent } from "@/lib/general-agent";
import { continueManagedAgentWithFunctionResults, getManagedAgentRun, runManagedAgent, type DelegationCall, type FunctionResultInput, type ManagedRunResult } from "@/lib/server/gemini";
import { claimDelegatedTaskStart, completeRun, createDelegatedTask, failRun, findDelegatedTask, markRunStarted } from "@/lib/server/store";
import type { AgentTask } from "@/lib/types";

const delegationInputSchema = z.object({
  title: z.string().trim().min(2).max(120),
  brief: z.string().trim().min(8).max(8_000),
});

type DelegationState = { call: DelegationCall; task?: AgentTask; error?: string };

function parseArguments(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

async function advanceChild(ownerId: string, parentTask: AgentTask, call: DelegationCall): Promise<DelegationState> {
  if (call.name !== "delegate_task") return { call, error: `Unknown function: ${call.name}` };
  const parsed = delegationInputSchema.safeParse(parseArguments(call.arguments));
  if (!parsed.success) return { call, error: "The delegated brief was invalid." };

  let child = await findDelegatedTask(ownerId, parentTask.id, parentTask.interactionId!, call.id);
  if (!child) {
    child = await createDelegatedTask(ownerId, {
      parentTaskId: parentTask.id,
      parentInteractionId: parentTask.interactionId!,
      callId: call.id,
      title: parsed.data.title,
      brief: parsed.data.brief,
      repositoryUrl: parentTask.repositoryUrl,
    });
  }

  if (!child.interactionId && child.status === "queued") {
    const claimed = await claimDelegatedTaskStart(ownerId, child.id);
    if (!claimed) {
      const current = await findDelegatedTask(ownerId, parentTask.id, parentTask.interactionId!, call.id);
      if (!current) return { call, error: "Delegated task state could not be recovered." };
      return { call, task: current };
    }
    try {
      const started = await runManagedAgent(parsed.data.brief, undefined, undefined, child.repositoryUrl, generalAgent, {
        allowDelegation: false,
        maxTotalTokens: 15_000,
      });
      child = started.status === "completed" || started.status === "failed"
        ? await completeRun(ownerId, child.id, { ...started, status: started.status })
        : await markRunStarted(ownerId, child.id, started);
    } catch (error) {
      child = await failRun(ownerId, child.id, error instanceof Error ? error.message : "Unable to start delegated work.");
    }
    return { call, task: child };
  }

  if (!child.interactionId) return { call, task: child };
  if (child.status === "running" || child.status === "queued") {
    const result = await getManagedAgentRun(child.interactionId);
    child = result.status === "completed" || result.status === "failed"
      ? await completeRun(ownerId, child.id, { ...result, status: result.status })
      : await markRunStarted(ownerId, child.id, result);
  }
  return { call, task: child };
}

function functionResult(state: DelegationState): FunctionResultInput {
  const agentMessage = state.task?.messages.toReversed().find((message) => message.role === "agent");
  return {
    callId: state.call.id,
    name: state.call.name,
    result: state.error
      ? { status: "failed", error: state.error }
      : {
          task_id: state.task!.id,
          status: state.task!.status,
          output: (agentMessage?.content ?? "The delegated task finished without a text response.").slice(0, 12_000),
        },
  };
}

export async function advanceDelegations(ownerId: string, parentTask: AgentTask, result: ManagedRunResult): Promise<AgentTask> {
  const acceptedCalls = result.pendingCalls.slice(0, 3);
  const rejectedCalls: DelegationState[] = result.pendingCalls.slice(3).map((call) => ({ call, error: "Delegation limit reached: at most three temporary workers are allowed." }));
  const states = [...await Promise.all(acceptedCalls.map((call) => advanceChild(ownerId, parentTask, call))), ...rejectedCalls];
  const waiting = states.some((state) => state.task && (state.task.status === "queued" || state.task.status === "running"));
  if (waiting) return markRunStarted(ownerId, parentTask.id, result);

  const continuation = await continueManagedAgentWithFunctionResults(result.interactionId, result.environmentId ?? parentTask.environmentId, states.map(functionResult));
  return continuation.status === "completed" || continuation.status === "failed"
    ? completeRun(ownerId, parentTask.id, { ...continuation, status: continuation.status })
    : markRunStarted(ownerId, parentTask.id, continuation);
}
