import { z } from "zod";

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Use an environment variable name");
const serverName = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/, "Use letters, numbers, _ or -");
const networkDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use a domain such as example.com or *.example.com",
  );

export const fxNetworkAccessSchema = z.enum(["full", "none", "allowlist"]);
export const fxNetworkAllowlistSchema = z
  .array(networkDomain)
  .max(64)
  .transform((domains) => [...new Set(domains)]);

export const fxSkillSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "Skill names use lowercase letters, numbers and hyphens"),
  description: z.string().trim().min(3).max(240),
  instructions: z.string().trim().min(8).max(20_000),
});

const sharedMcpFields = {
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
};

const remoteMcpSchema = z.object({
  ...sharedMcpFields,
  type: z.enum(["http", "sse"]),
  url: z.string().url().refine((value) => value.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(value), "Use HTTPS or an explicit loopback URL"),
  headers: z.record(z.string().min(1), z.string()).optional(),
  headerEnv: z.record(z.string().min(1), envName).optional(),
  bearerTokenEnv: envName.optional(),
});

const localMcpSchema = z.object({
  ...sharedMcpFields,
  type: z.enum(["local", "stdio"]),
  command: z.array(z.string().min(1).max(1_000)).min(1).max(64),
  environment: z.record(envName, z.string().max(10_000)).optional(),
});

export const fxMcpServerSchema = z.union([remoteMcpSchema, localMcpSchema]);
export const fxSkillsSchema = z.array(fxSkillSchema).max(32);
export const fxMcpServersSchema = z.record(serverName, fxMcpServerSchema).refine(
  (servers) => Object.keys(servers).length <= 32,
  "At most 32 MCP servers are allowed",
);

export const optionalFxCapabilitiesSchema = {
  skills: fxSkillsSchema.optional(),
  mcpServers: fxMcpServersSchema.optional(),
};

export const optionalFxNetworkSchema = {
  networkAccess: fxNetworkAccessSchema.optional(),
  networkAllowlist: fxNetworkAllowlistSchema.optional(),
};
