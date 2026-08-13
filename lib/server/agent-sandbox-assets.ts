import "server-only";

import {
  MAX_IMAGE_ARTIFACT_BYTES,
  MAX_TEXT_ARTIFACT_BYTES,
  RENDERABLE_ARTIFACT_EXTENSIONS,
} from "@/lib/artifact-kinds";

export interface AgentIdentity {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
}

/** Sentinels the orchestrator uses to extract the runner's structured result from stdout. */
export const RESULT_START = "@@AGENT_RESULT_START@@";
export const RESULT_END = "@@AGENT_RESULT_END@@";

/** Version of the provisioned runner assets. Bump to force a re-provision of running sandboxes. */
export const RUNTIME_VERSION = 2;

export function consolePlatformSkill(baseUrl: string): string {
  return `---
name: console-platform
description: Inspect and modify Console agents through the authenticated Console control-plane API.
---
# Console Platform

BASE_URL: \`${baseUrl}\`

You run inside a persistent Vercel Sandbox powered by the Vercel AI Gateway. Your durable
files (this workspace) are snapshotted between runs, so edits you make here survive. Use this
API whenever a user asks you to create, inspect, or modify a persistent Console agent. Your
Console platform token is passed to the runner and attached to these tools automatically —
never print or store it.

Your agent tools already wrap these endpoints:

- \`list_console_agents\` -> GET /api/agent-platform/agents
- \`create_console_agent\` -> POST /api/agent-platform/agents
- \`update_self\` -> PATCH /api/agent-platform/me
- \`send_channel_message\` -> POST /api/agent-platform/channels/{channelId}/messages

Prefer the wrapped tools. Creating files or processes in the sandbox does not add an agent to
Console; only \`create_console_agent\` does. Keep your database profile (\`update_self\`) and your
local \`.agents/AGENTS.md\` aligned when your operating instructions change.

## Durable local state

You may maintain your own files with \`read_file\`, \`write_file\`, and \`list_files\`:

- \`.agents/AGENTS.md\` for evolving operating instructions (loaded into your system prompt each run).
- \`.agents/skills/<skill-name>/SKILL.md\` for reusable skills.
- \`memory/\` for long-term notes and state.

## Sharing files with the channel

Console's "Shared files & links" panel can only render a fixed set of file types inline: Markdown,
plain text/code, JSON, CSV/TSV, and PNG/JPG/GIF/WEBP/SVG images (text/code files up to 256 KB,
images up to 5 MB). Writing a file with \`write_file\` does NOT share it — call \`share_artifact\`
with the workspace-relative path once the file exists to publish it to the channel. If you have a
deliverable in another format (PDF, zip, binary, spreadsheet, etc.), summarize or convert the
relevant parts into one of the renderable formats above before sharing, or describe it in your
message instead of calling \`share_artifact\` — a rejected/unrenderable share will not appear to
peers.
`;
}

export function baselineAgentsFile(agent: AgentIdentity, modelId: string): string {
  return `# ${agent.name}

Role: ${agent.specialty}

${agent.instructions}

Your Console agent ID is \`${agent.id}\`. You run on \`${modelId}\` through the Vercel AI Gateway
inside a persistent Vercel Sandbox. This file is your durable operating memory: edit it with
\`write_file\` as your instructions evolve, and use \`update_self\` to keep your Console profile in
sync. Use the console-platform skill for roster changes.
`;
}

export function runnerPackageJson(aiVersion: string, zodVersion: string): string {
  return JSON.stringify(
    {
      name: "console-agent-runner",
      private: true,
      type: "module",
      dependencies: { ai: aiVersion, zod: zodVersion },
    },
    null,
    2,
  );
}

/**
 * The agent loop that executes INSIDE the sandbox. It reads a task-input JSON file (argv[2]),
 * runs the AI SDK tool loop against the Vercel AI Gateway, and prints a structured result to
 * stdout between the RESULT sentinels. Tools let the agent edit its own durable files and call
 * the Console control-plane. Written with string concatenation only (no template literals) so it
 * can be embedded safely.
 */
