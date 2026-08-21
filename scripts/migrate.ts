import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const schemaPath = fileURLToPath(new URL("../db/schema.sql", import.meta.url));
const schema = await readFile(schemaPath, "utf8");
const statements = schema
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

const sql = neon(databaseUrl);
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

const artifactRows = await sql.query(
  `SELECT to_regclass('public.agent_artifacts') AS relation`,
);
if (!(artifactRows[0] as { relation?: unknown } | undefined)?.relation) {
  throw new Error("Migration verification failed: missing agent_artifacts table");
}

console.log(`Database schema is current (${statements.length} statements applied).`);
