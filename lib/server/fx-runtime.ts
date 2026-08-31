import { createHash } from "node:crypto";
import { z } from "zod";
import { a2aCliSource, A2A_CLI_PATH, A2A_CLI_SOURCE_PATH } from "@/lib/a2a-cli";
import { optionalFxCapabilitiesSchema } from "@/lib/agent-capabilities";
import type { AgentSandbox } from "@/lib/server/agent-sandbox";
import {
  fxAgentInstructions,
  fxMcpProfileConfig,
  fxProjectConfig,
  fxSkillFile,
  fxReleaseBase,
  validateFxVersion,
} from "@/lib/fx-config";
import {
  createAgent,
  findAgentByName,
  listAgents,
  updateAgent,
} from "@/lib/server/agent-store";
import { createAgentMessageToken } from "@/lib/server/message-auth";
import { config, consoleAgentApiUrl, requireAiGatewayApiKey } from "@/lib/server/config";
import { materializeMessageArtifacts } from "@/lib/server/message-runtime";
import { latestFxCompletionSessionId } from "@/lib/server/message-store";
import type { AgentProfile } from "@/lib/types";

const CONTROL_PATH = ".console/control-plane.json";

export function fxBinaryPath(root = "/workspace"): string {
  return root + "/.console/bin/fx";
}

const controlRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create-agent"),
    requestId: z.string().trim().min(1).max(100),
    name: z.string().trim().min(2).max(60),
    specialty: z.string().trim().min(2).max(160),
    instructions: z.string().trim().min(8).max(20_000),
    model: z.string().trim().min(3).max(200).optional(),
    ...optionalFxCapabilitiesSchema,
  }),
  z.object({
    type: z.literal("update-self"),
    requestId: z.string().trim().min(1).max(100),
    name: z.string().trim().min(2).max(60).optional(),
    specialty: z.string().trim().min(2).max(160).optional(),
    instructions: z.string().trim().min(8).max(20_000).optional(),
    model: z.string().trim().min(3).max(200).optional(),
    ...optionalFxCapabilitiesSchema,
  }),
]);

const controlEnvelopeSchema = z.object({ requests: z.array(controlRequestSchema).max(5) });

export function fxInstallCommand(
  versionInput = config.fxVersion,
  root = "/workspace",
): string {
  const version = validateFxVersion(versionInput);
  const releaseBase = fxReleaseBase(version);
  const binaryPath = fxBinaryPath(root);
  return `set -eu
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) target="linux-x86_64" ;;
  aarch64|arm64) target="linux-aarch64" ;;
  *) echo "Unsupported fx sandbox architecture: $arch" >&2; exit 1 ;;
esac
name="fx-$target.tar.gz"
base="${releaseBase}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
curl -fsSLO "$base/$name"
curl -fsSLO "$base/$name.sha256"
sha256sum -c "$name.sha256"
tar -xzf "$name"
mkdir -p '${root}/.console/bin'
install -m 0755 fx '${binaryPath}'
'${binaryPath}' --version`;
}

export function consolePlatformSkill(): string {
  return `---
name: console-platform
description: Create or configure persistent agents through Agent Console's trusted outbox.
---
# Console platform

Agent Console owns the registry, channels, and credentials. You never receive a database or control-plane token.

Do the user's substantive work yourself using your reasoning, tools, skills, and subagents. This skill is only for the small set of privileged registry changes that must cross the sandbox boundary; it is not a task orchestrator.

To create a persistent Console agent or update your own registered configuration, write this bounded outbox file:

\`.console/control-plane.json\`

\`\`\`json
{
  "requests": [
    {
      "type": "create-agent",
      "requestId": "unique-id-for-this-request",
      "name": "Researcher",
      "specialty": "Evidence-backed research",
      "instructions": "Detailed durable operating instructions",
      "model": "minimax/minimax-m3-free"
    }
  ]
}
\`\`\`

The other request type is \`update-self\`; it accepts \`requestId\` and profile or runtime settings such as \`model\`, \`skills\`, and \`mcpServers\`. Network access can only be changed by the user in Agent settings. At most five requests are accepted per turn. Agent Console validates and applies them after your turn, then clears the file. Use \`.console/agents.json\` to inspect the current roster. Creating only a local process or subagent does not register a persistent Console agent.
`;
}

