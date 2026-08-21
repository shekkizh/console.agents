import type { RuntimeSandboxSession, SandboxSession } from "eve/sandbox";
import { z } from "zod";
import { optionalFxCapabilitiesSchema } from "@/lib/agent-capabilities";
import {
  fxAgentInstructions,
  fxMcpProfileConfig,
  fxProjectConfig,
  fxSkillFile,
  fxReleaseBase,
  parseFxAskResult,
  validateFxVersion,
} from "@/lib/fx-config";
import {
  createAgent,
  findAgentByName,
  listAgents,
  updateAgent,
} from "@/lib/server/agent-store";
import { config, requireAiGatewayApiKey } from "@/lib/server/config";
import {
  activeFxNetworkPolicy,
  idleFxNetworkPolicy,
  stopsFxSandboxAfterTurn,
} from "@/lib/server/fx-network-policy";
import type { AgentProfile, FxAskResult } from "@/lib/types";
import {
  ARTIFACT_MANIFEST_PATH,
  EMPTY_ARTIFACT_MANIFEST,
  collectPreviewArtifacts,
  type CapturedArtifact,
} from "@/lib/server/artifact-capture";

export const FX_BINARY_PATH = "/workspace/.console/bin/fx";
const FX_SESSION_PATH = ".console/fx-session-id";
const CONTROL_PATH = ".console/control-plane.json";

const controlRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create-agent"),
    requestId: z.string().trim().min(1).max(100),
    name: z.string().trim().min(2).max(60),
    specialty: z.string().trim().min(2).max(160),
    instructions: z.string().trim().min(8).max(20_000),
    model: z.string().trim().min(3).max(200).optional(),
    maxSteps: z.number().int().min(1).max(128).optional(),
    ...optionalFxCapabilitiesSchema,
  }),
  z.object({
    type: z.literal("update-self"),
    requestId: z.string().trim().min(1).max(100),
    name: z.string().trim().min(2).max(60).optional(),
    specialty: z.string().trim().min(2).max(160).optional(),
    instructions: z.string().trim().min(8).max(20_000).optional(),
    model: z.string().trim().min(3).max(200).optional(),
    maxSteps: z.number().int().min(1).max(128).optional(),
    ...optionalFxCapabilitiesSchema,
  }),
]);

const controlEnvelopeSchema = z.object({ requests: z.array(controlRequestSchema).max(5) });

export function fxInstallCommand(versionInput = config.fxVersion): string {
  const version = validateFxVersion(versionInput);
  const releaseBase = fxReleaseBase(version);
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
mkdir -p /workspace/.console/bin
install -m 0755 fx ${FX_BINARY_PATH}
${FX_BINARY_PATH} --version`;
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

\`/workspace/.console/control-plane.json\`

\`\`\`json
{
  "requests": [
    {
      "type": "create-agent",
      "requestId": "unique-id-for-this-request",
      "name": "Researcher",
      "specialty": "Evidence-backed research",
      "instructions": "Detailed durable operating instructions",
      "model": "zai/glm-5.2",
      "maxSteps": 48
    }
  ]
}
\`\`\`

The other request type is \`update-self\`; it accepts \`requestId\` and profile or runtime settings such as \`model\`, \`maxSteps\`, \`skills\`, and \`mcpServers\`. Network access can only be changed by the user in Agent settings. At most five requests are accepted per turn. Agent Console validates and applies them after your turn, then clears the file. Use \`.console/agents.json\` to inspect the current roster. Creating only a local process or subagent does not register a persistent Console agent.
`;
}

async function syncFxCapabilities(sandbox: SandboxSession, agent: AgentProfile): Promise<void> {
  await sandbox.removePath({ path: ".fx/skills", recursive: true, force: true });
  const skillDirectory = await sandbox.run({ command: "mkdir -p /workspace/.fx/skills" });
  if (skillDirectory.exitCode !== 0) throw new Error("Unable to prepare the fx skills directory");
  await Promise.all(
    agent.fxConfig.skills.map((skill) =>
      sandbox.writeTextFile({
        path: `.fx/skills/${skill.name}/SKILL.md`,
        content: fxSkillFile(skill),
      }),
    ),
  );

  const homeResult = await sandbox.run({ command: 'printf "%s" "$HOME"' });
  const home = homeResult.stdout.trim();
  if (!/^\/[A-Za-z0-9._/-]+$/.test(home) || home.split("/").includes("..")) {
    throw new Error("Sandbox returned an invalid home directory");
  }
  const prepare = await sandbox.run({ command: `mkdir -p '${home}/.fx'` });
  if (prepare.exitCode !== 0) throw new Error("Unable to prepare the fx profile directory");
  await sandbox.writeTextFile({ path: `${home}/.fx/mcp.json`, content: fxMcpProfileConfig(agent) });
}

async function ensureFxInstalled(sandbox: SandboxSession): Promise<void> {
  const probe = await sandbox.run({ command: `test -x ${FX_BINARY_PATH}` });
  if (probe.exitCode === 0) return;
  const install = await sandbox.run({ command: fxInstallCommand() });
  if (install.exitCode !== 0) {
    throw new Error(`Unable to install fx ${config.fxVersion}: ${install.stderr.slice(0, 500)}`);
  }
}

