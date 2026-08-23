CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  specialty text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  fx_config jsonb NOT NULL DEFAULT '{"model":"zai/glm-5.2","maxSteps":48,"networkAccess":"full","networkAllowlist":[]}'::jsonb,
  config_version integer NOT NULL DEFAULT 1,
  eve_session_id text,
  created_by_agent_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- Additive migration for databases created by the earlier Console implementation.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS fx_config jsonb NOT NULL DEFAULT '{"model":"zai/glm-5.2","maxSteps":48,"networkAccess":"full","networkAllowlist":[]}'::jsonb;
ALTER TABLE agents ALTER COLUMN fx_config SET DEFAULT '{"model":"zai/glm-5.2","maxSteps":48,"networkAccess":"full","networkAllowlist":[]}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS eve_session_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_by_agent_id text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS agents_owner_updated_idx ON agents(owner_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agents_owner_eve_session_idx
  ON agents(owner_id, eve_session_id)
  WHERE eve_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New conversation',
  eve_session_id text,
  runtime_version integer NOT NULL DEFAULT 2,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'working', 'completed', 'failed', 'needs_input')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'New conversation';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS eve_session_id text;
-- Existing durable sessions used the pre-mailbox workflow graph. Keep them at
-- version 1 so the application transparently rotates them on the next send.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS runtime_version integer NOT NULL DEFAULT 1;
ALTER TABLE conversations ALTER COLUMN runtime_version SET DEFAULT 2;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'user';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS a2a_context_id text;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_owner_agent_a2a_context_idx
  ON conversations(owner_id, agent_id, a2a_context_id)
  WHERE a2a_context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
  ON conversations(owner_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_owner_eve_session_idx
  ON conversations(owner_id, eve_session_id)
  WHERE eve_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'agent', 'eve', 'system')),
  actor_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS conversation_id text;

INSERT INTO conversations (id, owner_id, agent_id, title, eve_session_id, status, created_at, updated_at)
SELECT
  'conversation-' || substr(md5(a.owner_id || ':' || a.id), 1, 24),
  a.owner_id,
  a.id,
  COALESCE((
    SELECT left(regexp_replace(e.payload->>'message', E'\\s+', ' ', 'g'), 64)
    FROM agent_events e
    WHERE e.owner_id = a.owner_id AND e.agent_id = a.id AND e.event_type = 'message.user'
    ORDER BY e.created_at DESC
    LIMIT 1
  ), 'New conversation'),
  a.eve_session_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM agent_events e
      WHERE e.owner_id = a.owner_id AND e.agent_id = a.id AND e.event_type = 'message.assistant'
    ) THEN 'completed'
    ELSE 'ready'
  END,
  a.created_at,
  a.updated_at
FROM agents a
WHERE a.eve_session_id IS NOT NULL
   OR EXISTS (SELECT 1 FROM agent_events e WHERE e.owner_id = a.owner_id AND e.agent_id = a.id)
ON CONFLICT (id) DO NOTHING;

UPDATE agent_events e
SET conversation_id = 'conversation-' || substr(md5(e.owner_id || ':' || e.agent_id), 1, 24)
WHERE e.conversation_id IS NULL
  AND EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = 'conversation-' || substr(md5(e.owner_id || ':' || e.agent_id), 1, 24)
  );

UPDATE conversations c
SET title = COALESCE((
  SELECT left(regexp_replace(e.payload->>'message', '[[:space:]]+', ' ', 'g'), 64)
  FROM agent_events e
  WHERE e.owner_id = c.owner_id
    AND e.conversation_id = c.id
    AND e.event_type = 'message.user'
  ORDER BY e.created_at ASC
  LIMIT 1
), c.title)
WHERE c.title = 'New conversation';

-- Adopt the most recently active legacy conversation session only when an
-- agent does not already own one. Legacy references remain intact so this
-- additive migration never discards a prior sandbox handle.
WITH latest_agent_sessions AS (
  SELECT DISTINCT ON (owner_id, agent_id)
    owner_id, agent_id, eve_session_id
  FROM conversations
  WHERE eve_session_id IS NOT NULL
  ORDER BY owner_id, agent_id, updated_at DESC, created_at DESC
)
UPDATE agents agent SET eve_session_id = latest.eve_session_id
FROM latest_agent_sessions latest
WHERE agent.owner_id = latest.owner_id
  AND agent.id = latest.agent_id
  AND agent.eve_session_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_events_agent_created_idx
  ON agent_events(owner_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_events_conversation_created_idx
  ON agent_events(owner_id, conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS agent_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  sandbox_path text NOT NULL,
  filename text NOT NULL,
  title text NOT NULL,
  media_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, conversation_id, request_id, sandbox_path)
);

