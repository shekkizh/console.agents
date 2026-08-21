import { verifyToken } from "@clerk/backend";
import type { AuthFn } from "eve/channels/auth";
import { extractBearerToken } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import {
  config,
  requireClerkSecretKey,
  requireE2ETestIdentity,
} from "@/lib/server/config";
import { recordIncomingAgentMessage } from "@/lib/server/agent-store";
import {
  flattenInboundMessage,
  validConsoleMessageId,
} from "@/lib/inbound-message";
import { authorizedE2ETestRequest } from "@/lib/server/e2e-auth";

function selectedAgentAttributes(request: Request) {
  const agentId = request.headers.get("x-console-agent-id")?.trim();
  const conversationId = request.headers.get("x-console-conversation-id")?.trim();
  const messageId = request.headers.get("x-console-message-id")?.trim();
  if (!agentId || !conversationId) return null;
  return {
    agentId,
    conversationId,
    ...(validConsoleMessageId(messageId) ? { messageId } : {}),
  };
}

function e2eBearer(): AuthFn<Request> {
  return async (request) => {
    if (!authorizedE2ETestRequest(request)) return null;
    const attributes = selectedAgentAttributes(request);
    if (!attributes) return null;
    const { ownerId } = requireE2ETestIdentity();
    return {
      attributes,
      authenticator: "e2e-test",
      principalId: ownerId,
      principalType: "user",
      subject: ownerId,
    };
  };
}

function clerkBearer(): AuthFn<Request> {
  return async (request) => {
    const bearer = extractBearerToken(request.headers.get("authorization"));
    if (!bearer) return null;
    try {
      const payload = await verifyToken(bearer, { secretKey: requireClerkSecretKey() });
      const attributes = selectedAgentAttributes(request);
      if (!payload.sub || !attributes) return null;
      return {
        attributes,
        authenticator: "clerk",
        issuer: payload.iss,
        principalId: payload.sub,
        principalType: "user",
        subject: payload.sub,
      };
    } catch {
      return null;
    }
  };
}

export default eveChannel({
  auth: config.e2eTestMode ? [e2eBearer()] : [clerkBearer()],
  turnPolicy: "queue",
  async onMessage(ctx, message) {
    const principal = ctx.eve.caller;
    const agentId = principal?.attributes.agentId;
    const conversationId = principal?.attributes.conversationId;
    const messageId = principal?.attributes.messageId;
    if (
      !principal ||
      typeof agentId !== "string" ||
      typeof conversationId !== "string" ||
      typeof messageId !== "string"
    ) {
      throw new Error("A valid mailbox message id is required");
    }
    const text = flattenInboundMessage(message);
    await recordIncomingAgentMessage({
      ownerId: principal.principalId,
      agentId,
      conversationId,
      messageId,
      message: text,
      eveSessionId: ctx.eve.sessionId,
    });
    return { auth: principal };
  },
});
