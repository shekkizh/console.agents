import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8");

function tableDefinition(name: string) {
  const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `${name} must be persisted in the database schema`);
  return match[1];
}

test("peer identity and addressed messages are durable channel data", () => {
  const members = tableDefinition("channel_members");
  assert.match(members, /participant_id text NOT NULL/);
  assert.match(members, /participant_type text NOT NULL CHECK \(participant_type IN \('human', 'agent'\)\)/);
  assert.match(members, /display_name text NOT NULL/);
  assert.doesNotMatch(members, /parent|child|lead/, "channel membership must not encode an agent hierarchy");

  assert.match(schema, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_id text/);
  assert.match(schema, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_type text/);
  assert.match(schema, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_ids text\[\]/);
  assert.match(schema, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery text/);
  assert.match(schema, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages\(id\)/);
});

test("agent inbox deliveries are persisted and claimable in FIFO order", () => {
  const deliveries = tableDefinition("message_deliveries");
  assert.match(deliveries, /message_id uuid NOT NULL REFERENCES messages\(id\) ON DELETE CASCADE/);
  assert.match(deliveries, /participant_id text NOT NULL/);
  assert.match(deliveries, /status text NOT NULL DEFAULT 'queued'/);
  assert.match(deliveries, /available_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(deliveries, /claimed_at timestamptz/);
  assert.match(deliveries, /delivered_at timestamptz/);
  assert.match(deliveries, /UNIQUE \(message_id, participant_id\)/);
  assert.match(
    schema,
    /message_deliveries_inbox_idx[\s\S]*participant_id, status, available_at, created_at\)/,
    "the durable inbox index must preserve ready-time and insertion order",
  );
});

test("persistent agent sandboxes have a cross-invocation lease", () => {
  const leases = tableDefinition("agent_sandbox_leases");
  assert.match(leases, /owner_id text NOT NULL/);
  assert.match(leases, /agent_id text NOT NULL/);
  assert.match(leases, /lease_token uuid NOT NULL/);
  assert.match(leases, /lease_until timestamptz NOT NULL/);
  assert.match(leases, /PRIMARY KEY \(owner_id, agent_id\)/);
});

test("artifacts remain owned by the same durable channel transcript", () => {
  const artifacts = tableDefinition("artifacts");
  assert.match(artifacts, /task_id uuid NOT NULL REFERENCES tasks\(id\) ON DELETE CASCADE/);
  assert.match(artifacts, /run_id uuid REFERENCES runs\(id\) ON DELETE SET NULL/);
  assert.match(artifacts, /name text NOT NULL/);
  assert.match(artifacts, /url text/);
});
