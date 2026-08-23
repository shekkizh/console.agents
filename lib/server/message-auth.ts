import { createHmac, timingSafeEqual } from "node:crypto";
import { requireConsoleInternalSecret } from "@/lib/server/config";

export interface MessageWakeClaims {
  ownerId: string;
  targetAgentId: string;
  conversationId: string;
  messageId: string;
  fromAgentId: string;
  expiresAt: number;
}

export interface AgentMessageClaims {
  ownerId: string;
  agentId: string;
  conversationId: string;
  incomingMessageId?: string;
  incomingFromAgentId?: string;
  expiresAt: number;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string): Buffer {
  return createHmac("sha256", requireConsoleInternalSecret()).update(payload).digest();
}

function signedToken(kind: "wake" | "agent", claims: object): string {
  const payload = encode(JSON.stringify({ kind, ...claims }));
  return `${payload}.${signature(payload).toString("base64url")}`;
}

function verifiedPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return;
  const [payload, provided] = parts as [string, string];
  let providedBytes: Buffer;
  try {
    providedBytes = Buffer.from(provided, "base64url");
  } catch {
    return;
  }
  const expected = signature(payload);
  if (providedBytes.byteLength !== expected.byteLength || !timingSafeEqual(providedBytes, expected)) {
    return;
  }
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  } catch {
    return;
  }
}

export function createMessageWakeToken(
  input: Omit<MessageWakeClaims, "expiresAt">,
  now = Date.now(),
): string {
  return signedToken("wake", { ...input, expiresAt: now + 5 * 60_000 });
}

export function verifyMessageWakeToken(
  token: string,
  now = Date.now(),
): MessageWakeClaims | undefined {
  const value = verifiedPayload(token);
  if (!value || value.kind !== "wake") return;
  const claims = value as unknown as MessageWakeClaims;
  if (
    typeof claims.ownerId !== "string" || !claims.ownerId ||
    typeof claims.targetAgentId !== "string" || !claims.targetAgentId ||
    typeof claims.conversationId !== "string" || !claims.conversationId ||
    typeof claims.messageId !== "string" || !claims.messageId ||
    typeof claims.fromAgentId !== "string" || !claims.fromAgentId ||
    !Number.isFinite(claims.expiresAt) || claims.expiresAt <= now
  ) return;
  return {
    ownerId: claims.ownerId,
    targetAgentId: claims.targetAgentId,
    conversationId: claims.conversationId,
    messageId: claims.messageId,
    fromAgentId: claims.fromAgentId,
    expiresAt: claims.expiresAt,
  };
}

export function createAgentMessageToken(
  input: Omit<AgentMessageClaims, "expiresAt">,
  now = Date.now(),
): string {
  return signedToken("agent", { ...input, expiresAt: now + 2 * 60 * 60_000 });
}

export function verifyAgentMessageToken(
  token: string,
  now = Date.now(),
): AgentMessageClaims | undefined {
  const value = verifiedPayload(token);
  if (!value || value.kind !== "agent") return;
  const claims = value as unknown as AgentMessageClaims;
  if (
    typeof claims.ownerId !== "string" || !claims.ownerId ||
    typeof claims.agentId !== "string" || !claims.agentId ||
    typeof claims.conversationId !== "string" || !claims.conversationId ||
    (claims.incomingMessageId !== undefined &&
      (typeof claims.incomingMessageId !== "string" || !claims.incomingMessageId)) ||
    (claims.incomingFromAgentId !== undefined &&
      (typeof claims.incomingFromAgentId !== "string" || !claims.incomingFromAgentId)) ||
    !Number.isFinite(claims.expiresAt) || claims.expiresAt <= now
  ) return;
  return {
    ownerId: claims.ownerId,
    agentId: claims.agentId,
    conversationId: claims.conversationId,
    incomingMessageId: claims.incomingMessageId,
    incomingFromAgentId: claims.incomingFromAgentId,
    expiresAt: claims.expiresAt,
  };
}

