import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { verifyAgentMessageToken, verifyMessageWakeToken } from "@/lib/server/message-auth";
import { authorizedE2ETestRequest } from "@/lib/server/e2e-auth";
import { config as serverConfig } from "@/lib/server/config";

const hasClerk = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

function bearerToken(request: NextRequest): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function authorizedMessageWake(request: NextRequest): boolean {
  if (
    request.headers.get("x-console-message-wake") !== "1" ||
    !(request.nextUrl.pathname === "/eve" || request.nextUrl.pathname.startsWith("/eve/"))
  ) {
    return false;
  }
  const token = bearerToken(request);
  const claims = token ? verifyMessageWakeToken(token) : undefined;
  return Boolean(
    claims &&
    request.headers.get("x-console-agent-id") === claims.targetAgentId &&
    request.headers.get("x-console-conversation-id") === claims.conversationId &&
    request.headers.get("x-console-message-id") === claims.messageId
  );
}

function authorizedAgentMessageApi(request: NextRequest): boolean {
  if (request.nextUrl.pathname !== "/api/a2a") return false;
  const token = bearerToken(request);
  return Boolean(token && verifyAgentMessageToken(token));
}

export default serverConfig.e2eTestMode
  ? function e2eTestProxy(request: NextRequest) {
      return authorizedMessageWake(request) ||
          authorizedAgentMessageApi(request) ||
          authorizedE2ETestRequest(request)
        ? NextResponse.next()
        : new NextResponse("Unauthorized", { status: 401 });
    }
  : hasClerk
  ? clerkMiddleware(async (auth, request) => {
      if (authorizedMessageWake(request) || authorizedAgentMessageApi(request)) {
        return NextResponse.next();
      }
      await auth.protect();
    })
  : function unconfiguredProxy(request: NextRequest) {
      return authorizedAgentMessageApi(request)
        ? NextResponse.next()
        : new NextResponse("Console is not configured: Clerk environment variables are required.", {
            status: 503,
          });
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|eve)(.*)",
  ],
};
