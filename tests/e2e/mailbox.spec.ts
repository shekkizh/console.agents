import { expect, test } from "@playwright/test";
import { neon } from "@neondatabase/serverless";
import { Client } from "eve/client";
import type { AgentProfile, ConversationProfile } from "../../lib/types";
import { E2E_BASE_URL, E2E_OWNER_ID, E2E_TOKEN } from "./constants";

const firstPrompt = "E2E_FAKE delay=5000 reply=E2E_ALPHA";
const secondPrompt = "E2E_FAKE delay=10 reply=E2E_BETA";

function database() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for browser tests");
  return neon(process.env.DATABASE_URL);
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
  await expect(page.getByText("Working in the sandbox", { exact: true })).toBeVisible();

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
         FROM agent_events
         WHERE owner_id = $1 AND event_type = 'message.user'`,
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
          `SELECT payload->>'message' AS message
           FROM agent_events
           WHERE owner_id = $1 AND event_type = 'message.assistant'
           ORDER BY created_at ASC, id ASC`,
          [E2E_OWNER_ID],
        );
        return rows.map((row) => row.message);
      },
      { timeout: 150_000 },
    )
    .toEqual(["E2E_ALPHA", "E2E_BETA"]);

  const persistedRows = await sql.query(
    `SELECT id, agent_id, runtime_version, status, eve_session_id,
       (SELECT count(*)::int FROM agent_events
        WHERE owner_id = $1 AND event_type = 'message.user') AS user_count,
       (SELECT count(*)::int FROM agent_events
        WHERE owner_id = $1 AND event_type IN ('message.assistant', 'message.failed')) AS terminal_count
     FROM conversations WHERE owner_id = $1`,
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
