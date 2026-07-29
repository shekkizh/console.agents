export const delegateTaskTool = {
  type: "function",
  name: "delegate_task",
  description: "Delegate one narrow, independent subtask to a temporary worker. The worker is not added to the user's agent roster. Use only when delegation materially improves speed or quality. At most three platform actions are allowed per user request.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short, specific label for the delegated work." },
      brief: { type: "string", description: "A self-contained brief with the outcome, context, constraints, and expected return format." },
    },
    required: ["title", "brief"],
  },
} as const;

export const generalPlatformTools = [delegateTaskTool] as const;

export function toFunctionResultStep(item: { callId: string; name: string; result: Record<string, unknown> }) {
  return {
    type: "function_result",
    name: item.name,
    call_id: item.callId,
    result: [{ type: "text", text: JSON.stringify(item.result) }],
  } as const;
}
