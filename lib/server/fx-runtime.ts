import { createHash } from "node:crypto";
import { z } from "zod";
import { a2aCliSource, A2A_CLI_PATH, A2A_CLI_SOURCE_PATH } from "@/lib/a2a-cli";
import { fxRunnerSource } from "@/lib/fx-runner";
import { capturePeerArtifact, type CapturedArtifact } from "@/lib/server/artifact-capture";
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
import { config, consoleAgentApiUrl } from "@/lib/server/config";
import { materializeMessageArtifacts } from "@/lib/server/message-runtime";
import { isMessageDeliveryPending, latestFxCompletionSessionId } from "@/lib/server/message-store";
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
      "model": "${config.defaultFxModel}"
    }
  ]
}
\`\`\`

The other request type is \`update-self\`; it accepts \`requestId\` and profile or runtime settings such as \`model\`, \`skills\`, and \`mcpServers\`. Network access can only be changed by the user in Agent settings. At most five requests are accepted per turn. Agent Console validates and applies them after your turn, then clears the file. Use \`.console/agents.json\` to inspect the current roster. Creating only a local process or subagent does not register a persistent Console agent.
`;
}

async function sandboxHome(sandbox: AgentSandbox): Promise<string> {
  const result = await sandbox.run({ command: 'printf "%s" "$HOME"' });
  const home = result.stdout.trim();
  if (result.exitCode !== 0 || !/^\/[A-Za-z0-9._/-]+$/.test(home) || home.split("/").includes("..")) {
    throw new Error("Sandbox returned an invalid home directory");
  }
  return home.replace(/\/$/, "");
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

  const home = await sandboxHome(sandbox);
  const prepare = await sandbox.run({ command: `mkdir -p '${home}/.fx'` });
  if (prepare.exitCode !== 0) throw new Error("Unable to prepare the fx profile directory");
  await sandbox.writeTextFile(`${home}/.fx/mcp.json`, fxMcpProfileConfig(agent));
}