export const AGENT_RUNNER_SOURCE = `import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const RESULT_START = ${JSON.stringify(RESULT_START)};
const RESULT_END = ${JSON.stringify(RESULT_END)};
const RENDERABLE_ARTIFACT_EXTENSIONS = ${JSON.stringify(RENDERABLE_ARTIFACT_EXTENSIONS)};
const MAX_TEXT_ARTIFACT_BYTES = ${JSON.stringify(MAX_TEXT_ARTIFACT_BYTES)};
const MAX_IMAGE_ARTIFACT_BYTES = ${JSON.stringify(MAX_IMAGE_ARTIFACT_BYTES)};
const run = promisify(exec);

async function main() {
  const inputPath = process.argv[2];
  const task = JSON.parse(await readFile(inputPath, "utf8"));
  const workspace = task.workspaceDir;
  const base = task.consoleBaseUrl;
  const token = task.agentToken;
  const channelId = task.channelId;

  function resolveInWorkspace(p) {
    const target = path.resolve(workspace, p || ".");
    if (target !== workspace && !target.startsWith(workspace + path.sep)) {
      throw new Error("Path escapes the agent workspace: " + p);
    }
    return target;
  }

  async function consoleFetch(pathname, init) {
    try {
      const res = await fetch(base + pathname, Object.assign({}, init, {
        headers: Object.assign(
          { Accept: "application/json", "Content-Type": "application/json", Authorization: "Bearer " + token },
          (init && init.headers) || {},
        ),
      }));
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 400) }; }
      if (!res.ok) return { ok: false, status: res.status, error: (json && json.error) || text.slice(0, 400) };
      return { ok: true, status: res.status, data: json };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const tools = {
    read_file: tool({
      description: "Read a UTF-8 file from your durable agent workspace.",
      inputSchema: z.object({ path: z.string() }),
      execute: async (args) => {
        try { return { path: args.path, content: await readFile(resolveInWorkspace(args.path), "utf8") }; }
        catch (e) { return { path: args.path, error: String((e && e.message) || e) }; }
      },
    }),
    write_file: tool({
      description: "Create or overwrite a UTF-8 file in your durable agent workspace. Use this to evolve your own .agents/AGENTS.md, skills, or memory.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async (args) => {
        try {
          const target = resolveInWorkspace(args.path);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, args.content, "utf8");
          return { path: args.path, bytes: Buffer.byteLength(args.content) };
        } catch (e) { return { path: args.path, error: String((e && e.message) || e) }; }
      },
    }),
    list_files: tool({
      description: "List files and directories under a path in your workspace.",
      inputSchema: z.object({ path: z.string().optional() }),
      execute: async (args) => {
        try {
          const entries = await readdir(resolveInWorkspace(args.path || "."), { withFileTypes: true });
          return { path: args.path || ".", entries: entries.map((e) => e.name + (e.isDirectory() ? "/" : "")) };
        } catch (e) { return { path: args.path || ".", error: String((e && e.message) || e) }; }
      },
    }),
    share_artifact: tool({
      description: "Publish a file already in your workspace to the channel's Shared files panel, where peers can preview it inline. Only Markdown, plain text/code, JSON, CSV/TSV, and PNG/JPG/GIF/WEBP/SVG images can be rendered there (text/code up to 256KB, images up to 5MB) - do not call this for any other file type; summarize or convert it instead.",
      inputSchema: z.object({ path: z.string(), title: z.string().optional() }),
      execute: async (args) => {
        try {
          const target = resolveInWorkspace(args.path);
          const stats = await stat(target);
          if (!stats.isFile()) return { ok: false, error: "That path is not a file" };
          const extension = path.extname(args.path).slice(1).toLowerCase();
          const rule = RENDERABLE_ARTIFACT_EXTENSIONS[extension];
          if (!rule) {
            return { ok: false, error: "Unsupported file type for the Shared files panel. Only Markdown, text/code, JSON, CSV/TSV, and PNG/JPG/GIF/WEBP/SVG images can be previewed - convert or summarize this file instead." };
          }
          const maxBytes = rule.previewKind === "image" ? MAX_IMAGE_ARTIFACT_BYTES : MAX_TEXT_ARTIFACT_BYTES;
          if (stats.size > maxBytes) {
            return { ok: false, error: "File is too large to preview (limit " + Math.round(maxBytes / 1024) + "KB for this type)" };
          }
          return {
            ok: true,
            path: args.path,
            title: (args.title || path.basename(args.path)).slice(0, 120),
            previewKind: rule.previewKind,
            mimeType: rule.mimeType,
            label: rule.label,
            size: stats.size,
          };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      },
    }),
    run_shell: tool({
      description: "Run a shell command inside your workspace sandbox and capture its output.",
      inputSchema: z.object({ command: z.string() }),
      execute: async (args) => {
        try {
          const out = await run(args.command, { cwd: workspace, timeout: 120000, maxBuffer: 1048576 });
          return { command: args.command, stdout: String(out.stdout).slice(0, 8000), stderr: String(out.stderr).slice(0, 4000) };
        } catch (e) {
          return { command: args.command, error: String((e && e.message) || e), stdout: String((e && e.stdout) || "").slice(0, 8000), stderr: String((e && e.stderr) || "").slice(0, 4000) };
        }
      },
    }),
    list_console_agents: tool({
      description: "List the persistent Console agents in your owner's roster.",
      inputSchema: z.object({}),
      execute: async () => consoleFetch("/api/agent-platform/agents", { method: "GET" }),
    }),
    create_console_agent: tool({
      description: "Create a persistent Console agent in your owner's roster. This is the only way to add a reusable agent; sandbox files do not count.",
      inputSchema: z.object({ name: z.string(), specialty: z.string(), instructions: z.string() }),
      execute: async (args) => consoleFetch("/api/agent-platform/agents", { method: "POST", body: JSON.stringify(args) }),
    }),
    update_self: tool({
      description: "Update your own Console profile (name, specialty, or instructions). Keep it aligned with your .agents/AGENTS.md.",
      inputSchema: z.object({ name: z.string().optional(), specialty: z.string().optional(), instructions: z.string().optional() }),
      execute: async (args) => consoleFetch("/api/agent-platform/me", { method: "PATCH", body: JSON.stringify(args) }),
    }),
    send_channel_message: tool({
      description: "Message a named peer in the current channel, or omit recipient to broadcast to the team.",
      inputSchema: z.object({ recipient: z.string().optional(), message: z.string() }),
      execute: async (args) => {
        if (!channelId) return { ok: false, error: "No active channel for peer messaging" };
        return consoleFetch("/api/agent-platform/channels/" + channelId + "/messages", { method: "POST", body: JSON.stringify(args) });
      },
    }),
  };

  let agentsMd = "";
  try { agentsMd = await readFile(resolveInWorkspace(".agents/AGENTS.md"), "utf8"); } catch (e) {}

  const system = task.instructions + (agentsMd ? ("\\n\\n# Your durable operating instructions (.agents/AGENTS.md)\\n" + agentsMd) : "");

  const result = await generateText({
    model: process.env.AGENT_MODEL_ID,
    system: system,
    prompt: task.prompt,
    tools: tools,
    stopWhen: stepCountIs(task.maxSteps || 24),
  });

  function kindForTool(name) {
    if (name === "run_shell") return "code";
    if (name === "read_file" || name === "write_file" || name === "list_files") return "code";
    if (name === "share_artifact") return "file";
    return "result";
  }

  const steps = [];
  for (const step of result.steps || []) {
    const resultsByCallId = new Map((step.toolResults || []).map((toolResult) => [toolResult.toolCallId, toolResult]));
    for (const call of step.toolCalls || []) {
      let detail = "";
      if (call.toolName === "share_artifact") {
        const toolResult = resultsByCallId.get(call.toolCallId);
        try { detail = JSON.stringify(toolResult ? toolResult.output : { ok: false }); } catch (e) {}
      } else {
        try { detail = JSON.stringify(call.input); } catch (e) {}
      }
      steps.push({ kind: kindForTool(call.toolName), label: String(call.toolName).split("_").join(" "), detail: detail.slice(0, 400) });
    }
  }

  const output = String(result.text || "").trim();
  process.stdout.write(RESULT_START + JSON.stringify({ output: output, steps: steps }) + RESULT_END);
}

main().catch((error) => {
  process.stdout.write(RESULT_START + JSON.stringify({ output: "", steps: [], error: String((error && error.message) || error) }) + RESULT_END);
  process.exit(1);
});
`;
