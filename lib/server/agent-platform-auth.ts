import "server-only";

import { requireAgentPlatformSecret } from "@/lib/server/config";
import {
  signAgentPlatformToken,
  verifySignedAgentPlatformToken,
  type AgentPlatformIdentity,
} from "@/lib/server/agent-platform-token";

export type { AgentPlatformIdentity } from "@/lib/server/agent-platform-token";

export async function createAgentPlatformToken(identity: AgentPlatformIdentity): Promise<string> {
  return signAgentPlatformToken(identity, requireAgentPlatformSecret());
}

export async function verifyAgentPlatformToken(token: string): Promise<AgentPlatformIdentity | undefined> {
  return verifySignedAgentPlatformToken(token, requireAgentPlatformSecret());
}

export async function requireAgentPlatformIdentity(request: Request): Promise<AgentPlatformIdentity> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const identity = token ? await verifyAgentPlatformToken(token) : undefined;
  if (!identity) throw new Error("Unauthorized agent platform request");
  return identity;
}
