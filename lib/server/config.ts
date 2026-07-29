import "server-only";

export const config = {
  databaseUrl: process.env.DATABASE_URL,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiAgentId: process.env.GEMINI_AGENT_ID ?? "antigravity-preview-05-2026",
  consoleBaseUrl: process.env.CONSOLE_BASE_URL ?? "https://console.shekkizh.com",
  agentPlatformSecret: process.env.AGENT_PLATFORM_SECRET ?? process.env.CLERK_SECRET_KEY,
  clerkEnabled: Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY),
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  return config.databaseUrl;
}

export function requireGeminiApiKey(): string {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY is required");
  return config.geminiApiKey;
}

export function requireAgentPlatformSecret(): string {
  if (!config.agentPlatformSecret) throw new Error("AGENT_PLATFORM_SECRET or CLERK_SECRET_KEY is required");
  return config.agentPlatformSecret;
}
