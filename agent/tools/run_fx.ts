import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  claimAgentSession,
  getAgent,
} from "@/lib/server/agent-store";
import {
  isMessageDeliveryPending,
  markMessageDelivery,
  nextPendingAgentMessage,
  publishConversationMessage,
} from "@/lib/server/message-store";
import { wakeMessage } from "@/lib/server/message-runtime";
import { getConversation } from "@/lib/server/conversation-store";
import { runFxTurn } from "@/lib/server/fx-runtime";
import { drainMailbox } from "@/lib/server/mailbox-drain";
import { config } from "@/lib/server/config";
import { runE2EFakeFxTurn } from "@/lib/server/e2e-fx";
import { storeAgentArtifacts } from "@/lib/server/artifact-store";

function selectedAttribute(
  attributes: Readonly<Record<string, string | readonly string[]>>,
  name: string,
  error: string,
): string {
  const value = attributes[name];
  if (typeof value !== "string" || !value) throw new Error(error);
  return value;
}

export default defineTool({
  description: "Drain the selected conversation's durable mailbox through its persistent fx agent.",
  inputSchema: z.object({}),
  async *execute(_input, ctx) {
    const principal = ctx.session.auth.current;
    if (!principal) throw new Error("Authenticated user required");
    const agentId = selectedAttribute(principal.attributes, "agentId", "No fx agent was selected");
    const conversationId = selectedAttribute(
      principal.attributes,
      "conversationId",
      "No conversation was selected",
    );
    let agent = await claimAgentSession(principal.principalId, agentId, ctx.session.id);
    const conversation = await getConversation(principal.principalId, conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const sandbox = config.e2eFakeFx ? undefined : await ctx.getSandbox();
    let processed = 0;

    const activations = drainMailbox({
      abortSignal: ctx.abortSignal,
      next: () =>
        nextPendingAgentMessage({
          ownerId: principal.principalId,
          agentId,
          conversationId,
        }),
      activate: async (request) => {
        const replyId = (kind: "reply" | "error") => {
          const hex = createHash("sha256")
            .update(`${kind}:\0${principal.principalId}:\0${agentId}:\0${request.id}`)
            .digest("hex")
            .slice(0, 32);
          return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
        };
        const recipientType = request.senderType === "agent" ? "agent" as const : "human" as const;
        const recipientId = request.senderType === "agent"
          ? request.senderId
          : principal.principalId;
        try {
          const result = config.e2eFakeFx
            ? await runE2EFakeFxTurn({
                agent,
                prompt: request.content,
                abortSignal: ctx.abortSignal,
              })
            : await runFxTurn({
                ownerId: principal.principalId,
                agent,
                conversationId,
                prompt: request.content,
                incomingMessageId: request.id,
                incomingFromAgentId: request.senderType === "agent"
                  ? request.senderId
                  : undefined,
                sandbox: sandbox!,
                abortSignal: ctx.abortSignal,
              });
          if (!await isMessageDeliveryPending(principal.principalId, request.id, agentId)) {
            return {
              answer: "Task stopped.",
              requestId: request.id,
              model: result.model,
              steps: result.steps,
              controlPlaneChanges: [],
              failed: false,
            };
          }
          const artifacts = recipientType === "human" && result.artifacts.length > 0
            ? await storeAgentArtifacts({
                ownerId: principal.principalId,
                agentId,
                conversationId,
                requestId: request.id,
                artifacts: result.artifacts,
              })
            : [];
          const response = await publishConversationMessage({
            ownerId: principal.principalId,
            id: replyId("reply"),
            conversationId,
            senderType: "agent",
            senderId: agentId,
            recipientType,
            recipientId,
            inReplyTo: request.id,
            content: result.output,
            metadata: {
              model: result.model,
              sessionId: result.sessionId,
              steps: result.steps,
              controlPlaneChanges: result.controlPlaneChanges,
              artifacts,
            },
            artifacts: recipientType === "agent" ? result.artifacts : [],
          });
          await markMessageDelivery(
            principal.principalId,
            request.id,
            agentId,
            "completed",
          );
          if (response.recipientType === "agent") {
            await wakeMessage({ ownerId: principal.principalId, message: response });
          }
          return {
            answer: result.output,
            requestId: request.id,
            model: result.model,
            steps: result.steps,
            controlPlaneChanges: result.controlPlaneChanges,
            failed: false,
          };
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          if (!await isMessageDeliveryPending(principal.principalId, request.id, agentId)) {
            return {
              answer: "Task stopped.",
              requestId: request.id,
              model: "unavailable",
              steps: 0,
              controlPlaneChanges: [],
              failed: false,
            };
          }
          const diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          const answer =
            "The agent could not complete this request. Your message was preserved and can be retried safely.";
          const response = await publishConversationMessage({
            ownerId: principal.principalId,
            id: replyId("error"),
            conversationId,
            senderType: "agent",
            senderId: agentId,
            recipientType,
            recipientId,
            kind: "error",
            inReplyTo: request.id,
            content: answer,
            metadata: { diagnostic },
          });
          await markMessageDelivery(
            principal.principalId,
            request.id,
            agentId,
            "failed",
            diagnostic,
          );
          if (response.recipientType === "agent") {
            await wakeMessage({ ownerId: principal.principalId, message: response });
          }
          return {
            answer,
            requestId: request.id,
            model: "unavailable",
            steps: 0,
            controlPlaneChanges: [],
            failed: true,
          };
        }
      },
    });

    for await (const activation of activations) {
      processed += 1;
      yield { ...activation, processed };
      agent = (await getAgent(principal.principalId, agentId)) ?? agent;
    }

    if (processed === 0) {
      yield {
        answer: "__CONSOLE_MAILBOX_IDLE__",
        requestId: null,
        model: "unavailable",
        steps: 0,
        controlPlaneChanges: [],
        failed: false,
        processed,
      };
    }
  },
  toModelOutput(output) {
    if (output.answer === "__CONSOLE_MAILBOX_IDLE__") {
      return {
        type: "text",
        value: "Return exactly __CONSOLE_MAILBOX_IDLE__ and nothing else.",
      };
    }
    if (output.failed) {
      return {
        type: "text",
        value: `${output.answer}\n\nReturn only the answer above verbatim.`,
      };
    }
    return {
      type: "text",
      value: `${output.answer}\n\nReturn only the answer above verbatim.`,
    };
  },
});