async function syncFxCapabilities(sandbox: AgentSandbox, agent: AgentProfile): Promise<void> {
  await sandbox.removePath(".fx/skills", { recursive: true, force: true });
  const skillDirectory = await sandbox.run({
    command: "mkdir -p '" + sandbox.root + "/.fx/skills'",
  });
  if (skillDirectory.exitCode !== 0) throw new Error("Unable to prepare the fx skills directory");
  await Promise.all(
    agent.fxConfig.skills.map((skill) =>
      sandbox.writeTextFile(`.fx/skills/${skill.name}/SKILL.md`, fxSkillFile(skill)),
    ),
  );

  const homeResult = await sandbox.run({ command: 'printf "%s" "$HOME"' });
  const home = homeResult.stdout.trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(home) || home.split("/").includes("..")) {
    throw new Error("Sandbox returned an invalid home directory");
  }
  const prepare = await sandbox.run({ command: `mkdir -p '${home}/.fx'` });
  if (prepare.exitCode !== 0) throw new Error("Unable to prepare the fx profile directory");
  await sandbox.writeTextFile(`${home}/.fx/mcp.json`, fxMcpProfileConfig(agent));
}

async function ensureFxInstalled(sandbox: AgentSandbox): Promise<void> {
  const binaryPath = fxBinaryPath(sandbox.root);
  const probe = await sandbox.run({ command: `test -x '${binaryPath}'` });
  if (probe.exitCode !== 0) {
    const install = await sandbox.run({
      command: fxInstallCommand(config.fxVersion, sandbox.root),
    });
    if (install.exitCode !== 0) {
      throw new Error(`Unable to install fx ${config.fxVersion}: ${install.stderr.slice(0, 500)}`);
    }
  }
  await sandbox.writeTextFile(A2A_CLI_SOURCE_PATH, a2aCliSource());
  const executable = await sandbox.run({
    command: `install -m 0755 '${sandbox.root}/${A2A_CLI_SOURCE_PATH}' '${sandbox.root}/${A2A_CLI_PATH}'`,
  });
  if (executable.exitCode !== 0) throw new Error("Unable to install agent messaging command");
}

export async function syncFxAgentConfig(
  sandbox: AgentSandbox,
  agent: AgentProfile,
  roster: AgentProfile[],
): Promise<void> {
  await syncFxCapabilities(sandbox, agent);
  await Promise.all([
    sandbox.writeTextFile("AGENTS.md", fxAgentInstructions(agent)),
    sandbox.writeTextFile(".fx.json", fxProjectConfig(agent)),
    sandbox.writeTextFile("skills/console-platform/SKILL.md", consolePlatformSkill()),
    sandbox.writeTextFile(
      ".console/agents.json",
      `${JSON.stringify(
        roster.map(({ id, name, specialty, enabled, fxConfig }) => ({
          id,
          name,
          specialty,
          enabled,
          model: fxConfig.model,
        })),
        null,
        2,
      )}\n`,
    ),
  ]);
}

function validSessionId(value: string | null): string | undefined {
  const sessionId = value?.trim();
  return sessionId && /^[A-Za-z0-9._:-]{1,200}$/.test(sessionId) ? sessionId : undefined;
}

