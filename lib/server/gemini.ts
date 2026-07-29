import "server-only";

import { GENERAL_AGENT_ID } from "@/lib/general-agent";
import { config, requireGeminiApiKey } from "@/lib/server/config";
import type { AgentProfile, RunStep } from "@/lib/types";

interface GeminiInteraction {
  id?: string;
  status?: string;
  output_text?: string;
  outputs?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
  error?: { message?: string };
  environment_id?: string;
}

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

const delegateTaskTool = {
  type: "function",
  name: "delegate_task",
  description: "Delegate one narrow, independent subtask to a temporary worker. Use only when delegation materially improves speed or quality. At most three calls are allowed for a user request.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short, specific label for the delegated work." },
      brief: { type: "string", description: "A self-contained brief with the outcome, context, constraints, and expected return format." },
    },
    required: ["title", "brief"],
  },
};

function normalizeSteps(payload: GeminiInteraction): RunStep[] {
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
      detail: typeof step.text === "string" ? step.text.slice(0, 240) : undefined,
      createdAt: new Date().toISOString(),
    };
  });
}

function pendingFunctionCalls(payload: GeminiInteraction): DelegationCall[] {
  const rawSteps = payload.steps ?? [];
  const executed = new Set(rawSteps.filter((step) => step.type === "function_result").map((step) => String(step.call_id ?? "")));
  return rawSteps
    .filter((step) => step.type === "function_call" && !executed.has(String(step.id ?? "")))
    .map((step) => ({ id: String(step.id ?? ""), name: String(step.name ?? ""), arguments: step.arguments }));
}

function normalizeResult(payload: GeminiInteraction, fallbackInteractionId?: string): ManagedRunResult {
  const status = payload.status === "completed" || payload.status === "incomplete"
    ? "completed"
    : payload.status === "failed" || payload.status === "cancelled"
      ? "failed"
      : payload.status === "requires_action"
        ? "requires_action"
        : "running";
  return {
    interactionId: payload.id ?? fallbackInteractionId ?? crypto.randomUUID(),
    output: payload.output_text ?? (status === "completed" ? "The managed run finished without a text response." : ""),
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
  const payload = (await response.json()) as GeminiInteraction;
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini request failed (${response.status})`);
  return normalizeResult(payload);
}

export async function runManagedAgent(input: string, previousInteractionId?: string, environmentId?: string, repositoryUrl?: string, agent?: AgentProfile, options?: {
  allowDelegation?: boolean;
  maxTotalTokens?: number;
}): Promise<ManagedRunResult> {
  const allowDelegation = Boolean(options?.allowDelegation && agent?.id === GENERAL_AGENT_ID);
  return postInteraction({
    agent: config.geminiAgentId,
    input,
    system_instruction: agent ? `You are ${agent.name}, a ${agent.specialty}. ${agent.instructions}` : undefined,
    environment: environmentId ?? (repositoryUrl ? {
        type: "remote",
        sources: [{
          type: "repository",
          source: repositoryUrl,
          target: "/workspace/repository",
        }],
      } : "remote"),
    background: true,
    store: true,
    agent_config: { type: "antigravity", max_total_tokens: options?.maxTotalTokens ?? 50_000 },
    ...(allowDelegation ? { tools: [{ type: "code_execution" }, { type: "google_search" }, { type: "url_context" }, delegateTaskTool] } : {}),
    ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
  });
}

export async function continueManagedAgentWithFunctionResults(previousInteractionId: string, environmentId: string | undefined, results: FunctionResultInput[]): Promise<ManagedRunResult> {
  return postInteraction({
    agent: config.geminiAgentId,
    previous_interaction_id: previousInteractionId,
    environment: environmentId ?? "remote",
    input: results.map((item) => ({ type: "function_result", name: item.name, call_id: item.callId, result: item.result })),
    background: true,
    store: true,
    tools: [{ type: "code_execution" }, { type: "google_search" }, { type: "url_context" }],
    agent_config: { type: "antigravity", max_total_tokens: 50_000 },
  });
}

export async function getManagedAgentRun(interactionId: string): Promise<ManagedRunResult> {
  const geminiApiKey = requireGeminiApiKey();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}`, {
    headers: { "x-goog-api-key": geminiApiKey },
    cache: "no-store",
  });
  const payload = (await response.json()) as GeminiInteraction;
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini poll failed (${response.status})`);
  return normalizeResult(payload, interactionId);
}
