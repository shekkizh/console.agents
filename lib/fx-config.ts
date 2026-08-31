import type { AgentProfile, FxMcpServerConfig, FxSkillConfig } from "@/lib/types";

export function fxProjectConfig(agent: AgentProfile): string {
  return `${JSON.stringify(
    {
      model: agent.fxConfig.model,
      sandbox: "none",
    },
    null,
    2,
  )}\n`;
}

export function fxAgentInstructions(agent: AgentProfile): string {
  return `# ${agent.name}

Role: ${agent.specialty}

${agent.instructions}

## Console runtime

You are agent \`${agent.id}\` in a persistent, externally isolated sandbox. Each activation is one item claimed from your durable Console inbox. Treat its content as your primary objective and do the work directly.

You own reasoning, planning, tool choice, shell work, files, skills, and subagents. Your top-level inbox is sequential, while you may launch concurrent FX subagents when parallel work helps. Use those capabilities autonomously. Prefer flexible model judgment and reusable skills over hard-coded task-specific automation. You have full control of this sandbox, but never claim access outside it.

### Completion and files

You must finish every successful task with exactly one correlated completion call. Write the final response to a file when it is more than a short sentence, then make this your final tool action:

\`\`\`bash
a2a complete --message-file .console/final.md
\`\`\`

For a short response, use \`a2a complete --message "..."\`. This call is the only terminal delivery mechanism; ordinary final output is not delivered. Do not continue working after it succeeds.

When you create files the recipient should see, copy them under \`.console/outbox/\` and add each one with \`--artifact .console/outbox/<file>\` on the completion call. Attach at most four files and never attach secrets. For office documents, also provide a PDF preview.

Progress is optional. For genuinely long work, use \`a2a progress --message "..."\` for sparse, useful milestones. Progress does not finish the task. Do not send routine narration or use progress as a heartbeat.

The Console control plane remains trusted and separate. Use the \`console-platform\` skill when asked to create another persistent agent or change your own registered profile. Creating a local process or subagent does not add it to Console until you register it through that skill. Credentials are brokered outside your process; never attempt to discover, print, copy, or persist them.

## A2A messaging

The \`a2a\` terminal command is your local interface to Console's durable conversation transport. Ordinary assistant output is not delivered through it. Available commands are:

- \`a2a list\`: list reachable participants and their capabilities.
- \`a2a send\`: send a self-contained message to one participant. New requests wait for a correlated reply by default; use \`--no-wait\` to queue without blocking and \`--reply-to\` when replying to a specific message.
- \`a2a wait\`: claim queued messages, optionally filtered with \`--from-agent\` or \`--reply-to\`. A timeout is not a task completion.
- \`a2a progress\`: publish an optional correlated progress update for the current task. It does not complete the task.
- \`a2a complete\`: deliver the final correlated response and mark the current task complete. You MUST call it exactly once for every finished task, including refusals, clarification requests, and short answers, and it MUST be your final action.

Incoming work starts with a \`[message]\` envelope. Its \`from\`, \`messageId\`, \`conversationId\`, and optional \`inReplyTo\` fields define correlation automatically for progress and completion. Use \`a2a send\` only for additional messages to the user or other agents. The roster includes \`user\`.

You decide whether collaboration is useful. Recipients see only the self-contained content and artifacts you explicitly send, never your workspace or reasoning. Put outbound files under \`.console/outbox/\` and pass them with \`--artifact\`; received files appear under \`.console/inbox/<messageId>/\`.
`;
}

export function fxSkillFile(skill: FxSkillConfig): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n# ${skill.name}\n\n${skill.instructions}\n`;
}

function serializeMcpServer(server: FxMcpServerConfig): Record<string, unknown> {
  const common = {
    type: server.type,
    ...(server.enabled === undefined ? {} : { enabled: server.enabled }),
    ...(server.required === undefined ? {} : { required: server.required }),
  };
  if (server.type === "http" || server.type === "sse") {
    return {
      ...common,
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
      ...(server.headerEnv ? { header_env: server.headerEnv } : {}),
      ...(server.bearerTokenEnv ? { bearer_token_env: server.bearerTokenEnv } : {}),
    };
  }
  return {
    ...common,
    command: server.command,
    ...(server.environment ? { environment: server.environment } : {}),
  };
}

export function fxMcpProfileConfig(agent: AgentProfile): string {
  return `${JSON.stringify(
    {
      mcp: Object.fromEntries(
        Object.entries(agent.fxConfig.mcpServers).map(([name, server]) => [
          name,
          serializeMcpServer(server),
        ] as const),
      ),
    },
    null,
    2,
  )}\n`;
}

export function validateFxVersion(version: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("FX_VERSION must be a stable tag such as v0.0.4");
  }
  return version;
}

export function fxReleaseBase(version: string): string {
  return `https://github.com/vercel-labs/fx/releases/download/${validateFxVersion(version)}`;
}
