import "server-only";

import { auth } from "@clerk/nextjs/server";
import { config } from "@/lib/server/config";

export async function requireOwner(): Promise<string> {
  if (!config.clerkEnabled) {
    throw new Error("Clerk authentication is required");
  }

  const session = await auth();
  if (!session.userId) throw new Error("Unauthorized");

  return session.userId;
}
