import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authorizedE2ETestRequest } from "@/lib/server/e2e-auth";
import { config as serverConfig } from "@/lib/server/config";

const hasClerk = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

export default serverConfig.e2eTestMode
  ? function e2eTestProxy(request: NextRequest) {
      return authorizedE2ETestRequest(request)
        ? NextResponse.next()
        : new NextResponse("Unauthorized", { status: 401 });
    }
  : hasClerk
  ? clerkMiddleware(async (auth) => {
      await auth.protect();
    })
  : function unconfiguredProxy() {
      return new NextResponse("Console is not configured: Clerk environment variables are required.", {
        status: 503,
      });
    };

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|eve)(.*)",
  ],
};
