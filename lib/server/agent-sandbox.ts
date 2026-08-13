import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import {
  AGENT_COMMAND_TIMEOUT_MS,
  AGENT_SANDBOX_LEASE_MS,
  AgentSandboxBusyError,
  SANDBOX_SESSION_TIMEOUT_MS,
  agentRunInputPath,
} from "@/lib/agent-sandbox-lifecycle";
import {
  AGENT_RUNNER_SOURCE,
  RESULT_END,
  RESULT_START,
  RUNTIME_VERSION,
  baselineAgentsFile,
  consolePlatformSkill,
  runnerPackageJson,
  type AgentIdentity,
} from "@/lib/server/agent-sandbox-assets";
import { config, requireAiGatewayApiKey } from "@/lib/server/config";
import { acquireAgentSandboxLease, releaseAgentSandboxLease } from "@/lib/server/agent-sandbox-lease";

const RUNTIME_DIR = "/vercel/sandbox/runtime";
const WORKSPACE_DIR = "/vercel/sandbox/workspace";
const AI_VERSION = "^7.0.0";
const ZOD_VERSION = "^3.24.1";

export interface SandboxRunResult {
  output: string;
  steps: Array<{ kind: string; label: string; detail?: string }>;
  error?: string;
}

interface RunTaskInput {
  ownerId: string;
  agent: AgentIdentity;
  channelId?: string;
  /** Combined system instructions (identity + coordination context). */
  instructions: string;
  /** The user/peer prompt for this turn, including recent transcript. */
  prompt: string;
  /** Short-lived Console platform token scoped to { ownerId, agentId }. */
  token: string;
  maxSteps?: number;
}

/** Deterministic, project-unique sandbox name so an agent's durable files persist across channels. */
export function agentSandboxName(ownerId: string, agentId: string): string {
  const hash = createHash("sha1").update(`${ownerId}:${agentId}`).digest("hex").slice(0, 40);
  return `console-agent-${hash}`;
}

/**
 * Read a file an agent previously shared via `share_artifact` directly out of its persistent
 * sandbox, for the artifact preview API route. Returns undefined if the sandbox or file is gone
 * (e.g. the sandbox expired from inactivity) or if the path would escape the agent's workspace.
 */
export async function readAgentArtifactFile(
  ownerId: string,
  agentId: string,
  relativePath: string,
): Promise<Buffer | undefined> {
  const target = path.posix.resolve(WORKSPACE_DIR, relativePath);
  if (target !== WORKSPACE_DIR && !target.startsWith(`${WORKSPACE_DIR}/`)) return undefined;

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({ name: agentSandboxName(ownerId, agentId) });
  } catch {
    return undefined;
  }

  try {
    const buffer = await sandbox.readFileToBuffer({ path: target });
    return buffer ?? undefined;
  } catch {
    return undefined;
  }
}

function textContent(value: string) {
  return { content: Buffer.from(value, "utf8") };
}

async function provision(sandbox: Sandbox, agent: AgentIdentity): Promise<void> {
  await sandbox.mkDir(RUNTIME_DIR);
  await sandbox.mkDir(WORKSPACE_DIR);
  await sandbox.mkDir(`${WORKSPACE_DIR}/.agents/skills/console-platform`);
  await sandbox.mkDir(`${WORKSPACE_DIR}/memory`);
  await sandbox.writeFiles([
    { path: `${RUNTIME_DIR}/package.json`, ...textContent(runnerPackageJson(AI_VERSION, ZOD_VERSION)) },
    { path: `${RUNTIME_DIR}/runner.mjs`, ...textContent(AGENT_RUNNER_SOURCE) },
    { path: `${RUNTIME_DIR}/.runtime-version`, ...textContent(String(RUNTIME_VERSION)) },
    { path: `${WORKSPACE_DIR}/.agents/AGENTS.md`, ...textContent(baselineAgentsFile(agent, config.agentModelId)) },
    {
      path: `${WORKSPACE_DIR}/.agents/skills/console-platform/SKILL.md`,
      ...textContent(consolePlatformSkill(config.consoleBaseUrl)),
    },
  ]);
  const install = await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund", "--loglevel", "error"],
    cwd: RUNTIME_DIR,
    timeoutMs: 4 * 60 * 1000,
  });
  if (install.exitCode !== 0) {
    throw new Error(`Agent runtime install failed: ${(await install.stderr()).slice(0, 500)}`);
  }
}