async function applyControlRequests(input: {
  ownerId: string;
  agent: AgentProfile;
  sandbox: AgentSandbox;
}): Promise<{ applied: Array<Record<string, unknown>>; currentAgent: AgentProfile }> {
  let raw: string | null = null;
  try {
    raw = await input.sandbox.readTextFile(CONTROL_PATH);
  } catch {
    raw = null;
  }
  if (!raw?.trim()) return { applied: [], currentAgent: input.agent };
  if (raw.length > 64_000) throw new Error("fx control-plane outbox exceeds 64 KB");
  const envelope = controlEnvelopeSchema.parse(JSON.parse(raw));
  const applied: Array<Record<string, unknown>> = [];
  let currentAgent = input.agent;

  for (const request of envelope.requests) {
    if (request.type === "create-agent") {
      const existing = await findAgentByName(input.ownerId, request.name);
      const created =
        existing ??
        (await createAgent(input.ownerId, {
          name: request.name,
          specialty: request.specialty,
          instructions: request.instructions,
          model: request.model,
          skills: request.skills,
          mcpServers: request.mcpServers,
          createdByAgentId: input.agent.id,
        }));
      applied.push({
        requestId: request.requestId,
        type: request.type,
        agentId: created.id,
        created: !existing,
      });
      continue;
    }

    const { requestId } = request;
    const update = {
      name: request.name,
      specialty: request.specialty,
      instructions: request.instructions,
      model: request.model,
      skills: request.skills,
      mcpServers: request.mcpServers,
    };
    currentAgent = await updateAgent(input.ownerId, input.agent.id, update, {
      type: "agent",
      id: input.agent.id,
    });
    applied.push({ requestId, type: request.type, configVersion: currentAgent.configVersion });
  }

  await input.sandbox.writeTextFile(CONTROL_PATH, '{"requests":[]}\n');
  return { applied, currentAgent };
}

export interface FxLaunchOutcome {
  sandboxId: string;
  processId?: string;
  resumedSessionId?: string;
}

function fxJobKey(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 24);
}

export interface RecoveredFxCompletion {
  content: string;
  sessionId: string;
}

export function extractCommittedFxCompletion(
  events: string,
  incomingMessageId: string,
): string | undefined {
  let completion: string | undefined;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        kind?: unknown;
        payload?: {
          turn?: {
            user?: { text?: unknown };
            assistant?: unknown;
          };
        };
      };
      const userText = event.payload?.turn?.user?.text;
      const assistant = event.payload?.turn?.assistant;
      if (
        event.kind === "history_turn_committed" &&
        typeof userText === "string" &&
        userText.includes(`messageId: ${incomingMessageId}`) &&
        typeof assistant === "string" &&
        assistant.trim()
      ) {
        completion = assistant.trim();
      }
    } catch {
      // Ignore partially written or unrelated event records.
    }
  }
  return completion;
}

export async function recoverDetachedFxCompletion(input: {
  sandbox: AgentSandbox;
  incomingMessageId: string;
}): Promise<"running" | RecoveredFxCompletion | undefined> {
  const jobDirectory = `.console/jobs/${fxJobKey(input.incomingMessageId)}`;
  const pidFile = `${input.sandbox.root}/${jobDirectory}/worker.pid`;
  const state = await input.sandbox.run({
    command: `pid="$(cat '${pidFile}' 2>/dev/null || true)"
if test -n "$pid" && kill -0 "$pid" 2>/dev/null && test -r "/proc/$pid/cmdline" && tr '\\0' ' ' < "/proc/$pid/cmdline" | grep -Fq '/.console/bin/fx ask'; then
  printf running
else
  printf stopped
fi`,
  });
  if (state.stdout.trim() === "running") return "running";

  const located = await input.sandbox.run({
    command: `find '${input.sandbox.root}/.fx/sessions' -mindepth 2 -maxdepth 2 -type f -name events.jsonl -exec grep -lF -- '${input.incomingMessageId}' {} + | sort`,
  });
  const eventPaths = located.stdout.trim().split("\n").filter(Boolean).reverse();
  for (const eventPath of eventPaths) {
    if (
      !eventPath.startsWith(`${input.sandbox.root}/.fx/sessions/`) ||
      !eventPath.endsWith("/events.jsonl")
    ) {
      continue;
    }
    const events = await input.sandbox.readTextFile(eventPath);
    if (!events) continue;
    const content = extractCommittedFxCompletion(events, input.incomingMessageId);
    if (!content) continue;
    const sessionId = eventPath.split("/").at(-2);
    if (!sessionId || !validSessionId(sessionId)) continue;
    return { content, sessionId };
  }
}

