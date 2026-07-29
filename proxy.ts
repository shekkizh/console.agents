import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const hasClerk = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
const isAgentPlatformRoute = createRouteMatcher(["/api/agent-platform(.*)"]);

export default hasClerk
  ? clerkMiddleware(async (auth, request) => {
      if (!isAgentPlatformRoute(request)) await auth.protect();
    })
  : function unconfiguredProxy() {
      return new NextResponse("Console is not configured: Clerk environment variables are required.", { status: 503 });
    };

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)", "/(api|trpc)(.*)"],
};