/** Keep the runner source and skill current on an already-provisioned sandbox. */
async function refreshRuntime(sandbox: Sandbox): Promise<void> {
  const versionBuffer = await sandbox.readFileToBuffer({ path: `${RUNTIME_DIR}/.runtime-version` }).catch(() => null);
  if (versionBuffer && versionBuffer.toString("utf8").trim() === String(RUNTIME_VERSION)) return;
  await sandbox.writeFiles([
    { path: `${RUNTIME_DIR}/runner.mjs`, ...textContent(AGENT_RUNNER_SOURCE) },
    { path: `${RUNTIME_DIR}/package.json`, ...textContent(runnerPackageJson(AI_VERSION, ZOD_VERSION)) },
    { path: `${RUNTIME_DIR}/.runtime-version`, ...textContent(String(RUNTIME_VERSION)) },
  ]);
  await sandbox.runCommand({
    cmd: "npm",
    args: ["install", "--no-audit", "--no-fund", "--loglevel", "error"],
    cwd: RUNTIME_DIR,
    timeoutMs: 4 * 60 * 1000,
  });
}

function parseResult(stdout: string): SandboxRunResult {
  const start = stdout.lastIndexOf(RESULT_START);
  const end = stdout.lastIndexOf(RESULT_END);
  if (start === -1 || end === -1 || end < start) {
    return { output: "", steps: [], error: "Agent runner did not return a structured result" };
  }
  try {
    const payload = JSON.parse(stdout.slice(start + RESULT_START.length, end)) as SandboxRunResult;
    return { output: payload.output ?? "", steps: payload.steps ?? [], error: payload.error };
  } catch {
    return { output: "", steps: [], error: "Agent runner returned an invalid result payload" };
  }
}

/**
 * Run one agent turn inside its persistent sandbox. The AI SDK tool loop executes in the sandbox
 * (not in this function). Files the agent edits are snapshotted on stop and restored next run.
 */
export async function runAgentInSandbox(input: RunTaskInput): Promise<SandboxRunResult> {
  const gatewayKey = requireAiGatewayApiKey();
  const name = agentSandboxName(input.ownerId, input.agent.id);
  const leaseToken = await acquireAgentSandboxLease(input.ownerId, input.agent.id, AGENT_SANDBOX_LEASE_MS);
  if (!leaseToken) throw new AgentSandboxBusyError();
  const inputPath = agentRunInputPath(crypto.randomUUID());
  let created = false;
  let sandbox: Sandbox | undefined;
  let stoppedCleanly = false;

  try {
    sandbox = await Sandbox.getOrCreate({
      name,
      timeout: SANDBOX_SESSION_TIMEOUT_MS,
      persistent: true,
      keepLastSnapshots: { count: 1 },
      env: { AGENT_MODEL_ID: config.agentModelId },
      onCreate: async (sbx) => {
        created = true;
        await provision(sbx, input.agent);
      },
    });

    if (!created) await refreshRuntime(sandbox);

    await sandbox.writeFiles([
      {
        path: inputPath,
        ...textContent(
          JSON.stringify({
            workspaceDir: WORKSPACE_DIR,
            consoleBaseUrl: config.consoleBaseUrl,
            agentToken: input.token,
            channelId: input.channelId ?? null,
            instructions: input.instructions,
            prompt: input.prompt,
            maxSteps: input.maxSteps ?? 24,
          }),
        ),
      },
    ]);

    const command = await sandbox.runCommand({
      cmd: "node",
      args: ["runner.mjs", inputPath],
      cwd: RUNTIME_DIR,
      env: { AGENT_MODEL_ID: config.agentModelId, AI_GATEWAY_API_KEY: gatewayKey },
      timeoutMs: AGENT_COMMAND_TIMEOUT_MS,
    });

    const stdout = await command.stdout();
    const result = parseResult(stdout);
    if (command.exitCode !== 0 && !result.error) {
      result.error = (await command.stderr()).slice(0, 500) || `Runner exited with code ${command.exitCode}`;
    }
    return result;
  } finally {
    if (sandbox) {
      try {
        // Keep the lease until snapshotting finishes so another invocation cannot hit STOPPING.
        await sandbox.stop();
        stoppedCleanly = true;
      } catch {
        // Retain the lease until its TTL when shutdown cannot be confirmed. The sandbox session
        // expires before the lease, preventing another invocation from entering a closing stream.
      }
    } else {
      stoppedCleanly = true;
    }
    if (stoppedCleanly) {
      await releaseAgentSandboxLease(input.ownerId, input.agent.id, leaseToken).catch(() => {});
    }
  }
}
