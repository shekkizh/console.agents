const DEFAULT_FX_MODEL = "zai/glm-5.2";
const e2eTestMode = process.env.NODE_ENV !== "production" && process.env.E2E_TEST_MODE === "1";

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
  clerkSecretKey: process.env.CLERK_SECRET_KEY,
  clerkEnabled: Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  ),
  eveModelId: process.env.EVE_MODEL_ID ?? DEFAULT_FX_MODEL,
  defaultFxModel: process.env.FX_MODEL ?? DEFAULT_FX_MODEL,
  fxVersion: process.env.FX_VERSION ?? "v0.0.4",
  e2eTestMode,
  e2eFakeFx: e2eTestMode && process.env.E2E_FAKE_FX === "1",
  e2eTestOwnerId: e2eTestMode ? process.env.E2E_TEST_OWNER_ID : undefined,
  e2eTestToken: e2eTestMode ? process.env.E2E_TEST_TOKEN : undefined,
} as const;

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return config.databaseUrl;
}

export function requireClerkSecretKey(): string {
  if (!config.clerkSecretKey) throw new Error("CLERK_SECRET_KEY is required");
  return config.clerkSecretKey;
}

export function requireAiGatewayApiKey(): string {
  if (!config.aiGatewayApiKey) throw new Error("AI_GATEWAY_API_KEY is required");
  return config.aiGatewayApiKey;
}

export function requireE2ETestIdentity(): { ownerId: string; token: string } {
  if (!config.e2eTestMode || !config.e2eTestOwnerId || !config.e2eTestToken) {
    throw new Error("E2E test identity is not configured");
  }
  return { ownerId: config.e2eTestOwnerId, token: config.e2eTestToken };
}
