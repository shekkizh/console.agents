CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  specialty text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  fx_config jsonb NOT NULL DEFAULT '{"model":"zai/glm-5.2","maxSteps":48,"permissionMode":"yolo"}'::jsonb,
  config_version integer NOT NULL DEFAULT 1,
  eve_session_id text,
  created_by_agent_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- Additive migration for databases created by the earlier Console implementation.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS fx_config jsonb NOT NULL DEFAULT '{"model":"zai/glm-5.2","maxSteps":48,"permissionMode":"yolo"}'::jsonb;
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

CREATE INDEX IF NOT EXISTS agent_events_agent_created_idx
  ON agent_events(owner_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_events_conversation_created_idx
  ON agent_events(owner_id, conversation_id, created_at ASC);

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
