CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  specialty text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'failed')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  agent_id text NOT NULL,
  interaction_id text,
  environment_id text,
  environment_version integer NOT NULL DEFAULT 0,
  repository_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_owner_updated_idx ON tasks(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_owner_status_idx ON tasks(owner_id, status);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repository_url text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS environment_version integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  author text NOT NULL,
  content text NOT NULL,
  steps jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_task_created_idx ON messages(owner_id, task_id, created_at);

-- Peer channels use the existing tasks row as their durable channel record.
-- Routing fields are additive so this schema can be applied idempotently.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_type text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery text NOT NULL DEFAULT 'broadcast';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  participant_id text NOT NULL,
  participant_type text NOT NULL CHECK (participant_type IN ('human', 'agent')),
  display_name text NOT NULL,
  agent_id text,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'working', 'offline')),
  interaction_id text,
  environment_id text,
  environment_version integer NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, participant_id)
);

CREATE INDEX IF NOT EXISTS channel_members_owner_idx ON channel_members(owner_id, channel_id, joined_at);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  channel_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  participant_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  delivered_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, participant_id)
);

CREATE INDEX IF NOT EXISTS message_deliveries_inbox_idx
  ON message_deliveries(owner_id, channel_id, participant_id, status, available_at, created_at);

-- A named persistent sandbox is shared by an agent across every channel. This lease prevents
-- separate function invocations from writing to or stopping the same sandbox session concurrently.
CREATE TABLE IF NOT EXISTS agent_sandbox_leases (
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  lease_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, agent_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  gemini_interaction_id text,
  status text NOT NULL,
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind text NOT NULL,
  label text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  name text NOT NULL,
  kind text NOT NULL,
  size text,
  url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Artifacts an agent explicitly published with the share_artifact tool. Resolvable back to the
-- sandbox file they came from so the preview route can stream bytes on demand instead of storing
-- a copy. Additive so this schema can be applied idempotently.
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS sandbox_path text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS preview_kind text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS mime_type text;
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_agent_path_idx ON artifacts(owner_id, task_id, agent_id, sandbox_path) WHERE sandbox_path IS NOT NULL;
