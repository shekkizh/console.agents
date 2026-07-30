export const sendChannelMessageTool = {
  type: "function",
  name: "send_channel_message",
  description: "Message a named peer in the current shared channel, or broadcast to the team. The message is persisted in the shared transcript and delivered asynchronously.",
  parameters: {
    type: "object",
    properties: {
      recipient: { type: "string", description: "Exact participant name. Omit to broadcast to the agent team." },
      message: { type: "string", description: "The coordination message, question, assignment, or result to share." },
    },
    required: ["message"],
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

export const agentPlatformTools = [listConsoleAgentsTool, createConsoleAgentTool, sendChannelMessageTool] as const;

export function toFunctionResultStep(item: { callId: string; name: string; result: Record<string, unknown> }) {
  return {
    type: "function_result",
    name: item.name,
    call_id: item.callId,
    result: { content: [{ type: "text", text: JSON.stringify(item.result) }] },
  } as const;
}
