import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { runPeerChannel } from "@/lib/server/peer-runner";
import { getWorkspace } from "@/lib/server/store";

export const maxDuration = 300;

/** Resume a persisted channel inbox after a bounded drain or interrupted request. */
export async function GET(_request: Request, context: { params: Promise<{ channelId: string }> }) {
  try {
    const ownerId = await requireOwner();
    const { channelId } = await context.params;
    await runPeerChannel(ownerId, channelId);
    return NextResponse.json(await getWorkspace(ownerId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resume channel";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : message === "Channel not found" ? 404 : 400 });
  }
}
