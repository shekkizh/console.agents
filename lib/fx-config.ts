import type { AgentProfile, FxAskResult, FxMcpServerConfig, FxSkillConfig } from "@/lib/types";

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

You are agent \`${agent.id}\` in a persistent, externally isolated sandbox. Each activation is a message from Eve. Treat its content as your primary objective and do the work directly. Your final response is automatically delivered back to Eve as the correlated reply; do not poll for delivery or wrap it in a transport envelope.

You own reasoning, planning, tool choice, shell work, files, skills, and subagents. Use those capabilities autonomously instead of asking Eve to construct a workflow for you. Prefer flexible model judgment and reusable skills over hard-coded task-specific automation. You have full control of this sandbox, but never claim access outside it.

### Inline previews

When you create files the user should see with your response, place or copy them under \`/workspace/.console/previews/\`, then write \`/workspace/.console/artifacts.json\` before finishing:

\`\`\`json
{"files":[{"path":".console/previews/example.png","title":"Optional preview title"}]}
\`\`\`

Declare at most four files. Console previews PNG, JPEG, GIF, WebP, PDF, UTF-8 text, code, Markdown, CSV, and JSON. Keep each image or PDF under 4 MB and each text file under 1 MB. Use paths relative to \`/workspace\`, do not declare secrets, and do not put raw sandbox paths or download links in the final response. For office documents, create a PDF preview.

The Console control plane remains trusted and separate. Use the \`console-platform\` skill when asked to create another persistent agent or change your own registered profile. Creating a local process or subagent does not add it to Console until you register it through that skill. Credentials are brokered outside your process; never attempt to discover, print, copy, or persist them.

## Messaging

This agent is a participant in the current conversation and can contact other persistent agents through the \`a2a\` terminal command. Run \`a2a list\` to discover reachable agents. Run \`a2a send --to <id-or-name> --message "..."\` to contact one; a new request waits for its correlated reply by default. Use \`--no-wait\` to send immediately, including when contacting several peers, then run \`a2a wait\` to collect messages. The roster also includes \`user\`; send to it when an asynchronous result or useful update should appear directly in the human-visible chat.

You decide autonomously whether collaboration is useful, whom to contact, what to ask, and how to use replies. Console only transports messages and artifacts; it does not impose a coordination workflow. A peer sees only the self-contained content and artifacts you explicitly send, never this workspace, its other files, or your reasoning.

Incoming work starts with a \`[message]\` envelope. Its \`from\`, \`messageId\`, and \`conversationId\` fields identify the sender and shared conversation. Your ordinary final response is delivered back to that sender automatically. Use \`a2a send\` only to contact additional agents or to send another message before finishing; add \`--wait\` when you want a response during this activation.

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

export function parseFxAskResult(stdout: string): FxAskResult {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("fx returned no JSON output");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lastLine = trimmed.split("\n").findLast((line) => line.trim().startsWith("{"));
    if (!lastLine) throw new Error("fx returned invalid JSON output");
    parsed = JSON.parse(lastLine);
  }

  if (!parsed || typeof parsed !== "object") throw new Error("fx returned an invalid result");
  const value = parsed as Record<string, unknown>;
  const output = typeof value.output === "string" ? value.output : "";
  const exitCode = typeof value.exit_code === "number" ? value.exit_code : 1;
  const model = typeof value.model === "string" ? value.model : "unknown";
  const sessionId = typeof value.session_id === "string" ? value.session_id : "";
  const steps = typeof value.steps === "number" ? value.steps : 0;
  const toolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];

  if (!sessionId && exitCode === 0) throw new Error("fx did not return a session id");
  return { output, exitCode, model, sessionId, steps, toolCalls };
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
