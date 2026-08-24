import { expect, test } from "@playwright/test";
import { neon } from "@neondatabase/serverless";
import { Client } from "eve/client";
import type { AgentProfile, ConversationProfile } from "../../lib/types";
import { E2E_BASE_URL, E2E_OWNER_ID, E2E_TOKEN } from "./constants";
import { requireDatabaseUrl } from "../../lib/server/config";
import { createAgentMessageToken } from "../../lib/server/message-auth";
import { publishConversationMessage } from "../../lib/server/message-store";
import { wakeMessage } from "../../lib/server/message-runtime";

const firstPrompt = "E2E_FAKE delay=15000 reply=E2E_ALPHA";
const secondPrompt = "E2E_FAKE delay=10 reply=E2E_BETA";

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

test("queues overlapping messages and finishes after the browser leaves", async ({ browser }) => {
  const unauthorized = await fetch(`${E2E_BASE_URL}/api/conversations`, {
    headers: { authorization: "Bearer deliberately-wrong-token" },
  });
  expect(unauthorized.status).toBe(401);

  const context = await browser.newContext({
    extraHTTPHeaders: test.info().project.use.extraHTTPHeaders,
  });
  const page = await context.newPage();
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message General" });
  const send = page.getByRole("button", { name: "Send message" });

  await composer.fill(firstPrompt);
  await send.click();
  await expect(
    page.locator("article.message.user .message-copy").getByText(firstPrompt, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Working", { exact: true })).toBeVisible();

  await composer.fill(secondPrompt);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(
    page.locator("article.message.user .message-copy").getByText(secondPrompt, { exact: true }),
  ).toBeVisible();

  const sql = database();
  await expect
    .poll(async () => {
      const rows = await sql.query(
        `SELECT count(*)::int AS count
         FROM conversation_messages
         WHERE owner_id = $1
           AND sender_type = 'human' AND recipient_type = 'agent'`,
        [E2E_OWNER_ID],
      );
      return rows[0]?.count;
    })
    .toBe(2);

  await page.close();

  await expect
    .poll(
      async () => {
        const rows = await sql.query(
          `SELECT content AS message
           FROM conversation_messages
           WHERE owner_id = $1
             AND sender_type = 'agent' AND recipient_type = 'human'
             AND kind = 'message'
           ORDER BY created_at ASC, id ASC`,
          [E2E_OWNER_ID],
        );
        return rows.map((row) => row.message);
      },
      { timeout: 150_000 },
    )
    .toEqual(["E2E_ALPHA", "E2E_BETA"]);

  const persistedRows = await sql.query(
    `SELECT conversation.id, conversation.agent_id, conversation.runtime_version,
       conversation.status, agent.eve_session_id,
       (SELECT count(*)::int FROM conversation_messages
        WHERE owner_id = $1
          AND sender_type = 'human' AND recipient_type = 'agent') AS user_count,
       (SELECT count(*)::int FROM conversation_messages
        WHERE owner_id = $1
          AND sender_type = 'agent' AND recipient_type = 'human') AS terminal_count
     FROM conversations conversation
     JOIN agents agent ON agent.id = conversation.agent_id
     WHERE conversation.owner_id = $1`,
    [E2E_OWNER_ID],
  );
  assertPersistedConversation(persistedRows[0]);
  const persisted = persistedRows[0] as {
    agent_id: string;
    eve_session_id: string;
  };

  const resumed = await context.newPage();
  await resumed.goto("/");
  const assistantMessages = resumed.locator("article.message.assistant:not(.pending) .message-copy");
  await expect(assistantMessages).toHaveText(["E2E_ALPHA", "E2E_BETA"]);
  await expect(resumed.getByText("Ready", { exact: true })).toBeVisible();

  const eve = new Client({
    host: E2E_BASE_URL,
    auth: { bearer: E2E_TOKEN },
    headers: {
      "x-console-agent-id": persisted.agent_id,
      "x-console-conversation-id": persistedRows[0]!.id as string,
    },
  });
  await expect
    .poll(async () => {
      const snapshot = await eve.sessions.attach(persisted.eve_session_id).snapshot();
      const terminalTurns = snapshot.events.filter((event) =>
        ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type),
      );
      return {
        terminalTurns: terminalTurns.length,
        tail: snapshot.events.at(-1)?.type,
      };
    })
    .toEqual({ terminalTurns: 2, tail: "session.waiting" });
  await context.close();
});

test("recovers an inactive durable session without duplicating the mailbox request", async ({
  page,
  request,
}) => {
  const agentsResponse = await request.get("/api/agents");
  expect(agentsResponse.status()).toBe(200);
  const agent = ((await agentsResponse.json()) as { agents: AgentProfile[] }).agents[0]!;
  const staleSessionId = "wrun_stale_client_recovery";
  const sql = database();
  await sql.query(
    "UPDATE agents SET eve_session_id = $3 WHERE owner_id = $1 AND id = $2",
    [E2E_OWNER_ID, agent.id, staleSessionId],
  );

  await page.goto("/");
  const prompt = "E2E_FAKE delay=10 reply=STALE_SESSION_RECOVERED";
  await page.getByRole("textbox", { name: "Message General" }).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(
    page.locator("article.message.assistant:not(.pending) .message-copy"),
  ).toHaveText(["STALE_SESSION_RECOVERED"]);
  await expect(
    page.locator("article.message.user .message-copy").getByText(prompt, { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();

  const rows = await sql.query(
    `SELECT agent.eve_session_id,
       (SELECT count(*)::int FROM conversation_messages message
        WHERE message.owner_id = $1 AND message.conversation_id = conversation.id
          AND message.sender_type = 'human' AND message.recipient_type = 'agent') AS user_count,
       (SELECT count(*)::int FROM conversation_messages message
        WHERE message.owner_id = $1 AND message.conversation_id = conversation.id
          AND message.sender_type = 'agent' AND message.recipient_type = 'human'
          AND message.kind = 'message') AS assistant_count
     FROM conversations conversation
     JOIN agents agent ON agent.owner_id = conversation.owner_id
       AND agent.id = conversation.agent_id
     WHERE conversation.owner_id = $1
     LIMIT 1`,
    [E2E_OWNER_ID],
  );
  expect(rows[0]).toEqual({
    eve_session_id: expect.any(String),
    user_count: 1,
    assistant_count: 1,
  });
  expect(rows[0]?.eve_session_id).not.toBe(staleSessionId);
});

test("accepts a signed message wakeup in the existing conversation", async ({
  page,
  request,
}) => {
  const agentsResponse = await request.get("/api/agents");
  expect(agentsResponse.status()).toBe(200);
  const sender = ((await agentsResponse.json()) as { agents: AgentProfile[] }).agents[0]!;
  const recipientResponse = await request.post("/api/agents", {
    data: {
      name: "Message Receiver",
      specialty: "Receives autonomous work",
      instructions: "Process incoming work independently.",
    },
  });
  expect(recipientResponse.status()).toBe(201);
  const recipient = (await recipientResponse.json()) as AgentProfile;
  const staleRecipientSessionId = "wrun_stale_message_recovery";
  await database().query(
    "UPDATE agents SET eve_session_id = $3 WHERE owner_id = $1 AND id = $2",
    [E2E_OWNER_ID, recipient.id, staleRecipientSessionId],
  );
  const conversationResponse = await request.post("/api/conversations", {
    data: { agentId: sender.id },
  });
  expect(conversationResponse.status()).toBe(201);
  const conversation = (await conversationResponse.json()) as ConversationProfile;

  const message = await publishConversationMessage({
    ownerId: E2E_OWNER_ID,
    id: "e2e-signed-message-wake",
    conversationId: conversation.id,
    senderType: "system",
    senderId: "e2e-system",
    recipientType: "agent",
    recipientId: recipient.id,
    content: "E2E_FAKE delay=10 reply=MESSAGE_WAKE_OK",
  });
  await wakeMessage({ ownerId: E2E_OWNER_ID, message });

  const sql = database();
  await expect.poll(async () => {
    const rows = await sql.query(
      `SELECT content
       FROM conversation_messages
       WHERE owner_id = $1 AND conversation_id = $2
         AND sender_type = 'agent' AND sender_id = $3
         AND recipient_type = 'human' AND in_reply_to = $4
       ORDER BY created_at DESC
       LIMIT 1`,
      [E2E_OWNER_ID, conversation.id, recipient.id, message.id],
    );
    return rows[0]?.content;
  }).toBe("MESSAGE_WAKE_OK");

  const deliveryRows = await sql.query(
    `SELECT delivery.state, message.conversation_id, agent.eve_session_id
     FROM message_deliveries delivery
     JOIN conversation_messages message
       ON message.owner_id = delivery.owner_id
      AND message.id = delivery.message_id
     JOIN agents agent
       ON agent.owner_id = message.owner_id
      AND agent.id = message.recipient_id
     WHERE delivery.owner_id = $1 AND delivery.message_id = $2`,
    [E2E_OWNER_ID, message.id],
  );
  expect(deliveryRows[0]).toEqual({
    state: "completed",
    conversation_id: conversation.id,
    eve_session_id: expect.any(String),
  });
  expect(deliveryRows[0]?.eve_session_id).not.toBe(staleRecipientSessionId);

  const conversationRows = await sql.query(
    "SELECT count(*)::int AS count FROM conversations WHERE owner_id = $1",
    [E2E_OWNER_ID],
  );
  expect(conversationRows[0]?.count).toBe(1);

  const detailResponse = await request.get("/api/conversations/" + conversation.id);
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()) as {
    activity: Array<Record<string, unknown>>;
  };
  expect(detail.activity).toContainEqual(expect.objectContaining({
    id: message.id,
    senderName: "System",
    recipientName: recipient.name,
    state: "completed",
  }));
  expect(detail.activity).toContainEqual(expect.objectContaining({
    senderId: recipient.id,
    recipientName: "You",
    inReplyTo: message.id,
    content: "MESSAGE_WAKE_OK",
  }));

  await page.goto("/");
  await page.getByRole("button", { name: "Activity" }).click();
  const loggedMessage = page.locator("article").filter({
    hasText: "E2E_FAKE delay=10 reply=MESSAGE_WAKE_OK",
  });
  await expect(loggedMessage).toContainText("System");
  await expect(loggedMessage).toContainText(recipient.name);
  await expect(loggedMessage).toContainText("Delivered");
});

test("sends a peer message through the A2A API and returns its correlated reply", async ({
  request,
}) => {
  const agentsResponse = await request.get("/api/agents");
  expect(agentsResponse.status()).toBe(200);
  const sender = ((await agentsResponse.json()) as { agents: AgentProfile[] }).agents[0]!;
  const recipientResponse = await request.post("/api/agents", {
    data: {
      name: "Peer Receiver",
      specialty: "Replies to peer messages",
      instructions: "Complete peer requests independently and reply directly.",
    },
  });
  expect(recipientResponse.status()).toBe(201);
  const recipient = (await recipientResponse.json()) as AgentProfile;
  const conversationResponse = await request.post("/api/conversations", {
    data: { agentId: sender.id },
  });
  expect(conversationResponse.status()).toBe(201);
  const conversation = (await conversationResponse.json()) as ConversationProfile;
  const token = createAgentMessageToken({
    ownerId: E2E_OWNER_ID,
    agentId: sender.id,
    conversationId: conversation.id,
  });

  const sendResponse = await request.post("/api/a2a", {
    headers: { authorization: `Bearer ${token}` },
    data: {
      operation: "send",
      arguments: {
        to: recipient.name,
        content: "E2E_FAKE delay=10 reply=PEER_REPLY",
        wait_for_reply: true,
        timeout_s: 30,
      },
    },
  });
  const sendBody = await sendResponse.json();
  const deliveryDiagnostic = sendResponse.status() === 200
    ? []
    : await database().query(
        `SELECT message.sender_id, message.recipient_id, message.in_reply_to,
                message.content, delivery.state, delivery.error
         FROM conversation_messages message
         LEFT JOIN message_deliveries delivery
           ON delivery.owner_id = message.owner_id AND delivery.message_id = message.id
         WHERE message.owner_id = $1 AND message.conversation_id = $2
         ORDER BY message.created_at ASC`,
        [E2E_OWNER_ID, conversation.id],
      );
  expect(
    sendResponse.status(),
    JSON.stringify({ sendBody, deliveryDiagnostic }),
  ).toBe(200);
  const result = sendBody as {
    status: string;
    messageId: string;
    replies: Array<{
      from: { id: string; name: string };
      inReplyTo?: string;
      content: string;
    }>;
  };
  expect(result.status).toBe("replied");
  expect(result.replies).toEqual([
    expect.objectContaining({
      from: { id: recipient.id, name: recipient.name },
      inReplyTo: result.messageId,
      content: "PEER_REPLY",
    }),
  ]);

  const detailResponse = await request.get(`/api/conversations/${conversation.id}`);
  expect(detailResponse.status()).toBe(200);
  const detail = (await detailResponse.json()) as { activity: Array<Record<string, unknown>> };
  expect(detail.activity).toContainEqual(expect.objectContaining({
    id: result.messageId,
    senderId: sender.id,
    recipientId: recipient.id,
    state: "completed",
  }));
});

test("deletes conversations and moves a deleted agent's conversation to General", async ({ browser }) => {
  const context = await browser.newContext({
    extraHTTPHeaders: test.info().project.use.extraHTTPHeaders,
  });
  const page = await context.newPage();
  await page.goto("/");

  const agentResponse = await page.request.post("/api/agents", {
    data: {
      name: "Disposable",
      specialty: "Temporary browser-test specialist",
      instructions: "Complete deterministic browser-test requests and preserve their history.",
    },
  });
  expect(agentResponse.status()).toBe(201);
  const disposable = (await agentResponse.json()) as AgentProfile;
  const conversationResponse = await page.request.post("/api/conversations", {
    data: { agentId: disposable.id },
  });
  expect(conversationResponse.status()).toBe(201);
  const disposableConversation = (await conversationResponse.json()) as ConversationProfile;

  await page.reload();
  const sidebar = page.locator(".desktop-sidebar");
  const disposableRow = sidebar.locator(".conversation-row").filter({ hasText: "Disposable" });
  await disposableRow.locator(".conversation-link").click();
  await expect(page.getByRole("heading", { name: "Disposable" })).toBeVisible();

  const beforeDeletePrompt = "E2E_FAKE delay=10 reply=PRESERVED";
  await page.getByRole("textbox", { name: "Message Disposable" }).fill(beforeDeletePrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.locator("article.message.assistant:not(.pending) .message-copy"),
  ).toHaveText(["PRESERVED"]);

  const agentDirectory = sidebar.locator("details.agent-directory");
  await agentDirectory.locator("summary").click();
  await agentDirectory.getByRole("button", { name: "Delete agent Disposable" }).click();
  const agentDialog = page.getByRole("dialog", { name: "Delete agent?" });
  await expect(agentDialog).toContainText("conversations and history will remain available through General");
  await agentDialog.getByRole("button", { name: "Delete agent", exact: true }).click();
  await expect(agentDialog).toBeHidden();

  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await expect(
    page.locator("article.message.assistant:not(.pending) .message-copy"),
  ).toHaveText(["PRESERVED"]);
  await expect(agentDirectory.getByText("Disposable", { exact: true })).toHaveCount(0);

  const preservedResponse = await page.request.get(
    `/api/conversations/${disposableConversation.id}`,
  );
  expect(preservedResponse.status()).toBe(200);
  const preserved = (await preservedResponse.json()) as {
    conversation: ConversationProfile;
  };
  expect(preserved.conversation.agentName).toBe("General");
  expect(preserved.conversation.eveSessionId).toBeNull();

  const afterDeletePrompt = "E2E_FAKE delay=10 reply=AFTER_DELETE";
  await page.getByRole("textbox", { name: "Message General" }).fill(afterDeletePrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.locator("article.message.assistant:not(.pending) .message-copy"),
  ).toHaveText(["PRESERVED", "AFTER_DELETE"]);

  const selectedRow = sidebar.locator(".conversation-link.active").locator("..");
  await selectedRow.getByRole("button", { name: /^Delete conversation/ }).click();
  const conversationDialog = page.getByRole("dialog", { name: "Delete conversation?" });
  await expect(conversationDialog).toContainText("complete message history will be permanently deleted");
  await conversationDialog.getByRole("button", { name: "Delete conversation", exact: true }).click();
  await expect(conversationDialog).toBeHidden();
  await expect(sidebar.locator(".conversation-row")).toHaveCount(1);
  expect((await page.request.get(`/api/conversations/${disposableConversation.id}`)).status()).toBe(404);

  await context.close();
});

function assertPersistedConversation(row: Record<string, unknown> | undefined) {
  expect(row).toBeDefined();
  expect(row?.agent_id).toEqual(expect.any(String));
  expect(row?.id).toEqual(expect.any(String));
  expect(row?.runtime_version).toBe(2);
  expect(row?.status).toBe("completed");
  expect(row?.eve_session_id).toEqual(expect.any(String));
  expect(row?.user_count).toBe(2);
  expect(row?.terminal_count).toBe(2);
}
