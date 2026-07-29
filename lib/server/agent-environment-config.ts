interface ManagedAgentIdentity {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
}

export function consolePlatformSkill(baseUrl: string): string {
  return `---
name: console-platform
description: Inspect and modify Console agents through the authenticated Console control-plane API.
---
# Console Platform

BASE_URL: \`${baseUrl}\`

Use this API whenever a user asks you to create, inspect, or modify a persistent Console agent. Authentication is injected automatically for this domain by the managed-environment egress proxy. Do not read, request, store, or send an API token. Use curl, Python, or another HTTP client normally. Treat every non-2xx response as a failure, include \`Accept: application/json\`, and confirm the response has \`success: true\` before claiming a change succeeded.

## Your identity

- \`GET /api/agent-platform/me\` — inspect your Console identity and editable profile.
- \`PATCH /api/agent-platform/me\` — custom agents can update their own \`name\`, \`specialty\`, or \`instructions\`. General is built in and evolves through its local \`.agents/AGENTS.md\` instead.

Example:

\`\`\`bash
curl -fsS -H 'Accept: application/json' ${baseUrl}/api/agent-platform/me
curl -fsS -X PATCH ${baseUrl}/api/agent-platform/me \\
  -H 'Accept: application/json' \\
  -H 'Content-Type: application/json' \\
  -d '{"instructions":"Updated standing instructions"}'
\`\`\`

## Agent roster

- \`GET /api/agent-platform/agents\` — list the user's persistent Console agents.
- \`POST /api/agent-platform/agents\` — create a persistent managed agent. Body: \`name\`, \`specialty\`, \`instructions\`.
- \`GET /api/agent-platform/agents/{agentId}\` — inspect one agent.
- \`PATCH /api/agent-platform/agents/{agentId}\` — update an agent. You may update yourself; General may update any agent in its user's roster.

Creating files or processes in the sandbox does not add an agent to Console. When asked for a dedicated or reusable agent, call POST, verify it with GET, and report the returned agent ID.

If an API call fails or returns HTML instead of JSON, do not fall back to pretending a local file is an agent. Report the HTTP failure clearly.

## Durable local state

Console reuses your latest managed environment across tasks. You may maintain your own durable files, including:

- \`.agents/AGENTS.md\` for evolving operating instructions.
- \`.agents/skills/<skill-name>/SKILL.md\` for reusable skills.
- \`memory/\` or other workspace files for long-term notes and state.

Edit those files directly with normal file tools. The Console API changes the roster/profile stored in the database; local files change the working system inside your managed environment. Keep both aligned when a profile change affects your operating instructions.
`;
}

function baselineAgentsFile(agent: ManagedAgentIdentity): string {
  return `# ${agent.name}\n\nRole: ${agent.specialty}\n\n${agent.instructions}\n\nYour Console agent ID is \`${agent.id}\`. Use the console-platform skill for persistent roster or profile changes. You may edit this file as your operating instructions evolve.`;
}

export function buildManagedEnvironment(
  agent: ManagedAgentIdentity,
  token: string,
  baseUrl: string,
  environmentId?: string,
  repositoryUrl?: string,
) {
  const domain = new URL(baseUrl).hostname;
  const sources: Array<Record<string, string>> = [];

  if (!environmentId) {
    sources.push(
      {
        type: "inline",
        target: ".agents/skills/console-platform/SKILL.md",
        content: consolePlatformSkill(baseUrl),
      },
      { type: "inline", target: ".agents/AGENTS.md", content: baselineAgentsFile(agent) },
    );
    if (repositoryUrl) sources.push({ type: "repository", source: repositoryUrl, target: "/workspace/repository" });
  }

  return {
    type: "remote",
    ...(environmentId ? { environment_id: environmentId } : {}),
    ...(sources.length ? { sources } : {}),
    network: {
      allowlist: [
        { domain, transform: { Authorization: `Bearer ${token}` } },
        { domain: "*" },
      ],
    },
  };
}