export async function ensureFxInstalled(sandbox: AgentSandbox): Promise<void> {
  const binaryPath = fxBinaryPath(sandbox.root);
  const version = validateFxVersion(config.fxVersion);
  const probe = await sandbox.run({ command: `'${binaryPath}' --version` });
  if (probe.exitCode !== 0 || probe.stdout.trim().replace(/^v/, "") !== version.slice(1)) {
    const architecture = await sandbox.run({ command: "uname -m" });
    const target = { x86_64: "linux-x86_64", amd64: "linux-x86_64", aarch64: "linux-aarch64", arm64: "linux-aarch64" }[architecture.stdout.trim()];
    if (architecture.exitCode !== 0 || !target) throw new Error("Unsupported FX sandbox architecture");
    const name = `fx-${target}.tar.gz`;
    const base = fxReleaseBase(version);
    // Bootstrap downloads occur on the server: restricted agents never need
    // permanent GitHub access merely to install their runtime.
    const [archiveResponse, checksumResponse] = await Promise.all([
      fetch(`${base}/${name}`, { signal: AbortSignal.timeout(60_000) }),
      fetch(`${base}/${name}.sha256`, { signal: AbortSignal.timeout(60_000) }),
    ]);
    if (!archiveResponse.ok || !checksumResponse.ok) throw new Error(`Unable to download FX ${version}`);
    const archive = new Uint8Array(await archiveResponse.arrayBuffer());
    const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(checksum) || createHash("sha256").update(archive).digest("hex") !== checksum) {
      throw new Error("FX release checksum mismatch");
    }
    const archivePath = `${sandbox.root}/.console/fx-install.tar.gz`;
    await sandbox.writeBinaryFile(archivePath, archive);
    try {
      const install = await sandbox.run({ command: `set -eu
 tmp="$(mktemp -d)"
 trap 'rm -rf "$tmp"' EXIT
 tar -xzf '${archivePath}' -C "$tmp"
 mkdir -p '${sandbox.root}/.console/bin'
 install -m 0755 "$tmp/fx" '${binaryPath}.new'
 test "$('${binaryPath}.new' --version)" = '${version.slice(1)}'
 mv '${binaryPath}.new' '${binaryPath}'` });
      if (install.exitCode !== 0) throw new Error(`Unable to install FX ${version}`);
    } finally {
      await sandbox.removePath(archivePath, { force: true });
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

class InvalidControlRequests extends Error {
  constructor(readonly raw: string, cause: unknown) {
    super("Invalid FX control-plane requests", { cause });
  }
}

async function applyControlRequests(input: {
  ownerId: string;
  agent: AgentProfile;
  sandbox: AgentSandbox;
}): Promise<{ applied: Array<Record<string, unknown>>; currentAgent: AgentProfile }> {
  const raw = await input.sandbox.readTextFile(CONTROL_PATH);
  if (!raw?.trim()) return { applied: [], currentAgent: input.agent };
  let envelope: z.infer<typeof controlEnvelopeSchema>;
  try {
    if (raw.length > 64_000) throw new Error("FX control-plane outbox exceeds 64 KB");
    envelope = controlEnvelopeSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new InvalidControlRequests(raw, error);
  }
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
  artifacts?: CapturedArtifact[];
}

export interface RecoveredFxFailure {
  failed: true;
  content: string;
}

export function parseRunnerDelivery(raw: string): RecoveredFxCompletion | RecoveredFxFailure {
  const value = z.object({
    operation: z.enum(["complete", "fail"]),
    arguments: z.object({
      content: z.string().trim().min(1).max(100_000),
      session_id: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
      artifacts: z.array(z.object({ path: z.string(), content_base64: z.string().max(4_200_000) })).max(4).default([]),
    }),
  }).parse(JSON.parse(raw));
  if (value.operation === "fail") return { failed: true, content: value.arguments.content };
  if (!value.arguments.session_id) throw new Error("Runner completion is missing its session id");
  let total = 0;
  const artifacts = value.arguments.artifacts.map((file) => {
    const content = Buffer.from(file.content_base64, "base64");
    total += content.length;
    if (content.toString("base64") !== file.content_base64 || total > 3 * 1024 * 1024) {
      throw new Error("Runner artifacts are invalid or oversized");
    }
    return capturePeerArtifact({ path: file.path, content });
  });
  return { content: value.arguments.content, sessionId: value.arguments.session_id, artifacts };
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
}): Promise<"running" | RecoveredFxCompletion | RecoveredFxFailure | undefined> {
  const jobDirectory = `.console/jobs/${fxJobKey(input.incomingMessageId)}`;
  const pidFile = `${input.sandbox.root}/${jobDirectory}/worker.pid`;
  const state = await input.sandbox.run({
    command: `for file in '${pidFile}' '${input.sandbox.root}/${jobDirectory}/fx.pid'; do
  pid="$(cat "$file" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  if kill -0 "$pid" 2>/dev/null; then
    test -r "/proc/$pid/cmdline" || exit 1
    command_line="$(tr '\\0' ' ' < "/proc/$pid/cmdline")" || exit 1
    case "$command_line" in
      *'${jobDirectory}/runner.py'*|*'/.console/bin/fx ask'*) printf running; exit 0 ;;
    esac
  fi
done
printf stopped`,
  });
  if (state.exitCode !== 0 || !["running", "stopped"].includes(state.stdout.trim())) {
    throw new Error("Unable to determine FX worker state");
  }
  if (state.stdout.trim() === "running") return "running";

  const delivery = await input.sandbox.readTextFile(`${jobDirectory}/delivery.json`);
  if (delivery) {
    try {
      return parseRunnerDelivery(delivery);
    } catch {
      return { failed: true, content: "The FX worker produced an invalid final response or attachment. Inspect its private job logs and retry." };
    }
  }

  // A managed job with no payload never completed delivery preparation. Do not
  // turn an uncommitted result into success or silently drop its artifacts.
  const runner = await input.sandbox.readTextFile(`${jobDirectory}/runner.py`);
  if (runner) return { failed: true, content: "The FX worker stopped before delivering its result. Inspect its private job logs for details, then retry." };

  const home = await sandboxHome(input.sandbox);
  const located = await input.sandbox.run({
    command: `find '${home}/.fx/sessions' -mindepth 2 -maxdepth 2 -type f -name events.jsonl -exec grep -lF -- '${input.incomingMessageId}' {} + | sort`,
  });
  const eventPaths = located.stdout.trim().split("\n").filter(Boolean).reverse();
  for (const eventPath of eventPaths) {
    if (
      !eventPath.startsWith(`${home}/.fx/sessions/`) ||
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
  let previousSession = validSessionId(await latestFxCompletionSessionId({
    ownerId: input.ownerId,
    agentId: input.agent.id,
    conversationId: input.conversationId,
  }) ?? null);
  if (previousSession) {
    const home = await sandboxHome(input.sandbox);
    const eligible = await input.sandbox.run({
      command: `test -f '${home}/.fx/sessions/${previousSession}/session.json' && test ! -f '${home}/.fx/sessions/${previousSession}/subagent/control.json'`,
    });
    // Older completion callbacks could save a child session as the resume target.
    if (eligible.exitCode !== 0) previousSession = undefined;
  }
  const jobKey = fxJobKey(input.incomingMessageId);
  const jobDirectory = `.console/jobs/${jobKey}`;
  await input.sandbox.removePath(jobDirectory, { recursive: true, force: true });
  const prepared = await input.sandbox.run({
    command: `mkdir -p '${input.sandbox.root}/${jobDirectory}'`,
  });
  if (prepared.exitCode !== 0) throw new Error("Unable to prepare the FX job directory");
  await input.sandbox.writeTextFile(`${jobDirectory}/prompt.txt`, input.prompt);
  await input.sandbox.writeTextFile(`${jobDirectory}/runner.py`, fxRunnerSource());
  await input.sandbox.removePath(".console/artifacts.json", { force: true });

  const command = `set -eu
export PATH="${input.sandbox.root}/.console/bin:$PATH"
cd '${input.sandbox.root}'
exec python3 '${input.sandbox.root}/${jobDirectory}/runner.py' >'${input.sandbox.root}/${jobDirectory}/launcher.log' 2>&1`;
  const claims = {
    ownerId: input.ownerId,
    agentId: input.agent.id,
    conversationId: input.conversationId,
    incomingMessageId: input.incomingMessageId,
    incomingFromAgentId: input.incomingFromAgentId,
  };
  const messageToken = createAgentMessageToken({ ...claims, lifecycle: false });
  const lifecycleToken = createAgentMessageToken({ ...claims, lifecycle: true });

  try {
    await input.sandbox.setNetworkPolicy(
      input.agent.fxConfig.networkAccess,
      input.agent.fxConfig.networkAllowlist,
    );
    await materializeMessageArtifacts(
      { ownerId: input.ownerId, sandbox: input.sandbox },
      input.incomingMessageId,
    );
    if (!await isMessageDeliveryPending(input.ownerId, input.incomingMessageId, input.agent.id)) {
      throw new Error("The FX activation ended before its worker could start");
    }
    const process = await input.sandbox.spawn({
      command,
      env: {
        CONSOLE_MODEL_GATEWAY_URL: consoleAgentApiUrl().replace(/\/api\/a2a$/, "/api/model-gateway"),
        CONSOLE_A2A_TOKEN: messageToken,
        CONSOLE_LIFECYCLE_TOKEN: lifecycleToken,
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
  let control: Awaited<ReturnType<typeof applyControlRequests>>;
  try {
    control = await applyControlRequests(input);
  } catch (error) {
    if (!(error instanceof InvalidControlRequests)) throw error;
    // A malformed agent-authored file must not poison every later activation.
    // Persist it before removing the source; I/O or database failures still retry.
    const diagnosticPath = `.console/diagnostics/control-plane-${Date.now()}.json`;
    await input.sandbox.writeTextFile(diagnosticPath, JSON.stringify({
      error: error.cause instanceof Error ? error.cause.message : String(error.cause),
      raw: error.raw,
    }));
    await input.sandbox.removePath(CONTROL_PATH, { force: true });
    console.warn("agent-task.control.quarantined", { agentId: input.agent.id, diagnosticPath });
    control = { applied: [{ status: "rejected", diagnosticPath }], currentAgent: input.agent };
  }
  if (control.currentAgent.configVersion !== input.agent.configVersion) {
    await syncFxAgentConfig(input.sandbox, control.currentAgent, await listAgents(input.ownerId));
  }
  await Promise.all(
    [".console/inbox", ".console/outbox", ".console/artifacts.json"].map((path) =>
      input.sandbox.removePath(path, { recursive: true, force: true })
    ),
  );
  return control.applied;
}

/** Detect actual FX/runner command lines, not just recyclable PID files. */
export async function hasLiveFxWorker(sandbox: AgentSandbox): Promise<boolean> {
  const result = await sandbox.run({ command: `python3 - <<'PYWORKER'
import pathlib
root = ${JSON.stringify(sandbox.root)}
for path in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
    try:
        args = path.read_bytes().split(b'\\0')
        if any(arg.decode(errors='replace').startswith(root + '/.console/jobs/') and arg.endswith(b'/runner.py') for arg in args) or (args and args[0].decode(errors='replace') == root + '/.console/bin/fx' and b'ask' in args):
            print('running')
            break
    except (OSError, ProcessLookupError):
        pass
else:
    print('stopped')
PYWORKER` });
  if (result.exitCode !== 0 || !["running", "stopped"].includes(result.stdout.trim())) throw new Error("Unable to verify FX worker state");
  return result.stdout.trim() === "running";
}
