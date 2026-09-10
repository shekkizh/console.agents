import { completionDestination } from "@/lib/message-protocol";
import { withAgentLifecycleLock } from "@/lib/server/agent-lifecycle";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { acquireAgentSandbox } from "@/lib/server/agent-sandbox";
import { getAgent, listAgents } from "@/lib/server/agent-store";
import { config } from "@/lib/server/config";
import { runE2EFakeFxTurn } from "@/lib/server/e2e-fx";
import {
  finalizeDetachedFxTurn,
  hasLiveFxWorker,
  launchFxTurn,
  recoverDetachedFxCompletion,
} from "@/lib/server/fx-runtime";
import { executeMessageOperation, formatMessageEnvelope } from "@/lib/server/message-runtime";
import {
  getActiveConversationDelivery,
  getActiveAgentDelivery,
  getUnsettledAgentDelivery,
  markAgentDeliverySettled,
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

async function dispatchNextAgentTaskLocked(input: {
  ownerId: string;
  agentId: string;
}): Promise<DispatchOutcome> {
  let agent = await getAgent(input.ownerId, input.agentId);
  if (!agent?.enabled) return { status: "idle" };
  const active = await getActiveAgentDelivery(input.ownerId, input.agentId);
  if (active) {
    if (config.e2eFakeFx || Date.now() - new Date(active.runningAt).getTime() < 30_000) return { status: "active" };
    await recoverCompletedConversationTaskLocked({ ownerId: input.ownerId, agentId: input.agentId, conversationId: active.conversationId });
    if (await hasActiveAgentDelivery(input.ownerId, input.agentId)) return { status: "active" };
  }
  let unsettled = await getUnsettledAgentDelivery(input.ownerId, input.agentId);
  while (unsettled) {
    if (!config.e2eFakeFx) {
      const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
      if (await hasLiveFxWorker(sandbox)) return { status: "active" };
      await finalizeDetachedFxTurn({ ownerId: input.ownerId, agent, sandbox });
    }
    await markAgentDeliverySettled(input.ownerId, input.agentId, unsettled.messageId);
    unsettled = await getUnsettledAgentDelivery(input.ownerId, input.agentId);
  }
  agent = await getAgent(input.ownerId, input.agentId);
  if (!agent?.enabled) return { status: "idle" };
  if (!config.e2eFakeFx) {
    const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
    if (await hasLiveFxWorker(sandbox)) return { status: "active" };
  }
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
        ...completionDestination(request, input.ownerId, input.agentId),
        kind: "error",
        inReplyTo: request.id,
        content: "The agent could not start this request. Your message was preserved and can be retried safely.",
        metadata: { diagnostic, messagePurpose: completionDestination(request, input.ownerId, input.agentId).messagePurpose },
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

export function dispatchNextAgentTask(input: { ownerId: string; agentId: string }): Promise<DispatchOutcome> {
  return withAgentLifecycleLock(input, () => dispatchNextAgentTaskLocked(input));
}

export function settleCompletedAgentTask(input: { ownerId: string; agentId: string }): Promise<DispatchOutcome> {
  return withAgentLifecycleLock(input, async () => {
    let next = await dispatchNextAgentTaskLocked(input);
    // The launcher can still be exiting just after the HTTP callback returns.
    // Retry settlement briefly here rather than relying on a recurring cron.
    for (let attempt = 0; next.status === "active" && attempt < 3; attempt++) {
      if (await hasActiveAgentDelivery(input.ownerId, input.agentId) ||
          !await getUnsettledAgentDelivery(input.ownerId, input.agentId)) break;
      await delay(250);
      next = await dispatchNextAgentTaskLocked(input);
    }
    if (!config.e2eFakeFx && next.status === "idle") {
      const agent = await getAgent(input.ownerId, input.agentId);
      if (agent) {
        const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
        if (!await hasLiveFxWorker(sandbox)) await sandbox.stop();
      }
    }
    return next;
  });
}

async function recoverCompletedConversationTaskLocked(input: {
  ownerId: string;
  conversationId: string;
  agentId: string;
}): Promise<Exclude<DispatchOutcome, { status: "completed" | "failed" }> | { status: "completed" | "failed"; messageId: string; agentId: string }> {
  if (config.e2eFakeFx) return { status: "active" };
  const delivery = await getActiveAgentDelivery(input.ownerId, input.agentId);
  if (!delivery || delivery.conversationId !== input.conversationId) return { status: "idle" };
  // Give a newly detached launcher time to publish its PID before probing it.
  if (Date.now() - new Date(delivery.runningAt).getTime() < 30_000) return { status: "active" };
  const agent = await getAgent(input.ownerId, delivery.agentId);
  if (!agent?.enabled) return { status: "idle" };

  const sandbox = await acquireAgentSandbox({ ownerId: input.ownerId, agent });
  const recovered = await recoverDetachedFxCompletion({
    sandbox,
    incomingMessageId: delivery.messageId,
  });
  if (recovered === "running") {
    return { status: "started", messageId: delivery.messageId, sandboxId: sandbox.id };
  }

  if (!recovered || "failed" in recovered) {
    await executeMessageOperation(
      { ownerId: input.ownerId, agentId: delivery.agentId, conversationId: input.conversationId, incomingMessageId: delivery.messageId },
      "fail",
      { content: recovered?.content ?? "The FX worker stopped without a final response. Your request is preserved; inspect the sandbox job logs and retry." },
    );
    return { status: "failed", messageId: delivery.messageId, agentId: delivery.agentId };
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
    recovered.artifacts,
  );
  console.info("agent-task.recovery.completed", {
    messageId: delivery.messageId,
    agentId: delivery.agentId,
    conversationId: input.conversationId,
    sessionId: recovered.sessionId,
  });
  return { status: "completed", messageId: delivery.messageId, agentId: delivery.agentId };
}

export async function dispatchAllQueuedAgentTasks(ownerId: string): Promise<void> {
  const agents = await listAgents(ownerId);
  const enabled = agents.filter((agent) => agent.enabled);
  const outcomes = await Promise.allSettled(enabled.map((agent) =>
    dispatchNextAgentTask({ ownerId, agentId: agent.id })
  ));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") console.error("agent-task.dispatch.failed", {
      agentId: enabled[index].id,
      error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
  });
}

export async function recoverCompletedConversationTask(input: { ownerId: string; conversationId: string }) {
  const delivery = await getActiveConversationDelivery(input.ownerId, input.conversationId);
  if (!delivery) return { status: "idle" as const };
  return withAgentLifecycleLock({ ownerId: input.ownerId, agentId: delivery.agentId }, () => recoverCompletedConversationTaskLocked({ ...input, agentId: delivery.agentId }));
}
