import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@neondatabase/serverless";
import { requireDatabaseListenerUrl } from "@/lib/server/config";

const heldLocks = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

/** One database session owns an agent's launch, stop, recovery and settlement. */
export async function withAgentLifecycleLock<T>(
  input: { ownerId: string; agentId: string },
  operation: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([input.ownerId, input.agentId]);
  const held = heldLocks.getStore();
  if (held?.get(key)?.active) return operation();
  const scope = { active: true };
  const client = new Client({ connectionString: requireDatabaseListenerUrl() });
  // Handle transport errors without an unhandled EventEmitter exception.
  let connectionError: Error | undefined;
  client.on("error", (error: Error) => { connectionError = error; scope.active = false; });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '15s'");
    await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
      `console-lifecycle:${input.ownerId}`, input.agentId,
    ]);
    if (connectionError) throw connectionError;
    const result = await heldLocks.run(new Map([...(held ?? []), [key, scope]]), operation);
    if (connectionError) throw connectionError;
    return result;
  } finally {
    scope.active = false;
    // Closing the dedicated session releases its advisory locks even on failure.
    await client.end().catch(() => undefined);
  }
}