CREATE INDEX IF NOT EXISTS agent_artifacts_owner_conversation_idx
  ON agent_artifacts(owner_id, conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  owner_id text NOT NULL,
  id text NOT NULL,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
  sender_id text NOT NULL,
  recipient_type text NOT NULL CHECK (recipient_type IN ('human', 'agent')),
  recipient_id text NOT NULL,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'error', 'tick')),
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
    CHECK (state IN ('queued', 'dispatched', 'claimed', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  UNIQUE (owner_id, message_id, recipient_type, recipient_id),
  FOREIGN KEY (owner_id, message_id)
    REFERENCES conversation_messages(owner_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS message_deliveries_inbox_idx
  ON message_deliveries(owner_id, recipient_type, recipient_id, state, created_at, id);

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

-- Preserve existing transcripts while moving all new traffic onto the shared
-- message bus. agent_events remains the execution/configuration audit log.
INSERT INTO conversation_messages
  (owner_id, id, conversation_id, sender_type, sender_id,
   recipient_type, recipient_id, kind, in_reply_to, content, metadata, created_at)
SELECT
  event.owner_id,
  CASE
    WHEN event.event_type = 'message.user' AND event.payload->>'requestId' IS NOT NULL
      THEN event.payload->>'requestId'
    ELSE 'legacy-event:' || event.id::text
  END,
  event.conversation_id,
  CASE WHEN event.event_type = 'message.user' THEN event.actor_type ELSE 'agent' END,
  event.actor_id,
  CASE WHEN event.event_type = 'message.user' THEN 'agent' ELSE 'human' END,
  CASE WHEN event.event_type = 'message.user' THEN event.agent_id ELSE event.owner_id END,
  CASE WHEN event.event_type = 'message.failed' THEN 'error' ELSE 'message' END,
  CASE WHEN event.event_type = 'message.user' THEN NULL ELSE event.payload->>'requestId' END,
  COALESCE(event.payload->>'message', event.payload->>'diagnostic', ''),
  event.payload,
  event.created_at
FROM agent_events event
WHERE event.conversation_id IS NOT NULL
  AND event.event_type IN ('message.user', 'message.assistant', 'message.failed')
ON CONFLICT (owner_id, id) DO NOTHING;

INSERT INTO message_deliveries
  (owner_id, message_id, recipient_type, recipient_id, state,
   created_at, claimed_at, completed_at, error)
SELECT
  message.owner_id,
  message.id,
  message.recipient_type,
  message.recipient_id,
  CASE
    WHEN message.recipient_type = 'human' THEN 'completed'
    WHEN EXISTS (
      SELECT 1 FROM conversation_messages terminal
      WHERE terminal.owner_id = message.owner_id
        AND terminal.conversation_id = message.conversation_id
        AND terminal.in_reply_to = message.id
        AND terminal.recipient_type = 'human'
        AND terminal.kind = 'error'
    ) THEN 'failed'
    WHEN EXISTS (
      SELECT 1 FROM conversation_messages terminal
      WHERE terminal.owner_id = message.owner_id
        AND terminal.conversation_id = message.conversation_id
        AND terminal.in_reply_to = message.id
    ) THEN 'completed'
    ELSE 'queued'
  END,
  message.created_at,
  CASE WHEN message.recipient_type = 'human' THEN message.created_at ELSE NULL END,
  CASE WHEN message.recipient_type = 'human' OR EXISTS (
    SELECT 1 FROM conversation_messages terminal
    WHERE terminal.owner_id = message.owner_id
      AND terminal.conversation_id = message.conversation_id
      AND terminal.in_reply_to = message.id
  ) THEN message.created_at ELSE NULL END,
  NULL
FROM conversation_messages message
ON CONFLICT (owner_id, message_id, recipient_type, recipient_id) DO NOTHING;
CREATE UNIQUE INDEX IF NOT EXISTS agent_events_unique_user_request_idx
  ON agent_events(owner_id, conversation_id, (payload->>'requestId'))
  WHERE conversation_id IS NOT NULL
    AND event_type = 'message.user'
    AND payload ? 'requestId';

CREATE UNIQUE INDEX IF NOT EXISTS agent_events_unique_terminal_request_idx
  ON agent_events(owner_id, conversation_id, (payload->>'requestId'))
  WHERE conversation_id IS NOT NULL
    AND event_type IN ('message.assistant', 'message.failed')
    AND payload ? 'requestId';

CREATE TABLE IF NOT EXISTS agent_peer_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  context_id text NOT NULL,
  from_agent_id text NOT NULL,
  to_agent_id text NOT NULL,
  in_reply_to uuid,
  content text NOT NULL,
  summary text,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'dispatched', 'claimed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  claimed_at timestamptz
);

CREATE INDEX IF NOT EXISTS agent_peer_messages_inbox_idx
  ON agent_peer_messages(owner_id, to_agent_id, context_id, state, created_at);
CREATE INDEX IF NOT EXISTS agent_peer_messages_reply_idx
  ON agent_peer_messages(owner_id, to_agent_id, in_reply_to, state, created_at);

CREATE TABLE IF NOT EXISTS agent_peer_waits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  agent_id text NOT NULL,
  context_id text NOT NULL,
  from_agent_id text,
  in_reply_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_peer_waits_match_idx
  ON agent_peer_waits(owner_id, agent_id, context_id, from_agent_id, in_reply_to, expires_at);

CREATE TABLE IF NOT EXISTS agent_peer_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  message_id uuid NOT NULL REFERENCES agent_peer_messages(id) ON DELETE CASCADE,
  sandbox_path text NOT NULL,
  filename text NOT NULL,
  title text NOT NULL,
  media_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('image', 'pdf', 'text')),
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, message_id, sandbox_path)
);

