import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  getAgent,
  nextPendingAgentMessage,
  recordAgentEvent,
} from "@/lib/server/agent-store";
import { claimConversationSession } from "@/lib/server/conversation-store";
import { runFxTurn } from "@/lib/server/fx-runtime";
import { drainMailbox } from "@/lib/server/mailbox-drain";
import { config } from "@/lib/server/config";
import { runE2EFakeFxTurn } from "@/lib/server/e2e-fx";

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
    let { agent } = await claimConversationSession({
      ownerId: principal.principalId,
      conversationId,
      agentId,
      eveSessionId: ctx.session.id,
    });
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
        try {
          const result = config.e2eFakeFx
            ? await runE2EFakeFxTurn({
                agent,
                prompt: request.message,
                abortSignal: ctx.abortSignal,
              })
            : await runFxTurn({
                ownerId: principal.principalId,
                agent,
                prompt: request.message,
                sandbox: sandbox!,
                abortSignal: ctx.abortSignal,
              });
          await recordAgentEvent({
            ownerId: principal.principalId,
            agentId,
            conversationId,
            actorType: "agent",
            actorId: agentId,
            eventType: "message.assistant",
            payload: {
              message: result.output,
              requestId: request.requestId,
              model: result.model,
              sessionId: result.sessionId,
              steps: result.steps,
              controlPlaneChanges: result.controlPlaneChanges,
            },
          });
          return {
            answer: result.output,
            requestId: request.requestId,
            model: result.model,
            steps: result.steps,
            controlPlaneChanges: result.controlPlaneChanges,
            failed: false,
          };
        } catch (error) {
          ctx.abortSignal.throwIfAborted();
          const diagnostic = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          const answer =
            "The agent could not complete this request. Your message was preserved and can be retried safely.";
          await recordAgentEvent({
            ownerId: principal.principalId,
            agentId,
            conversationId,
            actorType: "eve",
            actorId: ctx.session.id,
            eventType: "message.failed",
            payload: { diagnostic, requestId: request.requestId },
          });
          return {
            answer,
            requestId: request.requestId,
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
