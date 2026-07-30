import "server-only";

import { z } from "zod";
import { continueManagedAgentWithFunctionResults, createManagedAgentDefinition, getManagedAgentRun, runManagedAgent, type DelegationCall, type FunctionResultInput, type ManagedRunResult } from "@/lib/server/gemini";
import { claimDelegatedTaskStart, completeRun, createAgent, createDelegatedTask, failRun, findAgentByName, findDelegatedTask, getAgent, listAgents, markRunStarted } from "@/lib/server/store";
import type { AgentTask } from "@/lib/types";

const sendAgentTaskInputSchema = z.object({
  agent_id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(2).max(120),
  message: z.string().trim().min(1).max(8_000),
});

const createAgentInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  specialty: z.string().trim().min(2).max(100),
  instructions: z.string().trim().min(8).max(12_000),
});

type PlatformCallState = { call: DelegationCall; task?: AgentTask; result?: Record<string, unknown>; error?: string };

function parseArguments(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

async function stableConsoleAgentId(ownerId: string, callId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ownerId}:${callId}`));
  return `console-${Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function executeRosterCall(ownerId: string, call: DelegationCall): Promise<PlatformCallState | undefined> {
  if (call.name === "list_console_agents") {
    const agents = await listAgents(ownerId);
    return { call, result: { status: "completed", agents: agents.map(({ id, name, specialty }) => ({ id, name, specialty })) } };
  }
  if (call.name !== "create_console_agent") return undefined;

  const parsed = createAgentInputSchema.safeParse(parseArguments(call.arguments));
  if (!parsed.success) return { call, error: "The persistent agent definition was invalid." };
  const existingByName = await findAgentByName(ownerId, parsed.data.name);
  if (existingByName) return { call, result: { status: "completed", created: false, agent: existingByName } };

  const id = await stableConsoleAgentId(ownerId, call.id);
  const existingById = await getAgent(ownerId, id);
  if (existingById) return { call, result: { status: "completed", created: false, agent: existingById } };

  await createManagedAgentDefinition(ownerId, id, parsed.data, { allowExisting: true });
  const agent = await createAgent(ownerId, id, parsed.data);
  return { call, result: { status: "completed", created: true, agent } };
}

async function advanceCall(ownerId: string, parentTask: AgentTask, call: DelegationCall, depth: number): Promise<PlatformCallState> {
  try {
    const rosterState = await executeRosterCall(ownerId, call);
    if (rosterState) return rosterState;
  } catch (error) {
    return { call, error: error instanceof Error ? error.message : "Console roster operation failed." };
  }

  if (call.name !== "send_agent_task") return { call, error: `Unknown function: ${call.name}` };
  const parsed = sendAgentTaskInputSchema.safeParse(parseArguments(call.arguments));
  if (!parsed.success) return { call, error: "The peer-agent task was invalid." };
  const targetAgent = await getAgent(ownerId, parsed.data.agent_id);
  if (!targetAgent) return { call, error: "The target Console agent was not found." };
  const requesterAgent = await getAgent(ownerId, parentTask.agentId);
  if (!requesterAgent) return { call, error: "The requesting Console agent was not found." };

  let child = await findDelegatedTask(ownerId, parentTask.id, parentTask.interactionId!, call.id);
  if (!child) {
    child = await createDelegatedTask(ownerId, {
      parentTaskId: parentTask.id,
      parentInteractionId: parentTask.interactionId!,
      callId: call.id,
      title: parsed.data.title,
      brief: parsed.data.message,
      agentId: targetAgent.id,
      requesterName: requesterAgent.name,
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
      const started = await runManagedAgent(parsed.data.message, undefined, undefined, child.repositoryUrl, targetAgent, {
        enablePlatformTools: true,
        maxTotalTokens: 15_000,
        ownerId,
      });
      if (started.status === "requires_action") {
        const childStarted = await markRunStarted(ownerId, child.id, started);
        child = await advanceDelegations(ownerId, childStarted, started, depth + 1);
      } else {
        child = started.status === "completed" || started.status === "failed"
          ? await completeRun(ownerId, child.id, { ...started, status: started.status })
          : await markRunStarted(ownerId, child.id, started);
      }
    } catch (error) {
      child = await failRun(ownerId, child.id, error instanceof Error ? error.message : "Unable to start delegated work.");
    }
    return { call, task: child };
  }

  if (!child.interactionId) return { call, task: child };
  if (child.status === "running" || child.status === "queued") {
    const result = await getManagedAgentRun(child.interactionId);
    child = result.status === "requires_action"
      ? await advanceDelegations(ownerId, child, result, depth + 1)
      : result.status === "completed" || result.status === "failed"
        ? await completeRun(ownerId, child.id, { ...result, status: result.status })
        : await markRunStarted(ownerId, child.id, result);
  }
  return { call, task: child };
}

function functionResult(state: PlatformCallState): FunctionResultInput {
  const agentMessage = state.task?.messages.toReversed().find((message) => message.role === "agent");
  return {
    callId: state.call.id,
    name: state.call.name,
    result: state.error
      ? { status: "failed", error: state.error }
      : state.result
        ? state.result
      : {
          task_id: state.task!.id,
          status: state.task!.status,
          output: (agentMessage?.content ?? "The peer-agent task finished without a text response.").slice(0, 12_000),
        },
  };
}

export async function advanceDelegations(ownerId: string, parentTask: AgentTask, result: ManagedRunResult, depth = 0): Promise<AgentTask> {
  if (depth >= 12) return failRun(ownerId, parentTask.id, "Agent-to-agent action limit reached.");
  const acceptedCalls = result.pendingCalls.slice(0, 3);
  const rejectedCalls: PlatformCallState[] = result.pendingCalls.slice(3).map((call) => ({ call, error: "Platform action limit reached: at most three actions are allowed per request." }));
  const states = [...await Promise.all(acceptedCalls.map((call) => advanceCall(ownerId, parentTask, call, depth))), ...rejectedCalls];
  const waiting = states.some((state) => state.task && (state.task.status === "queued" || state.task.status === "running"));
  if (waiting) return failRun(ownerId, parentTask.id, "A peer-agent task did not finish synchronously.");

  const parentAgent = await getAgent(ownerId, parentTask.agentId);
  if (!parentAgent) return failRun(ownerId, parentTask.id, "The requesting Console agent was not found.");
  const continuation = await continueManagedAgentWithFunctionResults(ownerId, parentAgent, result.interactionId, result.environmentId ?? parentTask.environmentId, states.map(functionResult));
  if (continuation.status === "requires_action") {
    const started = await markRunStarted(ownerId, parentTask.id, continuation);
    return advanceDelegations(ownerId, started, continuation, depth + 1);
  }
  return continuation.status === "completed" || continuation.status === "failed"
    ? completeRun(ownerId, parentTask.id, { ...continuation, status: continuation.status })
    : failRun(ownerId, parentTask.id, "The managed interaction did not finish synchronously.");
}
