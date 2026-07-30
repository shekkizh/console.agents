export const sendAgentTaskTool = {
  type: "function",
  name: "send_agent_task",
  description: "Send a message or task to another persistent Console agent and wait for its result. Use list_console_agents first when you do not know the target agent ID.",
  parameters: {
    type: "object",
    properties: {
      agent_id: { type: "string", description: "The exact Console agent ID that should receive the task." },
      title: { type: "string", description: "A short, specific label for the delegated work." },
      message: { type: "string", description: "A self-contained message with the outcome, context, constraints, and expected return format." },
    },
    required: ["agent_id", "title", "message"],
  },
} as const;

export const listConsoleAgentsTool = {
  type: "function",
  name: "list_console_agents",
  description: "List the persistent agents in the user's Console roster. Use this to verify roster changes instead of inferring them from sandbox files.",
  parameters: { type: "object", properties: {} },
} as const;

export const createConsoleAgentTool = {
  type: "function",
  name: "create_console_agent",
  description: "Create a persistent managed agent in the user's Console roster. This is the only way to fulfill a request for a reusable Console agent; creating sandbox files is not sufficient.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "A concise display name for the agent." },
      specialty: { type: "string", description: "A short description of the agent's role." },
      instructions: { type: "string", description: "Detailed durable operating instructions for the agent." },
    },
    required: ["name", "specialty", "instructions"],
  },
} as const;

export const agentPlatformTools = [listConsoleAgentsTool, createConsoleAgentTool, sendAgentTaskTool] as const;

export function toFunctionResultStep(item: { callId: string; name: string; result: Record<string, unknown> }) {
  return {
    type: "function_result",
    name: item.name,
    call_id: item.callId,
    result: { content: [{ type: "text", text: JSON.stringify(item.result) }] },
  } as const;
}
