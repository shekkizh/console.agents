import { after, NextResponse } from "next/server";
import { z } from "zod";
import { capturePeerArtifact, type CapturedArtifact } from "@/lib/server/artifact-capture";
import { isAgentActivationActive } from "@/lib/server/agent-activation";
import { withAgentLifecycleLock } from "@/lib/server/agent-lifecycle";
import { verifyAgentMessageToken } from "@/lib/server/message-auth";
import { executeMessageOperation } from "@/lib/server/message-runtime";
import { reconcileAgentTasks } from "@/lib/server/reconciler";

export const maxDuration = 300;

const requestSchema = z.object({
  operation: z.enum(["list", "send", "wait", "progress", "complete", "fail"]),
  arguments: z.record(z.unknown()),
}).strict();

const uploadedArtifactSchema = z.object({
  path: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(120).optional(),
  content_base64: z.string().max(4_200_000),
}).strict();

const uploadedArtifactsSchema = z.array(uploadedArtifactSchema).max(4);
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

function bearerToken(request: Request): string | undefined {
  return request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Peer artifact content is not valid base64");
  }
  const content = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(content).toString("base64") !== value) {
    throw new Error("Peer artifact content is not valid base64");
  }
  return content;
}

function uploadedArtifacts(value: unknown): CapturedArtifact[] {
  const files = uploadedArtifactsSchema.parse(value ?? []);
  const artifacts: CapturedArtifact[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const content = decodeBase64(file.content_base64);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_UPLOAD_BYTES) throw new Error("Peer artifacts exceed 3 MB");
    artifacts.push(capturePeerArtifact({
      path: file.path,
      title: file.title,
      content,
    }));
  }
  return artifacts;
}

export async function POST(request: Request) {
  const token = bearerToken(request);
  const claims = token ? verifyAgentMessageToken(token) : undefined;
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = requestSchema.parse(await request.json());
    if (["complete", "fail"].includes(body.operation) && claims.lifecycle !== true) {
      return NextResponse.json({ error: "Only the Console launcher can finish a task. Return your final answer to your parent or the launcher." }, { status: 403 });
    }
    if (!["complete", "fail"].includes(body.operation) && !await isAgentActivationActive(claims)) {
      return NextResponse.json({ error: "This activation is no longer active" }, { status: 403 });
    }
    const args = { ...body.arguments };
    const artifacts = ["send", "progress", "complete"].includes(body.operation)
      ? uploadedArtifacts(args.artifacts)
      : [];
    delete args.artifacts;
    const execute = () => executeMessageOperation(
      {
        ownerId: claims.ownerId,
        agentId: claims.agentId,
        conversationId: claims.conversationId,
        incomingMessageId: claims.incomingMessageId,
        incomingFromAgentId: claims.incomingFromAgentId,
        abortSignal: request.signal,
      },
      body.operation,
      args,
      artifacts,
    );
    const result = ["complete", "fail"].includes(body.operation)
      ? await withAgentLifecycleLock({ ownerId: claims.ownerId, agentId: claims.agentId }, execute)
      : await execute();
    if (
      ["complete", "fail"].includes(body.operation) &&
      result && typeof result === "object" &&
      "status" in result && ["completed", "failed", "already_completed", "already_failed"].includes(String(result.status))
    ) {
      // The owner's agents can have queued work in other conversations, so resume
      // work across conversations now that there is no recurring reconcile cron.
      after(() =>
        reconcileAgentTasks({
          ownerId: claims.ownerId,
          includeActive: false,
        }).catch((error) => console.error("agent-task.settlement.failed", { agentId: claims.agentId, error }))
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent messaging failed" },
      { status: 400 },
    );
  }
}
