/**
 * Real local FX smoke. Start Next locally with the same environment first, then:
 * CONSOLE_AGENT_API_URL=http://host.microsandbox.internal:3000/api/a2a \
 * node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/smoke-fx.ts
 * Uses a disposable Microsandbox and owner. Never activates existing agents.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { Sandbox } from "microsandbox";
import { acquireAgentSandbox, type AgentSandbox } from "../lib/server/agent-sandbox.ts";
import { withAgentLifecycleLock } from "../lib/server/agent-lifecycle.ts";
import { createAgent } from "../lib/server/agent-store.ts";
import { createConversation } from "../lib/server/conversation-store.ts";
import { config, consoleAgentApiUrl, requireDatabaseUrl } from "../lib/server/config.ts";
import { createAgentMessageToken } from "../lib/server/message-auth.ts";
import { latestFxCompletionSessionId, listMessageArtifacts, publishConversationMessage } from "../lib/server/message-store.ts";
import { dispatchNextAgentTask } from "../lib/server/task-dispatcher.ts";

assert.equal(Boolean(process.env.VERCEL), false, "This smoke test requires the local Microsandbox backend");
assert.equal(config.e2eFakeFx, false, "Disable E2E_FAKE_FX for a real smoke test");
assert.equal(new URL(consoleAgentApiUrl()).hostname, "host.microsandbox.internal", "Point CONSOLE_AGENT_API_URL at the local Next server");
const ownerId = `smoke-fx-${crypto.randomUUID()}`;
const sql = neon(requireDatabaseUrl());
let sandbox: AgentSandbox | undefined;
let lastMessageId: string | undefined;
let agentId: string | undefined;

async function pause(ms: number) { await new Promise((resolve) => setTimeout(resolve, ms)); }

try {
  const agent = await createAgent(ownerId, {
    name: "FX smoke", specialty: "Disposable local runtime verification", networkAccess: "none",
    instructions: "Complete the exact smoke checks requested. Do not delegate. Use terminal commands when requested. Never print environment secrets. Return only the requested short final answer.",
  });
  agentId = agent.id;
  const conversation = await createConversation(ownerId, agent.id);
  sandbox = await acquireAgentSandbox({ ownerId, agent });
  console.log("smoke-fx.created", { ownerId, sandbox: sandbox.id, version: config.fxVersion, model: agent.fxConfig.model });
  const denied = await sandbox.run({ command: "python3 - <<'PY'\nimport urllib.request, sys\ntry:\n    urllib.request.urlopen('https://example.com', timeout=5)\nexcept Exception:\n    print('NETWORK_BLOCKED')\n    sys.exit(0)\nsys.exit(1)\nPY" });
  assert.equal(denied.exitCode, 0, "Network none allowed unrelated public egress");
  assert.match(denied.stdout, /NETWORK_BLOCKED/);
  const firstPrompt = `Run a terminal Python command to assert os.environ.get('AI_GATEWAY_API_KEY') == 'console-task-proxy' and 'CONSOLE_LIFECYCLE_TOKEN' not in os.environ. Do not print environment variables. In that same command create .console/outbox/smoke.md containing exactly '# Smoke\\n6 * 7 = 42\\nCredential check passed\\n' (with actual newlines), create .console/artifacts.json containing [".console/outbox/smoke.md"], and create smoke-marker.txt containing purple-otter-42. Return the final answer: SMOKE_OK 42. You must run the assertions and create the files before answering.`;
  const prompts = [firstPrompt,
    "Resume the previous task. Read smoke-marker.txt, confirm it contains purple-otter-42, then return exactly RESUME_OK purple-otter-42. Do not create attachments on this turn."];
  let previousSession: string | undefined;
  for (let index = 0; index < prompts.length; index++) {
    const incoming = await publishConversationMessage({ ownerId, conversationId: conversation.id,
      senderType: "human", senderId: ownerId, recipientType: "agent", recipientId: agent.id, content: prompts[index],
    });
    lastMessageId = incoming.id;
    const launched = await dispatchNextAgentTask({ ownerId, agentId: agent.id });
    assert.notEqual(launched.status, "failed", JSON.stringify(launched));
    console.log("smoke-fx.started", { turn: index + 1, status: launched.status });
    const deadline = Date.now() + 240_000;
    let row: { state: string; model_request_count: number; settled_at: string | null } | undefined;
    while (Date.now() < deadline) {
      [row] = await sql.query(`SELECT state, model_request_count, settled_at FROM message_deliveries WHERE owner_id=$1 AND message_id=$2`, [ownerId, incoming.id]) as typeof row[];
      if (row && ["completed", "failed"].includes(row.state) && row.settled_at) break;
      await pause(1500);
    }
    assert.equal(row?.state, "completed", "FX did not complete; private job logs are retained until cleanup");
    assert.ok(row.settled_at, "The completion callback did not settle its job");
    assert.ok(row.model_request_count > 0, "The real model Gateway was not used");
    const replies = await sql.query(`SELECT id, content FROM conversation_messages WHERE owner_id=$1 AND in_reply_to=$2 AND metadata->>'sessionId' IS NOT NULL`, [ownerId, incoming.id]);
    const reply = replies[0] as { id: string; content: string };
    assert.match(reply.content, index === 0 ? /SMOKE_OK\s+42/ : /RESUME_OK\s+purple-otter-42/);
    const session = await latestFxCompletionSessionId({ ownerId, agentId: agent.id, conversationId: conversation.id });
    assert.ok(session);
    if (previousSession) assert.equal(session, previousSession, "Follow-up did not resume the parent session");
    previousSession = session;
    if (index === 0) {
      const artifacts = await listMessageArtifacts(ownerId, reply.id);
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].name, "smoke.md");
    }
    const token = createAgentMessageToken({ ownerId, agentId: agent.id, conversationId: conversation.id, incomingMessageId: incoming.id, lifecycle: false });
    const port = new URL(consoleAgentApiUrl()).port || "3000";
    const stale = await fetch(`http://127.0.0.1:${port}/api/model-gateway/coding-agent/v1/models`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stale.status, 403, "Finished task retained model access");
    console.log("smoke-fx.completed", { turn: index + 1, modelRequests: row.model_request_count, resumed: index > 0, callback: "verified" });
  }
  console.log("smoke-fx.passed", { checks: ["real-model", "terminal", "credential-scope", "artifact", "callback", "resume", "revocation", "network-none"] });
} catch (error) {
  if (sandbox && lastMessageId) {
    const key = createHash("sha256").update(lastMessageId).digest("hex").slice(0, 24);
    const diagnostic = await sandbox.readTextFile(`.console/jobs/${key}/runner-error.log`).catch(() => null);
    if (diagnostic) console.error("smoke-fx.worker-error", diagnostic.slice(0, 500));
  }
  throw error;
} finally {
  if (sandbox && agentId) {
    const disposable = sandbox;
    await withAgentLifecycleLock({ ownerId, agentId }, async () => {
      await disposable.stop().catch(() => undefined);
      await Sandbox.remove(disposable.id).catch((error) => console.error("smoke-fx.sandbox-cleanup-failed", String(error)));
    });
  }
  await sql.query("DELETE FROM agent_events WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM conversations WHERE owner_id=$1", [ownerId]);
  await sql.query("DELETE FROM agents WHERE owner_id=$1", [ownerId]);
  console.log("smoke-fx.cleaned", { ownerId, agentId });
}
