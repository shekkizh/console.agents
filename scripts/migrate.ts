import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { databaseUrl } from "../lib/server/config.ts";

const resolvedDatabaseUrl = databaseUrl();
if (!resolvedDatabaseUrl) throw new Error("DATABASE_URL is required");

const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const schema = await readFile(schemaPath, "utf8");
const statements = schema
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

const sql = neon(resolvedDatabaseUrl);
await sql.transaction(statements.map((statement) => sql.query(statement)));

const rows = await sql.query(
  `SELECT column_name
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'agents'
   ORDER BY ordinal_position`,
);
const columns = new Set(rows.map((row) => String((row as { column_name: unknown }).column_name)));
for (const required of ["fx_config", "config_version", "created_by_agent_id", "enabled"]) {
  if (!columns.has(required)) throw new Error(`Migration verification failed: missing ${required}`);
}

const conversationRows = await sql.query(
  `SELECT to_regclass('public.conversations') AS relation`,
);
if (!(conversationRows[0] as { relation?: unknown } | undefined)?.relation) {
  throw new Error("Migration verification failed: missing conversations table");
}

for (const table of [
  "agent_events",
  "conversation_messages",
  "message_deliveries",
  "message_artifacts",
]) {
  const messageRows = await sql.query(
    `SELECT to_regclass($1) AS relation`,
    [`public.${table}`],
  );
  if (!(messageRows[0] as { relation?: unknown } | undefined)?.relation) {
    throw new Error(`Migration verification failed: missing ${table} table`);
  }
}

const activeIndexRows = await sql.query(
  `SELECT to_regclass('public.message_deliveries_one_active_agent_idx') AS relation`,
);
if (!(activeIndexRows[0] as { relation?: unknown } | undefined)?.relation) {
  throw new Error("Migration verification failed: missing active-agent delivery index");
}

console.log(`Database schema is current (${statements.length} statements applied).`);
