import { completionDestination, messagePurpose } from "@/lib/message-protocol";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CapturedArtifact } from "@/lib/server/artifact-capture";
import type { AgentSandbox } from "@/lib/server/agent-sandbox";
import {
  claimConversationMessages,
  getConversationMessage,
  isMessageDeliveryPending,
  listMessageArtifacts,
  listReachableAgents,
  markMessageDelivery,
  openMessageListener,
  publishConversationMessage,
  resolveAgentRecipient,
  type ConversationMessage,
} from "@/lib/server/message-store";
import { getAgent } from "@/lib/server/agent-store";
import { isAgentActivationActive } from "@/lib/server/agent-activation";
import { withAgentLifecycleLock } from "@/lib/server/agent-lifecycle";

export const MAX_PEER_WAIT_SECONDS = 60;

const sendSchema = z.object({
  to: z.string().trim().min(1),
  content: z.string().trim().min(1).max(100_000),
  summary: z.string().trim().min(1).max(500).optional(),
  reply_to: z.string().trim().min(1).max(100).optional(),
  wait_for_reply: z.boolean().optional(),
  timeout_s: z.number().finite().min(0).max(MAX_PEER_WAIT_SECONDS).default(MAX_PEER_WAIT_SECONDS),
}).strict();

const waitSchema = z.object({
  from_agent: z.string().trim().min(1).optional(),
  reply_to: z.string().trim().min(1).max(100).optional(),
  timeout_s: z.number().finite().min(0).max(MAX_PEER_WAIT_SECONDS).default(MAX_PEER_WAIT_SECONDS),
}).strict();

const progressSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  summary: z.string().trim().min(1).max(500).optional(),
  idempotency_key: z.string().trim().min(1).max(100).optional(),
}).strict();

const completeSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  summary: z.string().trim().min(1).max(500).optional(),
  session_id: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,200}$/).optional(),
}).strict();

const API_LONG_POLL_SECONDS = 20;

export interface AgentMessageContext {
  ownerId: string;
  agentId: string;
  conversationId: string;
  incomingMessageId?: string;
  incomingFromAgentId?: string;
  abortSignal?: AbortSignal;
}

// Keep only the local database mutation under the sender lock. Peer dispatch
// and long polling must remain outside it so two agents can exchange replies.
async function withCurrentActivation<T>(context: AgentMessageContext, operation: () => Promise<T>): Promise<T> {
  if (!context.incomingMessageId) return operation(); // Trusted internal callers.
  return withAgentLifecycleLock(context, async () => {
    if (!await isAgentActivationActive(context)) throw new Error("This activation is no longer active");
    return operation();
  });
}