CREATE INDEX IF NOT EXISTS agent_peer_artifacts_message_idx
  ON agent_peer_artifacts(owner_id, message_id, created_at);

-- One-time compatibility import from the earlier peer-only mailbox. Runtime
-- code no longer reads or writes these legacy tables.
INSERT INTO conversation_messages
  (owner_id, id, conversation_id, sender_type, sender_id,
   recipient_type, recipient_id, kind, in_reply_to, content, summary, created_at)
SELECT
  peer.owner_id, peer.id::text, peer.context_id, 'agent', peer.from_agent_id,
  'agent', peer.to_agent_id, 'message', peer.in_reply_to::text,
  peer.content, peer.summary, peer.created_at
FROM agent_peer_messages peer
WHERE EXISTS (
  SELECT 1 FROM conversations conversation
  WHERE conversation.owner_id = peer.owner_id AND conversation.id = peer.context_id
)
ON CONFLICT (owner_id, id) DO NOTHING;

INSERT INTO message_deliveries
  (owner_id, message_id, recipient_type, recipient_id, state,
   created_at, dispatched_at, claimed_at, completed_at)
SELECT
  peer.owner_id, peer.id::text, 'agent', peer.to_agent_id,
  peer.state, peer.created_at, peer.dispatched_at, peer.claimed_at, NULL
FROM agent_peer_messages peer
WHERE EXISTS (
  SELECT 1 FROM conversation_messages message
  WHERE message.owner_id = peer.owner_id AND message.id = peer.id::text
)
ON CONFLICT (owner_id, message_id, recipient_type, recipient_id) DO NOTHING;

INSERT INTO message_artifacts
  (id, owner_id, message_id, sandbox_path, filename, title,
   media_type, kind, size_bytes, content, created_at)
SELECT
  artifact.id, artifact.owner_id, artifact.message_id::text,
  artifact.sandbox_path, artifact.filename, artifact.title,
  artifact.media_type, artifact.kind, artifact.size_bytes,
  artifact.content, artifact.created_at
FROM agent_peer_artifacts artifact
WHERE EXISTS (
  SELECT 1 FROM conversation_messages message
  WHERE message.owner_id = artifact.owner_id
    AND message.id = artifact.message_id::text
)
ON CONFLICT (id) DO NOTHING;

-- A version-1 workflow cannot be resumed by the mailbox worker safely. Keep
-- every request in the transcript, but settle unmatched legacy deliveries as
-- retryable failures instead of executing them twice during the cutover.
INSERT INTO agent_events
  (owner_id, agent_id, conversation_id, actor_type, actor_id, event_type, payload)
SELECT
  request.owner_id,
  request.agent_id,
  request.conversation_id,
  'system',
  'mailbox-v2-migration',
  'message.failed',
  jsonb_build_object(
    'requestId', request.payload->>'requestId',
    'diagnostic', 'The legacy worker was replaced before this request completed. Retry it on the mailbox worker.'
  )
FROM agent_events request
JOIN conversations conversation
  ON conversation.owner_id = request.owner_id
 AND conversation.id = request.conversation_id
WHERE conversation.runtime_version = 1
  AND request.event_type = 'message.user'
  AND request.payload->>'requestId' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM agent_events response
    WHERE response.owner_id = request.owner_id
      AND response.conversation_id = request.conversation_id
      AND response.event_type IN ('message.assistant', 'message.failed')
      AND response.payload->>'requestId' = request.payload->>'requestId'
  )
ON CONFLICT DO NOTHING;

UPDATE conversations conversation
SET status = 'failed', updated_at = now()
WHERE conversation.runtime_version = 1
  AND EXISTS (
    SELECT 1
    FROM agent_events failed
    WHERE failed.owner_id = conversation.owner_id
      AND failed.conversation_id = conversation.id
      AND failed.actor_id = 'mailbox-v2-migration'
      AND failed.event_type = 'message.failed'
  );
