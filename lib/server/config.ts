const DEFAULT_FX_MODEL = "zai/glm-5.2";
const e2eTestMode = process.env.NODE_ENV !== "production" && process.env.E2E_TEST_MODE === "1";

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  databaseUrlUnpooled: process.env.DATABASE_URL_UNPOOLED,
  databaseName: process.env.DATABASE_NAME,
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
  consoleInternalUrl: process.env.CONSOLE_INTERNAL_URL,
  consoleInternalSecret: process.env.CONSOLE_INTERNAL_SECRET,
  consoleAgentApiUrl: process.env.CONSOLE_AGENT_API_URL,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
  clerkEnabled: Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  ),
  defaultFxModel: process.env.FX_MODEL ?? DEFAULT_FX_MODEL,
  fxVersion: process.env.FX_VERSION ?? "v0.0.4",
  e2eTestMode,
  e2eFakeFx: e2eTestMode && process.env.E2E_FAKE_FX === "1",
  e2eTestOwnerId: e2eTestMode ? process.env.E2E_TEST_OWNER_ID : undefined,
  e2eTestToken: e2eTestMode ? process.env.E2E_TEST_TOKEN : undefined,
} as const;

export function databaseUrl(
  source = config.databaseUrl,
  databaseName = config.databaseName,
): string | undefined {
  if (!source || !databaseName) return source;
  if (!/^[A-Za-z0-9_-]+$/.test(databaseName)) {
    throw new Error("DATABASE_NAME contains unsupported characters");
  }
  const url = new URL(source);
  url.pathname = "/" + databaseName;
  return url.toString();
}

export function requireDatabaseUrl(): string {
  const resolved = databaseUrl();
  if (!resolved) throw new Error("DATABASE_URL is required");
  return resolved;
}

export function requireDatabaseListenerUrl(): string {
  const resolved = databaseUrl(config.databaseUrlUnpooled ?? config.databaseUrl, config.databaseName);
  if (!resolved) throw new Error("DATABASE_URL is required");
  const url = new URL(resolved);
  if (url.hostname.endsWith(".neon.tech")) {
    url.hostname = url.hostname.replace("-pooler.", ".");
  }
  return url.toString();
}

export function requireClerkSecretKey(): string {
  if (!config.clerkSecretKey) throw new Error("CLERK_SECRET_KEY is required");
  return config.clerkSecretKey;
}

export function requireAiGatewayApiKey(): string {
  if (!config.aiGatewayApiKey) throw new Error("AI_GATEWAY_API_KEY is required");
  return config.aiGatewayApiKey;
}

export function requireConsoleInternalSecret(): string {
  const developmentFallback = process.env.NODE_ENV === "production"
    ? undefined
    : config.clerkSecretKey ?? config.e2eTestToken;
  const secret = config.consoleInternalSecret ?? developmentFallback;
  if (!secret) throw new Error("CONSOLE_INTERNAL_SECRET is required");
  return secret;
}

export function consoleInternalUrl(): string {
  if (config.consoleInternalUrl) return config.consoleInternalUrl.replace(/\/$/, "");
  if (config.e2eTestMode) {
    return `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NODE_ENV === "development") {
    return `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
  }
  const publicUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  throw new Error("CONSOLE_INTERNAL_URL or NEXT_PUBLIC_APP_URL is required");
}

export function consoleAgentApiUrl(): string {
  if (config.consoleAgentApiUrl) return config.consoleAgentApiUrl.replace(/\/$/, "");
  if (process.env.NODE_ENV === "development") {
    return "http://host.microsandbox.internal:3000/api/a2a";
  }
  return `${consoleInternalUrl()}/api/a2a`;
}

export function consoleAgentApiHost(): string {
  const hostname = new URL(consoleAgentApiUrl()).hostname;
  if (!hostname) throw new Error("CONSOLE_AGENT_API_URL is invalid");
  return hostname;
}

export function requireE2ETestIdentity(): { ownerId: string; token: string } {
  if (!config.e2eTestMode || !config.e2eTestOwnerId || !config.e2eTestToken) {
    throw new Error("E2E test identity is not configured");
  }
  return { ownerId: config.e2eTestOwnerId, token: config.e2eTestToken };
}
