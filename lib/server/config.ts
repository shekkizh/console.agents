import "server-only";

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY,
  agentModelId: process.env.AGENT_MODEL_ID ?? "deepseek/deepseek-v4-pro",
  consoleBaseUrl: process.env.CONSOLE_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "https://console.shekkizh.com",
  agentPlatformSecret: process.env.AGENT_PLATFORM_SECRET ?? process.env.CLERK_SECRET_KEY,
  clerkEnabled: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY),
  // Vercel Sandbox authentication. On Vercel these are provided automatically via OIDC;
  // set them explicitly for local development (`vercel env pull`).
  vercel: {
    oidcToken: process.env.VERCEL_OIDC_TOKEN,
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
  },
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return config.databaseUrl;
}

export function requireAiGatewayApiKey(): string {
  if (!config.aiGatewayApiKey) throw new Error("AI_GATEWAY_API_KEY is required to run agents through the Vercel AI Gateway");
  return config.aiGatewayApiKey;
}

export function requireAgentPlatformSecret(): string {
  if (!config.agentPlatformSecret) throw new Error("AGENT_PLATFORM_SECRET or CLERK_SECRET_KEY is required");
  return config.agentPlatformSecret;
}
