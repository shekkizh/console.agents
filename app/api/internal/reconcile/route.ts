import { authorizedReconciler } from "@/lib/server/cron-auth";
import { reconcileAgentTasks } from "@/lib/server/reconciler";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!authorizedReconciler(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const result = await reconcileAgentTasks();
  return Response.json(result, { status: result.failed ? 503 : 200 });
}
