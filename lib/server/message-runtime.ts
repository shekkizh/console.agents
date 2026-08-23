import { Client, ClientError } from "eve/client";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import type { CapturedArtifact } from "@/lib/server/artifact-capture";
import { createMessageWakeToken } from "@/lib/server/message-auth";
import {
  claimConversationMessages,
  listMessageArtifacts,
  listReachableAgents,
  markMessageDelivery,
  openMessageListener,
  publishConversationMessage,
  resolveAgentRecipient,
  type ConversationMessage,
} from "@/lib/server/message-store";
import { consoleInternalUrl } from "@/lib/server/config";
import { getAgent, resetAgentSession } from "@/lib/server/agent-store";

const sendSchema = z.object({
  to: z.string().trim().min(1),
  content: z.string().trim().min(1).max(100_000),
  summary: z.string().trim().min(1).max(500).optional(),
  reply_to: z.string().trim().min(1).max(100).optional(),
  wait_for_reply: z.boolean().optional(),
  timeout_s: z.number().finite().min(0).max(3_600).default(3_600),
}).strict();

const waitSchema = z.object({
  from_agent: z.string().trim().min(1).optional(),
  reply_to: z.string().trim().min(1).max(100).optional(),
  timeout_s: z.number().finite().min(0).max(3_600).default(3_600),
}).strict();

export interface AgentMessageContext {
  ownerId: string;
  agentId: string;
  conversationId: string;
  incomingMessageId?: string;
  incomingFromAgentId?: string;
  abortSignal?: AbortSignal;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "artifact";
}

function artifactPath(messageId: string, artifact: { id: string; name: string }): string {
  return `.console/inbox/${messageId}/${safeFilename(`${artifact.id}-${artifact.name}`)}`;
}

export async function materializeMessageArtifacts(
  input: { ownerId: string; sandbox: SandboxSession },
  messageId: string,
): Promise<Array<{ id: string; path: string; title: string; mediaType: string; size: number }>> {
  const artifacts = await listMessageArtifacts(input.ownerId, messageId);
  if (artifacts.length === 0) return [];
  const prepared = await input.sandbox.run({
    command: `mkdir -p /workspace/.console/inbox/${messageId}`,
  });
  if (prepared.exitCode !== 0) throw new Error("Unable to prepare the message artifact inbox");
  const result = [];
  for (const artifact of artifacts) {
    const path = artifactPath(messageId, artifact);
    await input.sandbox.writeBinaryFile({ path, content: artifact.content });
    result.push({
      id: artifact.id,
      path,
      title: artifact.title,
      mediaType: artifact.mediaType,
      size: artifact.size,
    });
  }
  return result;
}

async function messageResult(context: AgentMessageContext, message: ConversationMessage) {
  const [sender, artifacts] = await Promise.all([
    message.senderType === "agent" ? getAgent(context.ownerId, message.senderId) : undefined,
    listMessageArtifacts(context.ownerId, message.id),
  ]);
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    from: {
      id: message.senderId,
      name: sender?.name ?? message.senderId,
    },
    inReplyTo: message.inReplyTo,
    content: message.content,
    summary: message.summary,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      path: artifactPath(message.id, artifact),
      title: artifact.title,
      mediaType: artifact.mediaType,
      size: artifact.size,
      contentBase64: Buffer.from(artifact.content).toString("base64"),
    })),
  };
}

export async function formatMessageEnvelope(input: {
  ownerId: string;
  message: ConversationMessage;
}): Promise<string> {
  const [sender, artifacts] = await Promise.all([
    input.message.senderType === "agent"
      ? getAgent(input.ownerId, input.message.senderId)
      : undefined,
    listMessageArtifacts(input.ownerId, input.message.id),
  ]);
  const lines = [
    "[message]",
    `from: ${sender?.name ?? input.message.senderId} (${input.message.senderId})`,
    `messageId: ${input.message.id}`,
    `conversationId: ${input.message.conversationId}`,
  ];
  if (input.message.inReplyTo) lines.push(`inReplyTo: ${input.message.inReplyTo}`);
  if (artifacts.length > 0) {
    lines.push("artifacts:");
    for (const artifact of artifacts) {
      lines.push(`- ${artifactPath(input.message.id, artifact)} (${artifact.title})`);
    }
  }
  lines.push("", input.message.content);
  return lines.join("\n");
}

