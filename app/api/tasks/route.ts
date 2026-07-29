import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/server/auth";
import { createTask } from "@/lib/server/store";

const createTaskSchema = z.object({
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().min(4).max(8_000),
  agentId: z.string().trim().min(1).max(80),
  repositoryUrl: z.string().trim().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  }, "Use an HTTPS github.com repository URL").optional().or(z.literal("").transform(() => undefined)),
});

export async function POST(request: Request) {
  try {
    const ownerId = await requireOwner();
    const input = createTaskSchema.parse(await request.json());
    return NextResponse.json(await createTask(ownerId, input), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create task";
    return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 400 });
  }
}
