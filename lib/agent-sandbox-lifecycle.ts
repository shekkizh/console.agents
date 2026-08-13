export const AGENT_COMMAND_TIMEOUT_MS = 7 * 60 * 1000;
export const SANDBOX_SESSION_TIMEOUT_MS = 12 * 60 * 1000;
export const AGENT_SANDBOX_LEASE_MS = 14 * 60 * 1000;

export class AgentSandboxBusyError extends Error {
  readonly code = "AGENT_SANDBOX_BUSY";

  constructor() {
    super("Agent sandbox is already processing another turn");
    this.name = "AgentSandboxBusyError";
  }
}

export function isAgentSandboxBusyError(error: unknown): error is AgentSandboxBusyError {
  return error instanceof AgentSandboxBusyError
    || (typeof error === "object" && error !== null && "code" in error && error.code === "AGENT_SANDBOX_BUSY");
}

export function agentRunInputPath(runId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error("Invalid agent run ID");
  return `/vercel/sandbox/runtime/task-input-${runId}.json`;
}
