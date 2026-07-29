import "server-only";

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
  status: "completed" | "running" | "failed";
  steps: RunStep[];
  environmentId?: string;
}

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

export async function runManagedAgent(input: string, previousInteractionId?: string, environmentId?: string, repositoryUrl?: string, agent?: AgentProfile): Promise<ManagedRunResult> {
  const geminiApiKey = requireGeminiApiKey();
  const agentInput = agent
    ? `You are ${agent.name}, a ${agent.specialty}. Follow these standing instructions:\n${agent.instructions}\n\nUser request:\n${input}`
    : input;

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
      "Api-Revision": "2026-05-20",
    },
    body: JSON.stringify({
      agent: config.geminiAgentId,
      input: agentInput,
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
      agent_config: { type: "antigravity", max_total_tokens: 50_000 },
      ...(previousInteractionId ? { previous_interaction_id: previousInteractionId } : {}),
    }),
    signal: AbortSignal.timeout(280_000),
  });

  const payload = (await response.json()) as GeminiInteraction;
  if (!response.ok) {
    throw new Error(payload.error?.message ?? `Gemini request failed (${response.status})`);
  }

  return {
    interactionId: payload.id ?? crypto.randomUUID(),
    output: payload.output_text ?? "The managed run finished without a text response.",
    status: payload.status === "failed" ? "failed" : payload.status === "completed" ? "completed" : "running",
    steps: normalizeSteps(payload),
    environmentId: payload.environment_id,
  };
}

export async function getManagedAgentRun(interactionId: string): Promise<ManagedRunResult> {
  const geminiApiKey = requireGeminiApiKey();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(interactionId)}`, {
    headers: { "x-goog-api-key": geminiApiKey },
    cache: "no-store",
  });
  const payload = (await response.json()) as GeminiInteraction;
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini poll failed (${response.status})`);
  const status = payload.status === "completed" || payload.status === "incomplete"
    ? "completed"
    : payload.status === "failed" || payload.status === "cancelled"
      ? "failed"
      : "running";
  return {
    interactionId: payload.id ?? interactionId,
    output: payload.output_text ?? "",
    status,
    steps: normalizeSteps(payload),
    environmentId: payload.environment_id,
  };
}
