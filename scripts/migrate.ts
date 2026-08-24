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

const existingDeliveryColumns = await sql.query(
  `SELECT column_name
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'message_deliveries'`,
);
const deliveryColumns = new Set(
  existingDeliveryColumns.map((row) => String((row as { column_name: unknown }).column_name)),
);
if (deliveryColumns.size > 0 && !deliveryColumns.has("recipient_type")) {
  const legacyRows = await sql.query(
    `SELECT to_regclass('public.task_message_deliveries') AS relation`,
  );
  if ((legacyRows[0] as { relation?: unknown } | undefined)?.relation) {
    throw new Error(
      "Migration cannot preserve the legacy message_deliveries table: task_message_deliveries already exists",
    );
  }
  await sql.transaction([
    sql.query("ALTER TABLE message_deliveries RENAME TO task_message_deliveries"),
    sql.query(
      "ALTER INDEX IF EXISTS message_deliveries_pkey RENAME TO task_message_deliveries_pkey",
    ),
    sql.query(
      "ALTER INDEX IF EXISTS message_deliveries_inbox_idx RENAME TO task_message_deliveries_inbox_idx",
    ),
    sql.query(
      `ALTER INDEX IF EXISTS message_deliveries_message_id_participant_id_key
       RENAME TO task_message_deliveries_message_participant_key`,
    ),
  ]);
}

await sql.transaction(statements.map((statement) => sql.query(statement)));

const rows = await sql.query(
  `SELECT column_name
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'agents'
   ORDER BY ordinal_position`,
);
const columns = new Set(rows.map((row) => String((row as { column_name: unknown }).column_name)));
for (const required of ["fx_config", "config_version", "eve_session_id", "enabled"]) {
  if (!columns.has(required)) throw new Error(`Migration verification failed: missing ${required}`);
}

const conversationRows = await sql.query(
  `SELECT to_regclass('public.conversations') AS relation`,
);
if (!(conversationRows[0] as { relation?: unknown } | undefined)?.relation) {
  throw new Error("Migration verification failed: missing conversations table");
}

const runtimeVersionRows = await sql.query(
  `SELECT column_default
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'conversations'
     AND column_name = 'runtime_version'`,
);
if (!runtimeVersionRows[0]) {
  throw new Error("Migration verification failed: missing conversations.runtime_version");
}

for (const table of [
  "agent_artifacts",
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

console.log(`Database schema is current (${statements.length} statements applied).`);
