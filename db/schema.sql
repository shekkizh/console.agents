CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  specialty text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  fx_config jsonb NOT NULL DEFAULT '{"model":"minimax/minimax-m3-free","networkAccess":"full","networkAllowlist":[]}'::jsonb,
  config_version integer NOT NULL DEFAULT 1,
  created_by_agent_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS fx_config jsonb NOT NULL DEFAULT '{"model":"minimax/minimax-m3-free","networkAccess":"full","networkAllowlist":[]}'::jsonb;
ALTER TABLE agents ALTER COLUMN fx_config SET DEFAULT '{"model":"minimax/minimax-m3-free","networkAccess":"full","networkAllowlist":[]}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by_agent_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS agents_owner_updated_idx
  ON agents(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'working', 'completed', 'failed', 'needs_input')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'New conversation';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
  ON conversations(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  conversation_id text,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  actor_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS conversation_id text;

CREATE INDEX IF NOT EXISTS agent_events_agent_created_idx
  ON agent_events(owner_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_events_conversation_created_idx
  ON agent_events(owner_id, conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  owner_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
  sender_id text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('human', 'agent')),
  recipient_id text NOT NULL,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'error')),
  in_reply_to text,
  content text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
  ON conversation_messages(owner_id, conversation_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS conversation_messages_reply_idx
  ON conversation_messages(owner_id, conversation_id, in_reply_to, created_at ASC);

CREATE TABLE IF NOT EXISTS message_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  message_id text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('human', 'agent')),
  recipient_id text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'claimed', 'running', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  running_at timestamptz,
  completed_at timestamptz,
  UNIQUE (owner_id, message_id, recipient_type, recipient_id),
  FOREIGN KEY (owner_id, message_id)
    REFERENCES conversation_messages(owner_id, id) ON DELETE CASCADE
);

ALTER TABLE message_deliveries ADD COLUMN IF NOT EXISTS running_at timestamptz;

CREATE INDEX IF NOT EXISTS message_deliveries_inbox_idx
  ON message_deliveries(owner_id, recipient_type, recipient_id, state, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS message_deliveries_one_active_agent_idx
  ON message_deliveries(owner_id, recipient_id)
  WHERE recipient_type = 'agent' AND state IN ('claimed', 'running');

CREATE TABLE IF NOT EXISTS message_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  message_id text NOT NULL,
  sandbox_path text NOT NULL,
  filename text NOT NULL,
  title text NOT NULL,
  media_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, message_id, sandbox_path),
  FOREIGN KEY (owner_id, message_id)
    REFERENCES conversation_messages(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS message_artifacts_message_idx
  ON message_artifacts(owner_id, message_id, created_at ASC);
