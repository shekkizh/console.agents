import "server-only";

import { neon } from "@neondatabase/serverless";
import { requireDatabaseUrl } from "@/lib/server/config";

let schemaPromise: Promise<void> | undefined;

function database() { return neon(requireDatabaseUrl()); }

function ensureLeaseSchema(): Promise<void> {
  schemaPromise ??= (async () => {
    const sql = database();
    await sql`
      CREATE TABLE IF NOT EXISTS agent_sandbox_leases (
        owner_id text NOT NULL,
        agent_id text NOT NULL,
        lease_token uuid NOT NULL,
        lease_until timestamptz NOT NULL,
        acquired_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_id, agent_id)
      )`;
  })().catch((error) => { schemaPromise = undefined; throw error; });
  return schemaPromise;
}

/** Atomically claim exclusive use of one durable agent sandbox across all server instances. */
export async function acquireAgentSandboxLease(
  ownerId: string,
  agentId: string,
  durationMs: number,
): Promise<string | undefined> {
  await ensureLeaseSchema();
  const token = crypto.randomUUID();
  const sql = database();
  const rows = await sql`
    INSERT INTO agent_sandbox_leases (owner_id, agent_id, lease_token, lease_until)
    VALUES (${ownerId}, ${agentId}, ${token}, now() + ${durationMs} * interval '1 millisecond')
    ON CONFLICT (owner_id, agent_id) DO UPDATE SET
      lease_token = EXCLUDED.lease_token,
      lease_until = EXCLUDED.lease_until,
      acquired_at = now()
    WHERE agent_sandbox_leases.lease_until <= now()
    RETURNING lease_token`;
  return rows[0]?.lease_token ? String(rows[0].lease_token) : undefined;
}

/** Release only the lease owned by this run; an expired/reclaimed lease is never disturbed. */
export async function releaseAgentSandboxLease(ownerId: string, agentId: string, token: string): Promise<void> {
  const sql = database();
  await sql`DELETE FROM agent_sandbox_leases
    WHERE owner_id = ${ownerId} AND agent_id = ${agentId} AND lease_token = ${token}`;
}
