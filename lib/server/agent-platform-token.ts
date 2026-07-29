export interface AgentPlatformIdentity {
  ownerId: string;
  agentId: string;
}

interface AgentPlatformClaims extends AgentPlatformIdentity {
  version: 1;
  expiresAt: number;
}

const encoder = new TextEncoder();

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function signingKey(secret: string) {
  if (!secret) throw new Error("Agent platform signing secret is required");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signAgentPlatformToken(
  identity: AgentPlatformIdentity,
  secret: string,
  expiresAt = Date.now() + 6 * 60 * 60 * 1_000,
): Promise<string> {
  const claims: AgentPlatformClaims = { version: 1, ...identity, expiresAt };
  const payload = encode(JSON.stringify(claims));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

export async function verifySignedAgentPlatformToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<AgentPlatformIdentity | undefined> {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return undefined;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      Buffer.from(signature, "base64url"),
      encoder.encode(payload),
    );
  } catch {
    return undefined;
  }
  if (!valid) return undefined;

  try {
    const claims = JSON.parse(decode(payload)) as Partial<AgentPlatformClaims>;
    if (claims.version !== 1 || typeof claims.ownerId !== "string" || typeof claims.agentId !== "string") return undefined;
    if (typeof claims.expiresAt !== "number" || claims.expiresAt <= now) return undefined;
    return { ownerId: claims.ownerId, agentId: claims.agentId };
  } catch {
    return undefined;
  }
}
