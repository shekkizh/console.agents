import { expect, test } from "@playwright/test";
import { neon } from "@neondatabase/serverless";
import type { AgentProfile, ConversationProfile } from "../../lib/types";
import { E2E_BASE_URL, E2E_OWNER_ID, E2E_TOKEN } from "./constants";
import { requireDatabaseUrl } from "../../lib/server/config";
import { createAgentMessageToken } from "../../lib/server/message-auth";
import {
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "../../lib/server/message-store";

function database() {
  return neon(requireDatabaseUrl());
}

async function clearE2ERows() {
  const sql = database();
  await sql.query("DELETE FROM agent_events WHERE owner_id = $1", [E2E_OWNER_ID]);
  await sql.query("DELETE FROM conversations WHERE owner_id = $1", [E2E_OWNER_ID]);
  await sql.query("DELETE FROM agents WHERE owner_id = $1", [E2E_OWNER_ID]);
}

test.beforeEach(clearE2ERows);
test.afterEach(clearE2ERows);

test("runs one FIFO inbox per agent after the browser disconnects", async ({ browser }) => {
  const unauthorized = await fetch(`${E2E_BASE_URL}/api/conversations`, {
    headers: { authorization: "Bearer deliberately-wrong-token" },
  });
  expect(unauthorized.status).toBe(401);

  const context = await browser.newContext({
    extraHTTPHeaders: test.info().project.use.extraHTTPHeaders,
  });
  const page = await context.newPage();
  await page.goto("/");

  const composer = page.getByRole("textbox", { name: "Message General" });
  const send = page.getByRole("button", { name: "Send message" });
  const firstPrompt = "E2E_FAKE delay=3000 reply=E2E_ALPHA";
  const secondPrompt = "E2E_FAKE delay=10 reply=E2E_BETA";

  await composer.fill(firstPrompt);
  await send.click();
  await composer.fill(secondPrompt);
  await send.click();

  const sql = database();
  await expect.poll(async () => {
    const rows = await sql.query(
      `SELECT
         count(*) FILTER (WHERE state IN ('claimed', 'running'))::int AS active,
         count(*) FILTER (WHERE state = 'queued')::int AS queued
       FROM message_deliveries
       WHERE owner_id = $1 AND recipient_type = 'agent'`,
      [E2E_OWNER_ID],
    );
    return rows[0];
  }).toEqual({ active: 1, queued: 1 });

  await page.close();
  await expect.poll(async () => {
    const rows = await sql.query(
      `SELECT content
       FROM conversation_messages
       WHERE owner_id = $1
         AND sender_type = 'agent' AND recipient_type = 'human'
       ORDER BY created_at ASC, id ASC`,
      [E2E_OWNER_ID],
    );
    return rows.map((row) => row.content);
  }).toEqual(["E2E_ALPHA", "E2E_BETA"]);

  const resumed = await context.newPage();
  await resumed.goto("/");
  await expect(
    resumed.locator("article.message.assistant:not(.pending) .message-copy"),
  ).toHaveText(["E2E_ALPHA", "E2E_BETA"]);
  await expect(resumed.getByText("Ready", { exact: true })).toBeVisible();
  await context.close();
});

test("runs different registered agents concurrently", async ({ request }) => {
  const agents = await Promise.all([
    request.post("/api/agents", {
      data: {
        name: "Parallel Alpha",
        specialty: "First parallel worker",
        instructions: "Complete deterministic integration work.",
      },
    }),
    request.post("/api/agents", {
      data: {
        name: "Parallel Beta",
        specialty: "Second parallel worker",
        instructions: "Complete deterministic integration work.",
      },
    }),
  ]);
  expect(agents.every((response) => response.status() === 201)).toBe(true);
  const profiles = await Promise.all(agents.map((response) => response.json() as Promise<AgentProfile>));
  const conversations = await Promise.all(profiles.map(async (agent) => {
    const response = await request.post("/api/conversations", { data: { agentId: agent.id } });
    expect(response.status()).toBe(201);
    return response.json() as Promise<ConversationProfile>;
  }));

  await Promise.all(conversations.map((conversation, index) =>
    request.post(`/api/conversations/${conversation.id}/messages`, {
      data: {
        id: crypto.randomUUID(),
        content: `E2E_FAKE delay=3000 reply=PARALLEL_${index}`,
      },
    })
  ));

  const sql = database();
  await expect.poll(async () => {
    const rows = await sql.query(
      `SELECT count(*)::int AS active
       FROM message_deliveries
       WHERE owner_id = $1 AND recipient_type = 'agent'
         AND state IN ('claimed', 'running')`,
      [E2E_OWNER_ID],
    );
    return rows[0]?.active;
  }).toBe(2);
  await expect.poll(async () => {
    const rows = await sql.query(
      `SELECT content FROM conversation_messages
       WHERE owner_id = $1 AND sender_type = 'agent' AND recipient_type = 'human'
       ORDER BY content`,
      [E2E_OWNER_ID],
    );
    return rows.map((row) => row.content);
  }).toEqual(["PARALLEL_0", "PARALLEL_1"]);
});

test("accepts signed progress and idempotent completion callbacks", async ({ request }) => {
  const agentsResponse = await request.get("/api/agents");
  const agent = ((await agentsResponse.json()) as { agents: AgentProfile[] }).agents[0]!;
  const conversationResponse = await request.post("/api/conversations", {
    data: { agentId: agent.id },
  });
  const conversation = (await conversationResponse.json()) as ConversationProfile;
  const task = await publishConversationMessage({
    ownerId: E2E_OWNER_ID,
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    senderType: "human",
    senderId: E2E_OWNER_ID,
    recipientType: "agent",
    recipientId: agent.id,
    content: "Exercise the signed callback path.",
  });
  expect((await nextPendingAgentMessage({
    ownerId: E2E_OWNER_ID,
    agentId: agent.id,
  }))?.id).toBe(task.id);
  await markMessageDelivery(E2E_OWNER_ID, task.id, agent.id, "running");

  const headers = {
    authorization: `Bearer ${createAgentMessageToken({
      ownerId: E2E_OWNER_ID,
      agentId: agent.id,
      conversationId: conversation.id,
      incomingMessageId: task.id,
      lifecycle: true,
    })}`,
  };
  const progress = await request.post("/api/a2a", {
    headers,
    data: {
      operation: "progress",
      arguments: { content: "The callback is connected.", idempotency_key: "connected" },
    },
  });
  expect(progress.status()).toBe(200);

  const completionBody = {
    operation: "complete",
    arguments: {
      content: "The signed callback completed successfully.",
      session_id: "e2e-callback-session",
    },
  };
  const agentToken = createAgentMessageToken({
    ownerId: E2E_OWNER_ID, agentId: agent.id, conversationId: conversation.id,
    incomingMessageId: task.id, lifecycle: false,
  });
  for (const operation of ["complete", "fail"]) {
    const denied = await request.post("/api/a2a", {
      headers: { authorization: `Bearer ${agentToken}` },
      data: { operation, arguments: { content: "A subagent must not settle its parent" } },
    });
    expect(denied.status()).toBe(403);
  }
  const completion = await request.post("/api/a2a", { headers, data: completionBody });
  expect(completion.status()).toBe(200);
  expect((await completion.json()).status).toBe("completed");
  const retry = await request.post("/api/a2a", { headers, data: completionBody });
  expect(retry.status()).toBe(200);
  expect((await retry.json()).status).toBe("already_completed");

  const rows = await database().query(
    `SELECT state FROM message_deliveries
     WHERE owner_id = $1 AND message_id = $2`,
    [E2E_OWNER_ID, task.id],
  );
  expect(rows[0]?.state).toBe("completed");
  for (const operation of ["list", "send", "wait", "progress"]) {
    const stale = await request.post("/api/a2a", {
      headers: { authorization: `Bearer ${agentToken}` },
      data: { operation, arguments: {} },
    });
    expect(stale.status()).toBe(403);
  }
});


test("manual recovery handles a committed request without a dispatch callback", async ({ request }) => {
  const agent = ((await (await request.get("/api/agents")).json()) as { agents: AgentProfile[] }).agents[0]!;
  const conversation = await (await request.post("/api/conversations", { data: { agentId: agent.id } })).json() as ConversationProfile;
  const message = await publishConversationMessage({
    ownerId: E2E_OWNER_ID, conversationId: conversation.id,
    senderType: "human", senderId: E2E_OWNER_ID,
    recipientType: "agent", recipientId: agent.id,
    content: "E2E_FAKE delay=10 reply=CRON_RECOVERED",
  });
  // General is protected; a rejected deletion must not cancel its queued task.
  expect((await request.delete(`/api/agents/${agent.id}`)).status()).toBe(400);
  const before = await database().query("SELECT state FROM message_deliveries WHERE owner_id=$1 AND message_id=$2", [E2E_OWNER_ID, message.id]);
  expect(before[0]?.state).toBe("queued");
  const recovered = await request.get("/api/internal/reconcile", { headers: { authorization: `Bearer ${E2E_TOKEN}` } });
  expect(recovered.status()).toBe(200);
  const rows = await database().query("SELECT content FROM conversation_messages WHERE owner_id=$1 AND in_reply_to=$2", [E2E_OWNER_ID, message.id]);
  expect(rows.map((row) => row.content)).toEqual(["CRON_RECOVERED"]);
  const replay = await request.get("/api/internal/reconcile", { headers: { authorization: `Bearer ${E2E_TOKEN}` } });
  expect(replay.status()).toBe(200);
  const count = await database().query("SELECT count(*)::int AS replies FROM conversation_messages WHERE owner_id=$1 AND in_reply_to=$2", [E2E_OWNER_ID, message.id]);
  expect(count[0]?.replies).toBe(1);
});

test("a signed peer result ends in a processing note instead of another peer request", async ({ request }) => {
  const a = ((await (await request.get("/api/agents")).json()) as { agents: AgentProfile[] }).agents[0]!;
  const b = await (await request.post("/api/agents", { data: {
    name: "Peer reviewer", specialty: "Review", instructions: "Review the requested implementation",
  } })).json() as AgentProfile;
  const conversation = await (await request.post("/api/conversations", { data: { agentId: a.id } })).json() as ConversationProfile;
  const task = await publishConversationMessage({
    ownerId: E2E_OWNER_ID, conversationId: conversation.id,
    senderType: "agent", senderId: a.id, recipientType: "agent", recipientId: b.id,
    content: "Review this implementation",
  });
  await nextPendingAgentMessage({ ownerId: E2E_OWNER_ID, agentId: b.id });
  const headers = { authorization: `Bearer ${createAgentMessageToken({
    ownerId: E2E_OWNER_ID, agentId: b.id, conversationId: conversation.id,
    incomingMessageId: task.id, lifecycle: true,
  })}` };
  const body = { operation: "complete", arguments: {
    content: "E2E_FAKE delay=0 reply=REVIEW_PROCESSED", session_id: "peer-review-session",
  } };
  expect((await request.post("/api/a2a", { headers, data: body })).status()).toBe(200);
  // No browser refresh or cron: the completion callback dispatches the late reply.
  await expect.poll(async () => {
    const rows = await database().query("SELECT count(*)::int AS count FROM conversation_messages WHERE owner_id=$1 AND conversation_id=$2 AND metadata->>'messagePurpose'='receipt'", [E2E_OWNER_ID, conversation.id]);
    return rows[0]?.count;
  }).toBe(1);
  expect((await request.post("/api/a2a", { headers, data: body })).status()).toBe(200);
  const rows = await database().query("SELECT sender_id,recipient_id,metadata->>'messagePurpose' AS purpose FROM conversation_messages WHERE owner_id=$1 AND conversation_id=$2 ORDER BY created_at", [E2E_OWNER_ID, conversation.id]);
  expect(rows).toEqual([
    { sender_id: a.id, recipient_id: b.id, purpose: null },
    { sender_id: b.id, recipient_id: a.id, purpose: null },
    { sender_id: a.id, recipient_id: a.id, purpose: "receipt" },
  ]);
  const response = await (await request.get(`/api/conversations/${conversation.id}`)).json();
  expect(response.conversation.status).toBe("completed");
  expect(response.activity.at(-1).purpose).toBe("receipt");
  expect(response.activity.at(-1).content).toBe("REVIEW_PROCESSED");
  const pending = await database().query("SELECT count(*)::int AS count FROM message_deliveries WHERE owner_id=$1 AND state IN ('queued','claimed','running')", [E2E_OWNER_ID]);
  expect(pending[0]?.count).toBe(0);
});

test("ordinary status reads do not dispatch or recover work", async ({ request }) => {
  const agent = ((await (await request.get("/api/agents")).json()) as { agents: AgentProfile[] }).agents[0]!;
  const conversation = await (await request.post("/api/conversations", { data: { agentId: agent.id } })).json() as ConversationProfile;
  const task = await publishConversationMessage({
    ownerId: E2E_OWNER_ID, conversationId: conversation.id, senderType: "human", senderId: E2E_OWNER_ID,
    recipientType: "agent", recipientId: agent.id, content: "E2E_FAKE delay=10 reply=EXPLICIT_RECOVERY",
  });
  const read = await request.get(`/api/conversations/${conversation.id}`);
  expect(read.status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const rows = await database().query("SELECT state FROM message_deliveries WHERE owner_id=$1 AND message_id=$2", [E2E_OWNER_ID, task.id]);
  expect(rows[0]?.state).toBe("queued");
  expect((await request.get(`/api/conversations/${conversation.id}?recover=1`)).status()).toBe(200);
  await expect.poll(async () => {
    const rows = await database().query("SELECT state FROM message_deliveries WHERE owner_id=$1 AND message_id=$2", [E2E_OWNER_ID, task.id]);
    return rows[0]?.state;
  }).toBe("completed");
});

test("pausing browser updates does not stop work and monitoring can resume", async ({ page, request }) => {
  test.setTimeout(30_000);
  const agent = ((await (await request.get("/api/agents")).json()) as { agents: AgentProfile[] }).agents[0]!;
  const conversation = await (await request.post("/api/conversations", { data: { agentId: agent.id } })).json() as ConversationProfile;
  const task = await publishConversationMessage({
    ownerId: E2E_OWNER_ID, conversationId: conversation.id, senderType: "human", senderId: E2E_OWNER_ID,
    recipientType: "agent", recipientId: agent.id, content: "Browser monitoring fixture",
  });
  // Keep status stable without launching an FX process or invoking recovery.
  const body = await (await request.get(`/api/conversations/${conversation.id}`)).json();
  let reads = 0;
  const mutations: string[] = [];
  page.on("request", (incoming) => {
    if (incoming.url().includes("/api/") && incoming.method() !== "GET") mutations.push(incoming.url());
  });
  await page.route(`**/api/conversations/${conversation.id}{,?*}`, async (route) => {
    reads++;
    await route.fulfill({ json: body });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message General" })).toBeVisible();
  await expect.poll(() => reads, { timeout: 5000 }).toBeGreaterThan(0);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const initialReads = reads;
  await page.clock.fastForward(5_100);
  await expect.poll(() => reads, { timeout: 5000 }).toBe(initialReads + 1);
  await page.clock.fastForward(15 * 60_000);
  const resume = page.getByRole("button", { name: "Resume updates" });
  await expect(resume).toBeVisible();
  const pausedReads = reads;
  await page.clock.fastForward(60_000);
  expect(reads).toBe(pausedReads);
  expect(mutations).toEqual([]);
  await resume.click();
  await expect(resume).toBeHidden();
  await expect.poll(() => reads).toBe(pausedReads + 1);
  await page.clock.fastForward(5_100);
  await expect.poll(() => reads, { timeout: 5000 }).toBe(pausedReads + 2);
  expect(mutations).toEqual([]);
  const rows = await database().query("SELECT state FROM message_deliveries WHERE owner_id=$1 AND message_id=$2", [E2E_OWNER_ID, task.id]);
  expect(rows[0]?.state).toBe("queued");
});
