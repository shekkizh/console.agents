import { expect, test } from "@playwright/test";
import { neon } from "@neondatabase/serverless";
import type { AgentProfile, ConversationProfile } from "../../lib/types";
import { E2E_BASE_URL, E2E_OWNER_ID } from "./constants";
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
});
