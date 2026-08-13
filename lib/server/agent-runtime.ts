import "server-only";

import { createAgentPlatformToken } from "@/lib/server/agent-platform-auth";
import { runAgentInSandbox } from "@/lib/server/agent-sandbox";
import type { AgentProfile, RunStep, StepKind } from "@/lib/types";

export interface AgentRunResult {
  output: string;
  status: "completed" | "failed";
  steps: RunStep[];
}

const platformInstruction =
  "You are a peer in a persistent multi-agent Console. Coordinate with other agents using send_channel_message, inspect or change the roster with list_console_agents and create_console_agent, and evolve your own profile with update_self. A sandbox file or process is not a Console agent. Writing a file with write_file does not share it with the channel - call share_artifact on a finished file to publish it to the Shared files panel, and only for file types that panel can render (Markdown, text/code, JSON, CSV/TSV, or PNG/JPG/GIF/WEBP/SVG images); anything else, describe in your message instead.";

const stepKinds: ReadonlySet<StepKind> = new Set(["plan", "search", "code", "file", "result"]);

function normalizeSteps(steps: Array<{ kind: string; label: string; detail?: string }>): RunStep[] {
  return steps.slice(0, 24).map((step) => ({
    id: `step-${crypto.randomUUID()}`,
    kind: stepKinds.has(step.kind as StepKind) ? (step.kind as StepKind) : "result",
    label: (step.label || "Execution step").slice(0, 80),
    detail: step.detail ? step.detail.slice(0, 240) : undefined,
    createdAt: new Date().toISOString(),
  }));
}

/**
 * Run one agent turn on the Vercel AI Gateway inside the agent's persistent Vercel Sandbox.
 * Replaces the former Gemini managed-agent runtime; tool execution happens in the sandbox.
 */
export async function runAgentTurn(input: {
  ownerId: string;
  agent: AgentProfile;
  channelId?: string;
  systemInstructions: string;
  prompt: string;
  maxSteps?: number;
}): Promise<AgentRunResult> {
  const token = await createAgentPlatformToken({ ownerId: input.ownerId, agentId: input.agent.id });
  const result = await runAgentInSandbox({
    ownerId: input.ownerId,
    agent: {
      id: input.agent.id,
      name: input.agent.name,
      specialty: input.agent.specialty,
      instructions: input.agent.instructions,
    },
    channelId: input.channelId,
    token,
    instructions: `${input.systemInstructions} ${platformInstruction}`,
    prompt: input.prompt,
    maxSteps: input.maxSteps,
  });

  const steps = normalizeSteps(result.steps);
  if (result.error) {
    return {
      status: "failed",
      output: result.output || `The agent run failed: ${result.error}`,
      steps,
    };
  }
  return {
    status: "completed",
    output: result.output || "Done.",
    steps,
  };
}