export async function launchFxTurn(input: {
  ownerId: string;
  agent: AgentProfile;
  conversationId: string;
  prompt: string;
  incomingMessageId: string;
  incomingFromAgentId?: string;
  sandbox: AgentSandbox;
}): Promise<FxLaunchOutcome> {
  await ensureFxInstalled(input.sandbox);
  await syncFxAgentConfig(input.sandbox, input.agent, await listAgents(input.ownerId));

  if (!/^conversation-[A-Za-z0-9-]+$/.test(input.conversationId)) {
    throw new Error("Invalid conversation id");
  }
  const previousSession = validSessionId(await latestFxCompletionSessionId({
    ownerId: input.ownerId,
    agentId: input.agent.id,
    conversationId: input.conversationId,
  }) ?? null);
  const jobKey = fxJobKey(input.incomingMessageId);
  const jobDirectory = `.console/jobs/${jobKey}`;
  await input.sandbox.removePath(jobDirectory, { recursive: true, force: true });
  const prepared = await input.sandbox.run({
    command: `mkdir -p '${input.sandbox.root}/${jobDirectory}'`,
  });
  if (prepared.exitCode !== 0) throw new Error("Unable to prepare the FX job directory");
  await input.sandbox.writeTextFile(`${jobDirectory}/prompt.txt`, input.prompt);

  const resume = previousSession ? '--resume-id "$FX_RESUME_ID"' : "";
  const binaryPath = fxBinaryPath(input.sandbox.root);
  const command = `set -eu
echo $$ > '${input.sandbox.root}/${jobDirectory}/worker.pid'
export PATH="${input.sandbox.root}/.console/bin:$PATH"
cd '${input.sandbox.root}'
prompt="$(cat '${input.sandbox.root}/${jobDirectory}/prompt.txt')"
rm -f '${input.sandbox.root}/${jobDirectory}/prompt.txt'
exec '${binaryPath}' ask --yolo ${resume} -- "$prompt" >/dev/null 2>&1`;
  const messageToken = createAgentMessageToken({
    ownerId: input.ownerId,
    agentId: input.agent.id,
    conversationId: input.conversationId,
    incomingMessageId: input.incomingMessageId,
    incomingFromAgentId: input.incomingFromAgentId,
  });

  try {
    await input.sandbox.setNetworkPolicy(
      input.agent.fxConfig.networkAccess,
      input.agent.fxConfig.networkAllowlist,
    );
    await materializeMessageArtifacts(
      { ownerId: input.ownerId, sandbox: input.sandbox },
      input.incomingMessageId,
    );
    const process = await input.sandbox.spawn({
      command,
      env: {
        AI_GATEWAY_API_KEY: requireAiGatewayApiKey(),
        CONSOLE_A2A_TOKEN: messageToken,
        CONSOLE_A2A_URL: consoleAgentApiUrl(),
        CONSOLE_WORKSPACE: input.sandbox.root,
        FX_MODEL: input.agent.fxConfig.model,
        FX_RESUME_ID: previousSession ?? "",
      },
    });
    return {
      sandboxId: input.sandbox.id,
      processId: process.id,
      resumedSessionId: previousSession,
    };
  } catch (error) {
    throw error;
  }
}

export async function finalizeDetachedFxTurn(input: {
  ownerId: string;
  agent: AgentProfile;
  sandbox: AgentSandbox;
}): Promise<Array<Record<string, unknown>>> {
  const control = await applyControlRequests(input);
  if (control.currentAgent.configVersion !== input.agent.configVersion) {
    await syncFxAgentConfig(input.sandbox, control.currentAgent, await listAgents(input.ownerId));
  }
  await Promise.all(
    [".console/jobs", ".console/inbox", ".console/outbox"].map((path) =>
      input.sandbox.removePath(path, { recursive: true, force: true }).catch(() => undefined)
    ),
  );
  return control.applied;
}