function correlatedMessageId(
  kind: string,
  context: AgentMessageContext,
  requestId: string,
): string {
  const hex = createHash("sha256")
    .update(`${kind}:\0${context.ownerId}:\0${context.agentId}:\0${requestId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

async function correlatedRequest(context: AgentMessageContext): Promise<ConversationMessage> {
  if (!context.incomingMessageId) {
    throw new Error("This activation is not correlated with an incoming task");
  }
  const request = await getConversationMessage(context.ownerId, context.incomingMessageId);
  if (
    !request ||
    request.conversationId !== context.conversationId ||
    request.recipientType !== "agent" ||
    request.recipientId !== context.agentId
  ) {
    throw new Error("The correlated task is unavailable");
  }
  return request;
}

function replyTarget(context: AgentMessageContext, request: ConversationMessage) {
  return completionDestination(request, context.ownerId, context.agentId);
}

async function executeTaskProgress(
  context: AgentMessageContext,
  rawArguments: Record<string, unknown>,
  artifacts: readonly CapturedArtifact[],
) {
  const args = progressSchema.parse(rawArguments);
  const request = await correlatedRequest(context);
  if (!await isMessageDeliveryPending(context.ownerId, request.id, context.agentId)) {
    throw new Error("The correlated task is no longer running");
  }
  const target = replyTarget(context, request);
  const progress = await publishConversationMessage({
    ownerId: context.ownerId,
    id: correlatedMessageId(
      `progress:${args.idempotency_key ?? args.content}`,
      context,
      request.id,
    ),
    conversationId: context.conversationId,
    senderType: "agent",
    senderId: context.agentId,
    ...target,
    inReplyTo: request.id,
    content: args.content,
    summary: args.summary,
    metadata: { activity: "progress", messagePurpose: target.messagePurpose === "receipt" ? "receipt" : "progress" },
    artifacts,
  });
  return {
    status: "delivered",
    messageId: progress.id,
    requestId: request.id,
    conversationId: progress.conversationId,
  };
}

async function executeTaskCompletion(
  context: AgentMessageContext,
  rawArguments: Record<string, unknown>,
  artifacts: readonly CapturedArtifact[],
) {
  const args = completeSchema.parse(rawArguments);
  const request = await correlatedRequest(context);
  const responseId = correlatedMessageId("complete", context, request.id);
  const existing = await getConversationMessage(context.ownerId, responseId);
  if (existing) {
    await markMessageDelivery(context.ownerId, request.id, context.agentId, "completed");
    return {
      status: "already_completed",
      messageId: existing.id,
      requestId: request.id,
      conversationId: existing.conversationId,
    };
  }
  if (!await isMessageDeliveryPending(context.ownerId, request.id, context.agentId)) {
    throw new Error("The correlated task is no longer running");
  }
  const target = replyTarget(context, request);
  const response = await publishConversationMessage({
    ownerId: context.ownerId,
    id: responseId,
    conversationId: context.conversationId,
    senderType: "agent",
    senderId: context.agentId,
    ...target,
    inReplyTo: request.id,
    content: args.content,
    summary: args.summary,
    metadata: {
      activity: "completion",
      ...(target.messagePurpose === "receipt" ? { messagePurpose: "receipt" } : {}),
      ...(args.session_id ? { sessionId: args.session_id } : {}),
    },
    artifacts,
  });
  await markMessageDelivery(context.ownerId, request.id, context.agentId, "completed");
  return {
    status: "completed",
    messageId: response.id,
    requestId: request.id,
    conversationId: response.conversationId,
  };
}

async function executeTaskFailure(context: AgentMessageContext, rawArguments: Record<string, unknown>) {
  const args = z.object({ content: z.string().trim().min(1).max(100_000) }).strict().parse(rawArguments);
  const request = await correlatedRequest(context);
  const responseId = correlatedMessageId("failure", context, request.id);
  const existing = await getConversationMessage(context.ownerId, responseId);
  if (existing) {
    await markMessageDelivery(context.ownerId, request.id, context.agentId, "failed", args.content);
    return { status: "already_failed", messageId: existing.id };
  }
  if (!await isMessageDeliveryPending(context.ownerId, request.id, context.agentId)) {
    throw new Error("The correlated task is no longer running");
  }
  const response = await publishConversationMessage({
    ownerId: context.ownerId,
    id: responseId,
    conversationId: context.conversationId,
    senderType: "agent",
    senderId: context.agentId,
    ...replyTarget(context, request),
    metadata: { messagePurpose: replyTarget(context, request).messagePurpose },
    kind: "error",
    inReplyTo: request.id,
    content: args.content,
  });
  await markMessageDelivery(context.ownerId, request.id, context.agentId, "failed", args.content);
  return { status: "failed", messageId: response.id };
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "artifact";
}

function artifactPath(messageId: string, artifact: { id: string; name: string }): string {
  return `.console/inbox/${messageId}/${safeFilename(`${artifact.id}-${artifact.name}`)}`;
}

export async function materializeMessageArtifacts(
  input: { ownerId: string; sandbox: AgentSandbox },
  messageId: string,
): Promise<Array<{ id: string; path: string; title: string; mediaType: string; size: number }>> {
  const artifacts = await listMessageArtifacts(input.ownerId, messageId);
  if (artifacts.length === 0) return [];
  const prepared = await input.sandbox.run({
    command: `mkdir -p '${input.sandbox.root}/.console/inbox/${messageId}'`,
  });
  if (prepared.exitCode !== 0) throw new Error("Unable to prepare the message artifact inbox");
  const result = [];
  for (const artifact of artifacts) {
    const path = artifactPath(messageId, artifact);
    await input.sandbox.writeBinaryFile(path, artifact.content);
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
    kind: message.kind,
    purpose: messagePurpose(message),
    activity: message.metadata.activity,
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
    `purpose: ${messagePurpose(input.message)}`,
    `replyExpected: ${messagePurpose(input.message) === "request"}`,
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
  if (messagePurpose(input.message) !== "request") {
    lines.push("handling: This is a result or update, not a new request. Review it as needed. Your final output is recorded locally and is not sent back to the sender. Do not send an acknowledgment or ask for another acknowledgment.");
  }
  lines.push("", input.message.content);
  return lines.join("\n");
}

// A request keeps its original wait budget across repeated HTTP polls. Once the
// budget expires agents can still collect an already queued reply, but cannot
// keep their sequential inbox occupied indefinitely waiting for that request.
export function remainingPeerWaitSeconds(createdAt: string, requested: number, now = Date.now()): number {
  return Math.max(0, Math.min(requested, (Date.parse(createdAt) + MAX_PEER_WAIT_SECONDS * 1_000 - now) / 1_000));
}

async function boundedReplyWait(context: AgentMessageContext, requestId: string, requested: number) {
  const request = await getConversationMessage(context.ownerId, requestId);
  if (!request || request.conversationId !== context.conversationId ||
    request.senderType !== "agent" || request.senderId !== context.agentId) {
    throw new Error("reply_to must identify a request sent by this agent in this conversation");
  }
  return {
    timeoutSeconds: remainingPeerWaitSeconds(request.createdAt, requested),
    deadline: Date.parse(request.createdAt) + MAX_PEER_WAIT_SECONDS * 1_000,
  };
}

async function wouldWaitOnAncestor(context: AgentMessageContext, recipientId: string): Promise<boolean> {
  let requestId = context.incomingMessageId;
  const visited = new Set<string>();
  for (let depth = 0; requestId && depth < 32; depth += 1) {
    if (visited.has(requestId)) return true;
    visited.add(requestId);
    const request = await getConversationMessage(context.ownerId, requestId);
    if (!request || request.conversationId !== context.conversationId) return false;
    if (request.senderType === "agent" && request.senderId === recipientId) return true;
    requestId = typeof request.metadata.parentRequestId === "string" ? request.metadata.parentRequestId : undefined;
  }
  return Boolean(requestId); // Be conservative if the ancestry exceeds our bound.
}

async function waitForMessages(
  context: AgentMessageContext,
  filter: { fromAgentId?: string; inReplyTo?: string; timeoutSeconds: number },
) {
  const deadline = Date.now() + Math.min(filter.timeoutSeconds, API_LONG_POLL_SECONDS) * 1_000;
  const listener = await openMessageListener(context.ownerId, context.agentId, context.abortSignal);
  try {
    while (true) {
      context.abortSignal?.throwIfAborted();
      const messages = await withCurrentActivation(context, () => claimConversationMessages({
        ownerId: context.ownerId,
        agentId: context.agentId,
        conversationId: context.conversationId,
        fromAgentId: filter.fromAgentId,
        inReplyTo: filter.inReplyTo,
      }));
      // Consume progress so it cannot become a later coding task, but do not
      // resolve a correlated request until its reply/error arrives. The transcript
      // retains progress, and uncorrelated waits can still receive it.
      const replies = filter.inReplyTo
        ? messages.filter((message) => message.metadata.activity !== "progress")
        : messages;
      if (replies.length > 0) {
        return Promise.all(replies.map((message) => messageResult(context, message)));
      }
      // A full batch can hide a completion behind progress; drain it before waiting.
      if (messages.length === 50) continue;
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
    const inReplyTo = args.reply_to;
    if (inReplyTo) {
      const original = await getConversationMessage(context.ownerId, inReplyTo);
      if (!original || original.conversationId !== context.conversationId ||
          original.recipientType !== "agent" || original.recipientId !== context.agentId ||
          original.senderId !== recipient.id ||
          original.senderType !== (toHuman ? "human" : "agent") ||
          messagePurpose(original) !== "request") {
        throw new Error("reply_to must identify a request from this recipient, not a reply or progress update");
      }
      if (args.wait_for_reply) throw new Error("A reply cannot request another reply; send a new request instead");
    }
    const requestedWait = !toHuman && (args.wait_for_reply ?? !inReplyTo);
    const dependencyCycle = requestedWait && await wouldWaitOnAncestor(context, recipient.id);
    const waitForReply = requestedWait && !dependencyCycle;
    const message = await withCurrentActivation(context, () => publishConversationMessage({
      ownerId: context.ownerId,
      conversationId: context.conversationId,
      senderType: "agent",
      senderId: context.agentId,
      recipientType: toHuman ? "human" : "agent",
      recipientId: recipient.id,
      ...(inReplyTo ? { inReplyTo } : {}),
      metadata: context.incomingMessageId ? { parentRequestId: context.incomingMessageId } : {},
      content: args.content,
      summary: args.summary,
      artifacts,
    }));
    if (!toHuman) {
      const { dispatchNextAgentTask } = await import("@/lib/server/task-dispatcher");
      await dispatchNextAgentTask({
        ownerId: context.ownerId,
        agentId: recipient.id,
      });
    }
    if (!waitForReply) {
      return {
        status: toHuman ? "delivered" : "queued",
        messageId: message.id,
        conversationId: message.conversationId,
        to: toHuman ? "user" : recipient.id,
        ...(dependencyCycle ? { waitSkipped: "dependency_cycle", advice: "The recipient is an ancestor of this task. The message is queued; finish this activation so blocked peers can continue." } : {}),
      };
    }
    const replies = await waitForMessages(context, {
      fromAgentId: recipient.id,
      inReplyTo: message.id,
      timeoutSeconds: remainingPeerWaitSeconds(message.createdAt, args.timeout_s),
    });
    return {
      status: replies.length > 0 ? "replied" : "timeout",
      messageId: message.id,
      conversationId: message.conversationId,
      to: recipient.id,
      replies,
      ...(replies.length === 0 ? { requestPreserved: true, advice: "The request remains queued or running. After at most 60 seconds, finish this activation with useful partial results; collect the correlated reply in a later activation without sending the request again." } : {}),
    };
  }

  if (operation === "wait") {
    const args = waitSchema.parse(rawArguments);
    const from = args.from_agent
      ? await resolveAgentRecipient(context.ownerId, context.agentId, args.from_agent)
      : undefined;
    const budget = args.reply_to ? await boundedReplyWait(context, args.reply_to, args.timeout_s) : undefined;
    const messages = await waitForMessages(context, {
      fromAgentId: from?.id,
      inReplyTo: args.reply_to,
      timeoutSeconds: budget?.timeoutSeconds ?? args.timeout_s,
    });
    return {
      status: messages.length > 0 ? "received" : "timeout",
      messages,
      ...(messages.length === 0 && budget && Date.now() >= budget.deadline ? { waitExhausted: true } : {}),
    };
  }

  if (operation === "progress") {
    return withCurrentActivation(context, () => executeTaskProgress(context, rawArguments, artifacts));
  }

  if (operation === "complete") {
    return executeTaskCompletion(context, rawArguments, artifacts);
  }

  if (operation === "fail") {
    return executeTaskFailure(context, rawArguments);
  }

  throw new Error(`Unknown message operation: ${operation}`);
}
