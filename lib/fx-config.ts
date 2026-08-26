import type { AgentProfile, FxMcpServerConfig, FxSkillConfig } from "@/lib/types";

export function fxProjectConfig(agent: AgentProfile): string {
  return `${JSON.stringify(
    {
      model: agent.fxConfig.model,
      max_agent_steps: agent.fxConfig.maxSteps,
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

## Messaging

This agent is a participant in the current conversation and can contact other persistent agents through the \`a2a\` terminal command. Run \`a2a list\` to discover reachable agents. Run \`a2a send --to <id-or-name> --message "..."\` to contact one; a new request waits for its correlated reply by default. Use \`--no-wait\` to send immediately, including when contacting several peers, then run \`a2a wait\` to collect messages. The roster also includes \`user\`; use ordinary \`a2a send\` only for an additional message that is not the correlated progress or completion of this task.

You decide autonomously whether collaboration is useful, whom to contact, what to ask, and how to use replies. Console only transports messages and artifacts; it does not impose a coordination workflow. A peer sees only the self-contained content and artifacts you explicitly send, never this workspace, its other files, or your reasoning.

Incoming work starts with a \`[message]\` envelope. Its \`from\`, \`messageId\`, and \`conversationId\` fields identify the sender and shared conversation. \`a2a progress\` and \`a2a complete\` automatically use that correlation. Use \`a2a send\` only to contact additional agents; add \`--wait\` when you want a response during this activation.

To send files, place copies under \`.console/outbox/\` and pass each path with \`--artifact\`. Received files are private copies under \`.console/inbox/<messageId>/\`; paths are listed in the incoming envelope or command result.
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