export async function wakeMessage(input: {
  ownerId: string;
  message: ConversationMessage;
}): Promise<void> {
  if (input.message.recipientType !== "agent") return;
  const target = await getAgent(input.ownerId, input.message.recipientId);
  if (!target?.enabled) throw new Error("Recipient agent is unavailable");
  const token = createMessageWakeToken({
    ownerId: input.ownerId,
    targetAgentId: target.id,
    conversationId: input.message.conversationId,
    messageId: input.message.id,
    fromAgentId: input.message.senderId,
  });
  const client = new Client({
    host: consoleInternalUrl(),
    auth: { bearer: token },
    redirect: "error",
    headers: {
      "x-console-agent-id": target.id,
      "x-console-conversation-id": input.message.conversationId,
      "x-console-message-id": input.message.id,
      "x-console-message-wake": "1",
    },
  });
  const envelope = await formatMessageEnvelope(input);
  if (!target.eveSessionId) {
    await client.sessions.create({ message: envelope, turnPolicy: "queue" });
  } else {
    try {
      await client.sessions.attach(target.eveSessionId).send(envelope, { turnPolicy: "queue" });
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== "session_not_active") throw error;
      const recovered = await resetAgentSession(input.ownerId, target.id, target.eveSessionId);
      if (recovered.eveSessionId) {
        await client.sessions.attach(recovered.eveSessionId).send(envelope, { turnPolicy: "queue" });
      } else {
        await client.sessions.create({ message: envelope, turnPolicy: "queue" });
      }
    }
  }
  await markMessageDelivery(
    input.ownerId,
    input.message.id,
    input.message.recipientId,
    "dispatched",
  );
}

async function waitForMessages(
  context: AgentMessageContext,
  filter: { fromAgentId?: string; inReplyTo?: string; timeoutSeconds: number },
) {
  const deadline = Date.now() + filter.timeoutSeconds * 1_000;
  const listener = await openMessageListener(context.ownerId, context.agentId, context.abortSignal);
  try {
    while (true) {
      context.abortSignal?.throwIfAborted();
      const messages = await claimConversationMessages({
        ownerId: context.ownerId,
        agentId: context.agentId,
        conversationId: context.conversationId,
        fromAgentId: filter.fromAgentId,
        inReplyTo: filter.inReplyTo,
      });
      if (messages.length > 0) {
        return Promise.all(messages.map((message) => messageResult(context, message)));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await listener.wait(remaining);
    }
  } finally {
    await listener.close().catch(() => undefined);
  }
}

export async function executeMessageOperation(
  context: AgentMessageContext,
  operation: string,
  rawArguments: Record<string, unknown>,
  artifacts: readonly CapturedArtifact[] = [],
): Promise<unknown> {
  if (operation === "list") {
    return [
      {
        id: "user",
        name: "User",
        specialty: "The human participant in this conversation",
        skills: [],
      },
      ...(await listReachableAgents(context.ownerId, context.agentId)).map((agent) => ({
        id: agent.id,
        name: agent.name,
        specialty: agent.specialty,
        skills: agent.fxConfig.skills.map(({ name, description }) => ({ name, description })),
      })),
    ];
  }

  if (operation === "send") {
    const args = sendSchema.parse(rawArguments);
    const normalizedRecipient = args.to.trim().toLowerCase();
    const toHuman = normalizedRecipient === "user" ||
      normalizedRecipient === "human" ||
      normalizedRecipient === "operator";
    const recipient = toHuman
      ? { id: context.ownerId }
      : await resolveAgentRecipient(context.ownerId, context.agentId, args.to);
    const inReplyTo = args.reply_to ??
      (!toHuman && recipient.id === context.incomingFromAgentId
        ? context.incomingMessageId
        : undefined);
    const waitForReply = !toHuman && (args.wait_for_reply ?? !inReplyTo);
    const message = await publishConversationMessage({
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      senderType: "agent",
      senderId: context.agentId,
      recipientType: toHuman ? "human" : "agent",
      recipientId: recipient.id,
      ...(inReplyTo ? { inReplyTo } : {}),
      content: args.content,
      summary: args.summary,
      artifacts,
    });
    if (!toHuman) await wakeMessage({ ownerId: context.ownerId, message });
    if (!waitForReply) {
      return {
        status: toHuman ? "delivered" : "queued",
        messageId: message.id,
        conversationId: message.conversationId,
        to: toHuman ? "user" : recipient.id,
      };
    }
    const replies = await waitForMessages(context, {
      fromAgentId: recipient.id,
      inReplyTo: message.id,
      timeoutSeconds: args.timeout_s,
    });
    return {
      status: replies.length > 0 ? "replied" : "timeout",
      messageId: message.id,
      conversationId: message.conversationId,
      to: recipient.id,
      replies,
    };
  }

  if (operation === "wait") {
    const args = waitSchema.parse(rawArguments);
    const from = args.from_agent
      ? await resolveAgentRecipient(context.ownerId, context.agentId, args.from_agent)
      : undefined;
    const messages = await waitForMessages(context, {
      fromAgentId: from?.id,
      inReplyTo: args.reply_to,
      timeoutSeconds: args.timeout_s,
    });
    return {
      status: messages.length > 0 ? "received" : "timeout",
      messages,
    };
  }

  throw new Error(`Unknown message operation: ${operation}`);
}

