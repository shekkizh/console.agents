import { withAgentLifecycleLock } from "@/lib/server/agent-lifecycle";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { NetworkPolicy as VercelNetworkPolicy } from "@vercel/sandbox";
import { consoleAgentApiHost } from "@/lib/server/config";
import { FX_SANDBOX_TIMEOUT_MS } from "@/lib/fx-runtime-constants";
import type { AgentProfile, FxNetworkAccess } from "@/lib/types";

const AI_GATEWAY_HOST = "ai-gateway.vercel.sh";
const SANDBOX_IMAGE = process.env.MICROSANDBOX_IMAGE ?? "python:3.13-bookworm";
const VERCEL_ACQUIRE_TIMEOUT_MS = 60_000;
const VERCEL_COMMAND_TIMEOUT_MS = 120_000;
const VERCEL_SPAWN_TIMEOUT_MS = 60_000;
const acquireLocks = new Map<string, Promise<AgentSandbox>>();

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentSandbox {
  readonly id: string;
  readonly root: string;
  run(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<SandboxCommandResult>;
  spawn(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<{ id: string; pid?: number }>;
  readTextFile(path: string): Promise<string | null>;
  writeTextFile(path: string, content: string): Promise<void>;
  writeBinaryFile(path: string, content: Uint8Array): Promise<void>;
  removePath(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  setNetworkPolicy(access: FxNetworkAccess, allowlist: string[]): Promise<void>;
  stop(): Promise<void>;
}

function stableSandboxName(ownerId: string, agentId: string): string {
  const suffix = createHash("sha256")
    .update(ownerId + "\0" + agentId)
    .digest("hex")
    .slice(0, 32);
  return "console-agent-" + suffix;
}

function runtimeKey(agent: AgentProfile): string {
  return createHash("sha256")
    .update(JSON.stringify({
      adapterVersion: 3,
      image: SANDBOX_IMAGE,
      networkAccess: agent.fxConfig.networkAccess,
      networkAllowlist: agent.fxConfig.networkAllowlist,
    }))
    .digest("hex")
    .slice(0, 20);
}

function allowedDomains(access: FxNetworkAccess, allowlist: string[]): string[] {
  if (access === "full") return [];
  return [
    AI_GATEWAY_HOST,
    consoleAgentApiHost(),
    ...(access === "allowlist" ? allowlist : []),
  ];
}

function vercelNetworkPolicy(
  access: FxNetworkAccess,
  allowlist: string[],
): VercelNetworkPolicy {
  return access === "full" ? "allow-all" : { allow: allowedDomains(access, allowlist) };
}

function resolvedPath(root: string, value: string): string {
  if (value.startsWith("/")) return value;
  const normalized = value.replace(/^\.\/+/, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Sandbox path is invalid");
  }
  return root + "/" + normalized;
}

async function withVercelTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function acquireVercelSandbox(
  ownerId: string,
  agent: AgentProfile,
): Promise<AgentSandbox> {
  const { Sandbox } = await import("@vercel/sandbox");
  const name = stableSandboxName(ownerId, agent.id);
  console.info("agent-sandbox.acquire.started", { sandbox: name, backend: "vercel" });
  const sandbox = await withVercelTimeout(
    "Vercel sandbox acquisition",
    VERCEL_ACQUIRE_TIMEOUT_MS,
    (signal) => Sandbox.getOrCreate({
      name,
      image: "vercel/sandbox/universal:latest",
      timeout: FX_SANDBOX_TIMEOUT_MS,
      persistent: true,
      keepLastSnapshots: {
        count: 1,
        expiration: 7 * 24 * 60 * 60_000,
        deleteEvicted: true,
      },
      networkPolicy: vercelNetworkPolicy(
        agent.fxConfig.networkAccess,
        agent.fxConfig.networkAllowlist,
      ),
      tags: {
        application: "agent-console",
        agent: createHash("sha256").update(agent.id).digest("hex").slice(0, 24),
      },
      resume: true,
      signal,
    }),
  );
  console.info("agent-sandbox.acquire.completed", {
    sandbox: name,
    backend: "vercel",
    status: sandbox.status,
  });
  const root = sandbox.cwd || "/vercel/sandbox";

  return {
    id: sandbox.name,
    root,
    async run(input) {
      const result = await withVercelTimeout(
        "Vercel sandbox command",
        VERCEL_COMMAND_TIMEOUT_MS,
        (signal) => sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", input.command],
          cwd: input.cwd ?? root,
          env: input.env,
          signal,
          timeoutMs: VERCEL_COMMAND_TIMEOUT_MS,
        }),
      );
      return {
        exitCode: result.exitCode,
        stdout: await result.stdout(),
        stderr: await result.stderr(),
      };
    },
    async spawn(input) {
      const command = await withVercelTimeout(
        "Vercel sandbox process launch",
        VERCEL_SPAWN_TIMEOUT_MS,
        (signal) => sandbox.runCommand({
          cmd: "bash",
          args: ["-lc", input.command],
          cwd: input.cwd ?? root,
          env: input.env,
          detached: true,
          signal,
        }),
      );
      return { id: command.cmdId };
    },
    async readTextFile(path) {
      const content = await sandbox.readFileToBuffer({ path: resolvedPath(root, path) });
      return content?.toString("utf8") ?? null;
    },
    async writeTextFile(path, content) {
      const target = resolvedPath(root, path);
      const prepared = await sandbox.runCommand("mkdir", ["-p", posix.dirname(target)]);
      if (prepared.exitCode !== 0) throw new Error("Unable to prepare sandbox file directory");
      await sandbox.writeFiles([{ path: target, content }]);
    },
    async writeBinaryFile(path, content) {
      const target = resolvedPath(root, path);
      const prepared = await sandbox.runCommand("mkdir", ["-p", posix.dirname(target)]);
      if (prepared.exitCode !== 0) throw new Error("Unable to prepare sandbox file directory");
      await sandbox.writeFiles([{ path: target, content }]);
    },
    async removePath(path, options) {
      const flags = [
        ...(options?.recursive ? ["-r"] : []),
        ...(options?.force ? ["-f"] : []),
        "--",
        resolvedPath(root, path),
      ];
      const result = await sandbox.runCommand("rm", flags);
      if (result.exitCode !== 0) {
        throw new Error((await result.stderr()).trim() || "Unable to remove " + path);
      }
    },
    async setNetworkPolicy(access, allowlist) {
      await sandbox.updateNetworkPolicy(vercelNetworkPolicy(access, allowlist));
    },
    async stop() {
      if (sandbox.status === "running") await sandbox.stop();
    },
  };
}

async function acquireMicrosandbox(
  ownerId: string,
  agent: AgentProfile,
): Promise<AgentSandbox> {
  const {
    Destination,
    NetworkPolicy,
    Rule,
    Sandbox,
    SandboxNotFoundError,
    Snapshot,
  } = await import("microsandbox");
  const name = stableSandboxName(ownerId, agent.id);
  const key = runtimeKey(agent);
  let local: import("microsandbox").Sandbox | undefined;
  let preservedSnapshot: string | undefined;

  try {
    const handle = await Sandbox.get(name);
    const existing = handle.config() as { labels?: Record<string, string> };
    if (existing.labels?.["console.runtime"] !== key) {
      if (handle.status === "running") {
        const connected = await handle.connect();
        const live = await connected.shell("python3 - <<'PY'\nimport pathlib\nprint(any(b'/.console/jobs/' in p.read_bytes() and b'/runner.py' in p.read_bytes() or b'/.console/bin/fx\\x00ask' in p.read_bytes() for p in pathlib.Path('/proc').glob('[0-9]*/cmdline') if p.exists()))\nPY");
        if (live.code !== 0) throw new Error("Unable to inspect sandbox before configuration update");
        if (live.stdout().trim() === "True") local = connected;
      }
      if (!local) {
        if (handle.status === "running" || handle.status === "draining") await handle.stop();
        // Keep a durable snapshot before replacing an immutable local VM policy.
        // FX version changes are deliberately excluded from this configuration key.
        preservedSnapshot = `${name}-config-${Date.now()}`;
        await handle.snapshot(preservedSnapshot);
        await handle.remove();
      }
    } else {
      local = handle.status === "running"
        ? await handle.connect()
        : await handle.startDetached();
    }
  } catch (error) {
    if (!(error instanceof SandboxNotFoundError)) throw error;
    // Resume an interrupted policy migration from its newest preserved workspace.
    const backups = (await Snapshot.list()).filter((item) => item.name?.startsWith(`${name}-config-`));
    backups.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    preservedSnapshot = backups[0]?.path;
  }

  if (!local) {
    const access = agent.fxConfig.networkAccess;
    const domains = allowedDomains(access, agent.fxConfig.networkAllowlist);
    const policy = access === "full"
      ? NetworkPolicy.allowAll()
      : {
          defaultEgress: "deny" as const,
          defaultIngress: "allow" as const,
          rules: [
            Rule.allowDns(),
            Rule.allowEgress(Destination.group("host")),
            ...domains.map((domain) =>
              domain.startsWith("*.")
                ? Rule.allowEgress(Destination.domainSuffix(domain.slice(1)))
                : Rule.allowEgress(Destination.domain(domain))
            ),
          ],
        };
    const builder = Sandbox.builder(name);
    if (preservedSnapshot) builder.fromSnapshot(preservedSnapshot);
    else builder.image(SANDBOX_IMAGE);
    local = await builder
      .pullPolicy("if-missing")
      .cpus(1)
      .memory(2048)
      .workdir("/")
      .detached(true)
      .maxDuration(Math.ceil(FX_SANDBOX_TIMEOUT_MS / 1_000))
      .label("console.runtime", key)
      .network((network) => network.policy(policy))
      .create();
  }

  const root = "/workspace";
  const ready = await local.shell("mkdir -p /workspace");
  if (ready.code !== 0) throw new Error(ready.stderr());

  return {
    id: name,
    root,
    async run(input) {
      const result = await local.execWith("bash", (command) =>
        command
          .args(["-lc", input.command])
          .cwd(input.cwd ?? root)
          .envs(input.env ?? {})
      );
      return { exitCode: result.code, stdout: result.stdout(), stderr: result.stderr() };
    },
    async spawn(input) {
      const handle = await local.execStreamWith("bash", (command) =>
        command
          .args(["-lc", input.command])
          .cwd(input.cwd ?? root)
          .envs(input.env ?? {})
      );
      const started = await handle.recv();
      if (!started || started.kind !== "started") {
        await handle.kill().catch(() => undefined);
        throw new Error("Sandbox worker did not start");
      }
      void handle.wait().catch(() => undefined);
      return { id: String(started.pid), pid: started.pid };
    },
    async readTextFile(path) {
      const target = resolvedPath(root, path);
      if (!await local.fs().exists(target)) return null;
      return local.fs().readToString(target);
    },
    async writeTextFile(path, content) {
      const target = resolvedPath(root, path);
      const prepared = await local.exec("mkdir", ["-p", posix.dirname(target)]);
      if (prepared.code !== 0) throw new Error("Unable to prepare sandbox file directory");
      await local.fs().write(target, content);
    },
    async writeBinaryFile(path, content) {
      const target = resolvedPath(root, path);
      const prepared = await local.exec("mkdir", ["-p", posix.dirname(target)]);
      if (prepared.code !== 0) throw new Error("Unable to prepare sandbox file directory");
      await local.fs().write(target, content);
    },
    async removePath(path, options) {
      const flags = [
        ...(options?.recursive ? ["-r"] : []),
        ...(options?.force ? ["-f"] : []),
        "--",
        resolvedPath(root, path),
      ];
      const result = await local.exec("rm", flags);
      if (result.code !== 0) {
        throw new Error(result.stderr() || "Unable to remove " + path);
      }
    },
    async setNetworkPolicy() {
      // Local policies are immutable; acquisition snapshots and restores the
      // workspace when policy changes, before any new worker starts.
    },
    async stop() {
      await local.stop();
    },
  };
}

export async function acquireAgentSandbox(input: {
  ownerId: string;
  agent: AgentProfile;
}): Promise<AgentSandbox> {
  const key = input.ownerId + "\0" + input.agent.id;
  const existing = acquireLocks.get(key);
  if (existing) return existing;
  const pending = (process.env.VERCEL
    ? acquireVercelSandbox(input.ownerId, input.agent)
    : acquireMicrosandbox(input.ownerId, input.agent))
    .finally(() => acquireLocks.delete(key));
  acquireLocks.set(key, pending);
  return pending;
}

export async function cancelSandboxTask(input: {
  ownerId: string;
  agent: AgentProfile;
  messageId: string;
}): Promise<void> {
  return withAgentLifecycleLock({ ownerId: input.ownerId, agentId: input.agent.id }, async () => {
    const sandbox = await acquireAgentSandbox(input);
    const jobKey = createHash("sha256").update(input.messageId).digest("hex").slice(0, 24);
    const result = await sandbox.run({ command: `python3 - <<'PYCANCEL'
import os, pathlib, signal, time
root = ${JSON.stringify(sandbox.root)}
job = pathlib.Path(root) / '.console/jobs' / '${jobKey}'
message = ${JSON.stringify(input.messageId)}
def verified(pid, role):
    try:
        args = pathlib.Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\\0')
        if role == 'worker':
            return str(job / 'runner.py').encode() in args
        return args[0] == (root + '/.console/bin/fx').encode() and b'ask' in args and any(('messageId: ' + message).encode() in arg for arg in args)
    except (OSError, IndexError):
        return False
processes = []
for role in ['worker', 'fx']:
    try:
        pid = int((job / (role + '.pid')).read_text().strip())
        if pid > 1 and verified(pid, role):
            processes.append((pid, role))
    except (OSError, ValueError):
        pass
for sig in [signal.SIGTERM, signal.SIGKILL]:
    for pid, role in processes:
        if verified(pid, role):
            try:
                if role == 'fx' and os.getpgid(pid) == pid: os.killpg(pid, sig)
                else: os.kill(pid, sig)
            except ProcessLookupError: pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and any(verified(pid, role) for pid, role in processes): time.sleep(.05)
if any(verified(pid, role) for pid, role in processes): raise RuntimeError('FX worker did not stop')
PYCANCEL` });
    if (result.exitCode !== 0) throw new Error("Unable to stop the correlated FX worker");
  });
}
