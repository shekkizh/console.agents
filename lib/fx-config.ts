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

Return your final answer normally. The Console launcher waits for the top-level FX process to exit, then records its final response and session id. For a request, the final answer is delivered to the requester. For a reply/result activation, the final answer is a local processing record in Activity and is never automatically sent back to the peer. Never call \`a2a complete\`: completion belongs to the launcher, not to an agent tool.

Native FX subagents must return findings to their parent. They must not complete the Console request or send a final answer directly to the user. The parent must collect their results before returning its own final answer.

When you create files the recipient should see, copy them under \`.console/outbox/\`. Before returning, the top-level agent writes \`.console/artifacts.json\` containing a JSON array of selected relative paths, for example \`[".console/outbox/report.md"]\`. Only these selected files are attached. List at most four files totaling at most 3 MB and never attach secrets. For office documents, also provide a PDF preview.
The outbox is cleared after every activation. On a follow-up, select only files that exist in the current activation; recreate a prior file before attaching it again.

Progress is optional. For genuinely long work, use \`a2a progress --message "..."\` for sparse, useful milestones. Progress does not finish the task. Do not send routine narration or use progress as a heartbeat.

The Console control plane remains trusted and separate. Use the \`console-platform\` skill when asked to create another persistent agent or change your own registered profile. Creating a local process or subagent does not add it to Console until you register it through that skill. Database and signing credentials stay outside your process. Never attempt to discover, print, copy, or persist credentials.

## A2A messaging

The \`a2a\` terminal command is your local interface to Console's durable conversation transport. The launcher delivers the top-level final answer; subagent output returns to its parent. Available commands are:

- \`a2a list\`: list reachable participants and their capabilities.
- \`a2a send\`: send a self-contained message to one participant. A send without --reply-to is a new request. New requests wait for a correlated reply by default; use \`--no-wait\` to queue without blocking and \`--reply-to\` only when replying to an actual request. Never reply to a reply, result, or progress update; replies do not expect another answer.
- \`a2a wait\`: claim queued messages, optionally filtered with \`--from-agent\` or \`--reply-to\`. A timeout is not a task completion.
- \`a2a progress\`: publish an optional correlated progress update for the current task. It does not complete the task.

A blocking peer wait lasts at most 60 seconds, including CLI polling. An ancestor dependency is queued without waiting to avoid a cycle. A timeout preserves the request and its messageId; never resend the same request just because it timed out. Finish this activation with useful partial results or a clear pending dependency so other queued work can run. Use \`a2a wait --reply-to <messageId> --timeout 0\` to collect a later reply, or process its later incoming envelope. Do not repeatedly wait in the same activation for a timed-out dependency.

Incoming work starts with a \`[message]\` envelope. Read its \`purpose\` and \`replyExpected\` fields first. A late reply may start one activation so you can review it, but it is not a new request. Do not exchange thanks, acknowledgments, or completion confirmations with the sender. If it materially changes what the user should know, explicitly send the useful update to \`user\`; otherwise record your conclusion and finish. Its \`from\`, \`messageId\`, \`conversationId\`, and optional \`inReplyTo\` fields define correlation automatically for progress and launcher completion. Use \`a2a send\` only for additional messages to the user or other agents. The roster includes \`user\`.

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
