import "server-only";

import { createAgentPlatformToken } from "@/lib/server/agent-platform-auth";
import { buildManagedEnvironment } from "@/lib/server/agent-environment-config";
import { config } from "@/lib/server/config";
import type { AgentProfile } from "@/lib/types";

export async function managedEnvironment(ownerId: string, agent: Pick<AgentProfile, "id" | "name" | "specialty" | "instructions">, environmentId?: string, repositoryUrl?: string) {
  const token = await createAgentPlatformToken({ ownerId, agentId: agent.id });
  return buildManagedEnvironment(agent, token, config.consoleBaseUrl, environmentId, repositoryUrl);
}
