import "server-only";

import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { config, requireE2ETestIdentity } from "@/lib/server/config";
import { authorizedE2ETestRequest } from "@/lib/server/e2e-auth";

export async function requireOwner(): Promise<string> {
  if (config.e2eTestMode) {
    const requestHeaders = await headers();
    const request = new Request("http://console.test", { headers: requestHeaders });
    if (!authorizedE2ETestRequest(request)) throw new Error("Unauthorized");
    return requireE2ETestIdentity().ownerId;
  }
  if (!config.clerkEnabled) throw new Error("Clerk authentication is required");
  const session = await auth();
  if (!session.userId) throw new Error("Unauthorized");
  return session.userId;
}
