import "server-only";

import { agentPlatformTools, toFunctionResultStep } from "@/lib/server/agent-tools";
import { config, requireGeminiApiKey } from "@/lib/server/config";
import { managedEnvironment } from "@/lib/server/console-platform-skill";
import { interactionOutputText, stepText, type GeminiInteractionPayload } from "@/lib/server/gemini-response";
import type { AgentProfile, RunStep } from "@/lib/types";

export interface ManagedRunResult {
  interactionId: string;
  output: string;
  status: "completed" | "running" | "requires_action" | "failed";
  steps: RunStep[];
  environmentId?: string;
  pendingCalls: DelegationCall[];
}

export interface DelegationCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface FunctionResultInput {
  callId: string;
  name: string;
  result: Record<string, unknown>;
}

const platformInstruction = "You are a peer in a persistent multi-agent Console. You can list agents, create agents, and send tasks or messages to other agents with the provided Console platform tools. A sandbox file or process is not a Console agent.";

function normalizeSteps(payload: GeminiInteractionPayload): RunStep[] {
  const rawSteps = payload.steps ?? payload.outputs ?? [];
  return rawSteps.slice(0, 12).map((step, index) => {
    const type = String(step.type ?? "result");
    const kind: RunStep["kind"] = type.includes("search")
      ? "search"
      : type.includes("code")
        ? "code"
        : type.includes("file")
          ? "file"
          : index === 0
            ? "plan"
            : "result";

    return {
      id: `step-${index}-${crypto.randomUUID()}`,
      kind,
      label: String(step.title ?? step.name ?? step.type ?? "Execution step").replaceAll("_", " "),
      detail: stepText(step).slice(0, 240) || undefined,
      createdAt: new Date().toISOString(),
    };
  });
}

function pendingFunctionCalls(payload: GeminiInteractionPayload): DelegationCall[] {
  const rawSteps = payload.steps ?? [];
  const executed = new Set(rawSteps.filter((step) => step.type === "function_result").map((step) => String(step.call_id ?? "")));
  return rawSteps
    .filter((step) => step.type === "function_call" && !executed.has(String(step.id ?? "")))
    .map((step) => ({ id: String(step.id ?? ""), name: String(step.name ?? ""), arguments: step.arguments }));
}

function normalizeResult(payload: GeminiInteractionPayload, fallbackInteractionId?: string): ManagedRunResult {
  const status = payload.status === "completed"
    ? "completed"
    : payload.status === "failed" || payload.status === "cancelled" || payload.status === "incomplete"
      ? "failed"
      : payload.status === "requires_action"
        ? "requires_action"
        : "running";
  return {
    interactionId: payload.id ?? fallbackInteractionId ?? crypto.randomUUID(),
    output: interactionOutputText(payload) || (status === "completed"
      ? "The managed run finished without a text response."
      : payload.status === "incomplete"
        ? "The managed run ended before producing a response."
        : ""),
    status,
    steps: normalizeSteps(payload),
    environmentId: payload.environment_id,
    pendingCalls: pendingFunctionCalls(payload),
  };
}

async function postInteraction(body: Record<string, unknown>): Promise<ManagedRunResult> {
  const geminiApiKey = requireGeminiApiKey();
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
      "Api-Revision": "2026-05-20",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(280_000),
  });
  const payload = (await response.json()) as GeminiInteractionPayload;
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini request failed (${response.status})`);
  return normalizeResult(payload);
}

export async function runManagedAgent(input: string, previousInteractionId?: string, environmentId?: string, repositoryUrl?: string, agent?: AgentProfile, options?: {
  enablePlatformTools?: boolean;
  maxTotalTokens?: number;
  ownerId?: string;
}): Promise<ManagedRunResult> {
  const enablePlatformTools = Boolean(options?.enablePlatformTools && agent);
  const isSavedManagedAgent = Boolean(agent && !agent.builtIn && agent.id.startsWith("console-"));
  const targetAgentId = isSavedManagedAgent ? agent!.id : config.geminiAgentId;
  const acceptsAgentConfig = targetAgentId.startsWith("antigravity-");
  const environment = options?.ownerId && agent
    ? await managedEnvironment(options.ownerId, agent, environmentId, repositoryUrl)
    : environmentId ?? (repositoryUrl ? {
        type: "remote",
        sources: [{ type: "repository", source: repositoryUrl, target: "/workspace/repository" }],
      } : "remote");
  return postInteraction({
    agent: targetAgentId,
    input,
    system_instruction: agent ? `You are ${agent.name}, a ${agent.specialty}. ${agent.instructions} ${platformInstruction}` : undefined,
    environment,
    store: true,
    ...(acceptsAgentConfig ? { agent_config: { type: "antigravity", max_total_tokens: options?.maxTotalTokens ?? 50_000 } } : {}),
    ...(enablePlatformTools ? { tools: [{ type: "code_execution" }, { type: "google_search" }, { type: "url_context" }, ...agentPlatformTools] } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
  });
}

export async function continueManagedAgentWithFunctionResults(ownerId: string, agent: AgentProfile, previousInteractionId: string, environmentId: string | undefined, results: FunctionResultInput[]): Promise<ManagedRunResult> {
  const isSavedManagedAgent = !agent.builtIn && agent.id.startsWith("console-");
  const targetAgentId = isSavedManagedAgent ? agent.id : config.geminiAgentId;
  const acceptsAgentConfig = targetAgentId.startsWith("antigravity-");
  return postInteraction({
    agent: targetAgentId,
    previous_interaction_id: previousInteractionId,
    environment: await managedEnvironment(ownerId, agent, environmentId),
    input: results.map(toFunctionResultStep),
    system_instruction: `You are ${agent.name}, a ${agent.specialty}. ${agent.instructions} ${platformInstruction}`,
    store: true,
    tools: [{ type: "code_execution" }, { type: "google_search" }, { type: "url_context" }, ...agentPlatformTools],
    ...(acceptsAgentConfig ? { agent_config: { type: "antigravity", max_total_tokens: 50_000 } } : {}),
  });
}

export async function createManagedAgentDefinition(ownerId: string, id: string, agent: Pick<AgentProfile, "name" | "specialty" | "instructions">, options?: { allowExisting?: boolean }): Promise<void> {
  const geminiApiKey = requireGeminiApiKey();
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/agents", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      id,
      description: agent.specialty,
      base_agent: "antigravity-preview-05-2026",
      agent_config: { type: "antigravity" },
      system_instruction: `You are ${agent.name}, a ${agent.specialty}. ${agent.instructions}`,
      base_environment: await managedEnvironment(ownerId, { id, ...agent }),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = (await response.json()) as GeminiInteractionPayload;
  if (!response.ok && !(options?.allowExisting && response.status === 409)) {
    throw new Error(payload.error?.message ?? `Gemini agent creation failed (${response.status})`);
  }
}

export async function getManagedAgentRun(interactionId: string): Promise<ManagedRunResult> {
  const geminiApiKey = requireGeminiApiKey();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}`, {
    headers: { "x-goog-api-key": geminiApiKey, "Api-Revision": "2026-05-20" },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload: GeminiInteractionPayload;
  try {
    payload = JSON.parse(text) as GeminiInteractionPayload;
  } catch {
    throw new Error(`Gemini poll returned an invalid response (${response.status})`);
  }
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini poll failed (${response.status})`);
  return normalizeResult(payload, interactionId);
}
