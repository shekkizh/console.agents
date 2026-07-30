import { NextResponse } from "next/server";
import { z } from "zod";
import { createChannel } from "@/lib/server/channel-store";
import { requireOwner } from "@/lib/server/auth";
import { runPeerChannel } from "@/lib/server/peer-runner";
import { getWorkspace } from "@/lib/server/store";

export const maxDuration = 300;

const createChannelSchema = z.object({
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().min(1).max(20_000),
  agentIds: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  repositoryUrl: z.string().trim().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  }, "Use an HTTPS github.com repository URL").optional().or(z.literal("").transform(() => undefined)),
});

export async function GET() {
  try {
    const ownerId = await requireOwner();
    return NextResponse.json(await getWorkspace(ownerId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to list channels";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const channel = await createChannel(ownerId, createChannelSchema.parse(await request.json()));
    await runPeerChannel(ownerId, channel.id);
    return NextResponse.json({ channelId: channel.id, snapshot: await getWorkspace(ownerId) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create channel";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
