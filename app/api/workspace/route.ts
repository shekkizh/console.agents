import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/server/auth";
import { getWorkspace } from "@/lib/server/store";

export async function GET() {
  try {
    const ownerId = await requireOwner();
    return NextResponse.json(await getWorkspace(ownerId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load workspace" }, { status: 401 });
  }
}
