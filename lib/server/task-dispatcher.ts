import { createHash } from "node:crypto";
import { acquireAgentSandbox } from "@/lib/server/agent-sandbox";
import { getAgent, listAgents } from "@/lib/server/agent-store";
import { config } from "@/lib/server/config";
import { runE2EFakeFxTurn } from "@/lib/server/e2e-fx";
import {
  finalizeDetachedFxTurn,
  launchFxTurn,
  recoverDetachedFxCompletion,
} from "@/lib/server/fx-runtime";
import { executeMessageOperation, formatMessageEnvelope } from "@/lib/server/message-runtime";
import {
  getActiveConversationDelivery,
  hasActiveAgentDelivery,
  isMessageDeliveryPending,
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "@/lib/server/message-store";

export type DispatchOutcome =
  | { status: "idle" | "active" }
  | { status: "started"; messageId: string; sandboxId: string; processId?: string }
  | { status: "completed"; messageId: string }
  | { status: "failed"; messageId: string; error: string };

function correlatedErrorId(ownerId: string, agentId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update("error:\0" + ownerId + ":\0" + agentId + ":\0" + requestId)
    .digest("hex")
    .slice(0, 32);
  return (
    hex.slice(0, 8) + "-" +
    hex.slice(8, 12) + "-4" +
    hex.slice(13, 16) + "-a" +
    hex.slice(17, 20) + "-" +
    hex.slice(20)
  );
}

export async function dispatchNextAgentTask(input: {
  ownerId: string;
  agentId: string;
}): Promise<DispatchOutcome> {
  const agent = await getAgent(input.ownerId, input.agentId);
  if (!agent?.enabled) return { status: "idle" };
  const request = await nextPendingAgentMessage({
    ownerId: input.ownerId,
    agentId: input.agentId,
  });
  if (!request) {
    return {
      status: await hasActiveAgentDelivery(input.ownerId, input.agentId)
        ? "active"
        : "idle",
    };
  }

  if (!await isMessageDeliveryPending(input.ownerId, request.id, input.agentId)) {
    return { status: "idle" };
  }

  try {
    if (config.e2eFakeFx) {
      await markMessageDelivery(input.ownerId, request.id, input.agentId, "running");
      const result = await runE2EFakeFxTurn({ agent, prompt: request.content });
      if (!await isMessageDeliveryPending(input.ownerId, request.id, input.agentId)) {
        return { status: "idle" };
      }
      await executeMessageOperation(
        {
          ownerId: input.ownerId,
          agentId: input.agentId,
          conversationId: request.conversationId,
          incomingMessageId: request.id,
          incomingFromAgentId: request.senderType === "agent"
            ? request.senderId
            : undefined,
        },
        "complete",
        { content: result.output, session_id: result.sessionId },
        result.artifacts,
      );
      await dispatchNextAgentTask(input);
      return { status: "completed", messageId: request.id };
    }

    console.info("agent-task.launch.started", {
      messageId: request.id,
      agentId: input.agentId,
    });
    const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
    console.info("agent-task.sandbox.ready", {
      messageId: request.id,
      agentId: input.agentId,
      sandboxId: sandbox.id,
    });
    const launch = await launchFxTurn({
      ownerId: input.ownerId,
      agent,
      conversationId: request.conversationId,
      prompt: await formatMessageEnvelope({ ownerId: input.ownerId, message: request }),
      incomingMessageId: request.id,
      incomingFromAgentId: request.senderType === "agent" ? request.senderId : undefined,
      sandbox,
    });
    await markMessageDelivery(input.ownerId, request.id, input.agentId, "running");
    console.info("agent-task.launch.completed", {
      messageId: request.id,
      agentId: input.agentId,
      sandboxId: launch.sandboxId,
      processId: launch.processId,
    });
    return {
      status: "started",
      messageId: request.id,
      sandboxId: launch.sandboxId,
      processId: launch.processId,
    };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.name + ": " + error.message : String(error);
    console.error("agent-task.launch.failed", {
      messageId: request.id,
      agentId: input.agentId,
      diagnostic,
    });
    if (await isMessageDeliveryPending(input.ownerId, request.id, input.agentId)) {
      await publishConversationMessage({
        ownerId: input.ownerId,
        id: correlatedErrorId(input.ownerId, input.agentId, request.id),
        conversationId: request.conversationId,
        senderType: "agent",
        senderId: input.agentId,
        recipientType: request.senderType === "agent" ? "agent" : "human",
        recipientId: request.senderType === "agent" ? request.senderId : input.ownerId,
        kind: "error",
        inReplyTo: request.id,
        content: "The agent could not start this request. Your message was preserved and can be retried safely.",
        metadata: { diagnostic },
      });
      await markMessageDelivery(
        input.ownerId,
        request.id,
        input.agentId,
        "failed",
        diagnostic,
      );
      await dispatchNextAgentTask(input);
    }
    return { status: "failed", messageId: request.id, error: diagnostic };
  }
}

export async function settleCompletedAgentTask(input: {
  ownerId: string;
  agentId: string;
}): Promise<DispatchOutcome> {
  const agent = await getAgent(input.ownerId, input.agentId);
  if (!agent?.enabled) return { status: "idle" };

  if (!config.e2eFakeFx) {
    const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
    await finalizeDetachedFxTurn({ ownerId: input.ownerId, agent, sandbox });
  }

  const next = await dispatchNextAgentTask(input);
  if (!config.e2eFakeFx && next.status === "idle") {
    const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
    await sandbox.stop().catch(() => undefined);
    return { status: "idle" };
  }
  if (config.e2eFakeFx && next.status === "completed") {
    return settleCompletedAgentTask(input);
  }
  return next;
}

export async function recoverCompletedConversationTask(input: {
  ownerId: string;
  conversationId: string;
}): Promise<DispatchOutcome> {
  const delivery = await getActiveConversationDelivery(input.ownerId, input.conversationId);
  if (!delivery) return { status: "idle" };
  const agent = await getAgent(input.ownerId, delivery.agentId);
  if (!agent?.enabled) return { status: "idle" };

  const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
  const recovered = await recoverDetachedFxCompletion({
    sandbox,
    incomingMessageId: delivery.messageId,
  });
  if (!recovered || recovered === "running") {
    return { status: "started", messageId: delivery.messageId, sandboxId: sandbox.id };
  }

  await executeMessageOperation(
    {
      ownerId: input.ownerId,
      agentId: delivery.agentId,
      conversationId: input.conversationId,
      incomingMessageId: delivery.messageId,
    },
    "complete",
    { content: recovered.content, session_id: recovered.sessionId },
  );
  console.info("agent-task.recovery.completed", {
    messageId: delivery.messageId,
    agentId: delivery.agentId,
    conversationId: input.conversationId,
    sessionId: recovered.sessionId,
  });
  return { status: "completed", messageId: delivery.messageId };
}

export async function dispatchAllQueuedAgentTasks(ownerId: string): Promise<void> {
  const agents = await listAgents(ownerId);
  await Promise.allSettled(
    agents.filter((agent) => agent.enabled).map((agent) =>
      dispatchNextAgentTask({ ownerId, agentId: agent.id })
    ),
  );
}