export async function syncFxAgentConfig(
  sandbox: SandboxSession,
  agent: AgentProfile,
  roster: AgentProfile[],
): Promise<void> {
  await syncFxCapabilities(sandbox, agent);
  await Promise.all([
    sandbox.writeTextFile({ path: "AGENTS.md", content: fxAgentInstructions(agent) }),
    sandbox.writeTextFile({ path: ".fx.json", content: fxProjectConfig(agent) }),
    sandbox.writeTextFile({
      path: "skills/console-platform/SKILL.md",
      content: consolePlatformSkill(),
    }),
    sandbox.writeTextFile({
      path: ".console/agents.json",
      content: `${JSON.stringify(
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
    }),
  ]);
}

function validSessionId(value: string | null): string | undefined {
  const sessionId = value?.trim();
  return sessionId && /^[A-Za-z0-9._:-]{1,200}$/.test(sessionId) ? sessionId : undefined;
}

async function applyControlRequests(input: {
  ownerId: string;
  agent: AgentProfile;
  sandbox: SandboxSession;
}): Promise<{ applied: Array<Record<string, unknown>>; currentAgent: AgentProfile }> {
  let raw: string | null = null;
  try {
    raw = await input.sandbox.readTextFile({ path: CONTROL_PATH });
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
          maxSteps: request.maxSteps,
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
      maxSteps: request.maxSteps,
      skills: request.skills,
      mcpServers: request.mcpServers,
    };
    currentAgent = await updateAgent(input.ownerId, input.agent.id, update, {
      type: "agent",
      id: input.agent.id,
    });
    applied.push({ requestId, type: request.type, configVersion: currentAgent.configVersion });
  }

  await input.sandbox.writeTextFile({ path: CONTROL_PATH, content: '{"requests":[]}\n' });
  return { applied, currentAgent };
}

export interface FxTurnOutcome extends FxAskResult {
  controlPlaneChanges: Array<Record<string, unknown>>;
  artifacts: CapturedArtifact[];
}

export async function runFxTurn(input: {
  ownerId: string;
  agent: AgentProfile;
  prompt: string;
  sandbox: RuntimeSandboxSession;
  abortSignal?: AbortSignal;
}): Promise<FxTurnOutcome> {
  await ensureFxInstalled(input.sandbox);
  const roster = await listAgents(input.ownerId);
  await syncFxAgentConfig(input.sandbox, input.agent, roster);

  let storedSession: string | null = null;
  try {
    storedSession = await input.sandbox.readTextFile({ path: FX_SESSION_PATH });
  } catch {
    storedSession = null;
  }
  const previousSession = validSessionId(storedSession);
  await Promise.all([
    input.sandbox.writeTextFile({ path: ".console/prompt.txt", content: input.prompt }),
    input.sandbox.writeTextFile({
      path: ARTIFACT_MANIFEST_PATH,
      content: EMPTY_ARTIFACT_MANIFEST,
    }),
  ]);

  const resume = previousSession ? '--resume-id "$FX_RESUME_ID"' : "";
  const command = `cd /workspace && prompt="$(cat .console/prompt.txt)" && exec ${FX_BINARY_PATH} ask --json --yolo ${resume} -- "$prompt"`;
  const stopAfterTurn = stopsFxSandboxAfterTurn();

  try {
    await input.sandbox.setNetworkPolicy(
      activeFxNetworkPolicy(
        input.agent.fxConfig.networkAccess,
        input.agent.fxConfig.networkAllowlist,
      ),
    );
    const run = await input.sandbox.run({
      command,
      abortSignal: input.abortSignal,
      env: {
        AI_GATEWAY_API_KEY: requireAiGatewayApiKey(),
        FX_MODEL: input.agent.fxConfig.model,
        FX_RESUME_ID: previousSession ?? "",
      },
    });
    const result = parseFxAskResult(run.stdout);
    if (run.exitCode !== 0 || result.exitCode !== 0) {
      throw new Error(result.output || run.stderr.slice(0, 1_000) || `fx exited ${run.exitCode}`);
    }
    await input.sandbox.writeTextFile({ path: FX_SESSION_PATH, content: `${result.sessionId}\n` });
    const control = await applyControlRequests(input);
    if (control.currentAgent.configVersion !== input.agent.configVersion) {
      await syncFxAgentConfig(input.sandbox, control.currentAgent, await listAgents(input.ownerId));
    }
    const artifacts = await collectPreviewArtifacts(input.sandbox);
    return { ...result, controlPlaneChanges: control.applied, artifacts };
  } finally {
    try {
      await input.sandbox.writeTextFile({ path: ".console/prompt.txt", content: "" });
    } catch {
      // The sandbox may already be gone after cancellation.
    }

    if (stopAfterTurn) {
      // Local compute stops after every turn; the durable filesystem and policy are preserved.
      try {
        await input.sandbox.stop();
      } catch {
        // Best effort: the sandbox provider may already be gone after cancellation.
      }
    } else {
      try {
        await input.sandbox.setNetworkPolicy(idleFxNetworkPolicy());
      } catch {
        // Best effort: the sandbox provider may already be gone after cancellation.
      }
    }
  }
}
