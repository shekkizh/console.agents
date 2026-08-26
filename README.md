# Console Agents

Console is a private interface for persistent, self-building peer agents. Neon is the durable message bus and registry; each registered agent has a persistent isolated sandbox and an independent FIFO inbox. FX performs the work and may launch concurrent native subagents inside an activation.

## Architecture

```text
Clerk-authenticated UI
        |
        v
Next.js control plane
identity · durable mailbox · signed callbacks · config validation
        |
        v
Neon Postgres
agents · conversations · messages · deliveries · artifacts · audit events
        |
        v
Persistent Vercel Sandbox (microsandbox locally)
workspace · FX · tools · skills · sessions · concurrent subagents
```

User and agent messages are committed before dispatch. An agent claims one top-level delivery at a time across all of its conversations, so its inbox is sequential and survives browser disconnects or server restarts. Different registered agents can run simultaneously, and FX can parallelize work with native subagents inside its sandbox. There is no model supervisor, synthetic cleanup turn, or hidden coordinator.

Every sandbox receives a small `a2a` command and usage notes in its generated `AGENTS.md`. Agents can list peers, send or wait for correlated messages, publish sparse progress, and finish with one signed completion callback. A peer request is persisted before the recipient is dispatched. Postgres notifications wake an activation that is already waiting for a reply; there is no filesystem polling or messaging MCP server.

Completion settles only the correlated delivery. After the HTTP response is sent, Console clears per-task files, immediately dispatches the next queued item for that agent, or stops an idle sandbox. Sandbox compute is detached from the request duration and may run for the configured sandbox lease.

Participants share only explicit messages and artifacts. The `a2a` command uploads selected files from `.console/outbox/`; Console validates and stores them in Neon, then materializes private copies under a recipient's `.console/inbox/<messageId>/`. The Chat view projects human-facing messages, while Activity shows the complete participant flow and delivery state.

FX has filesystem and process access inside its own sandbox. The AI Gateway key is injected only into an active FX process; Clerk, Neon, signing, and control-plane credentials remain outside. Network access is a user-selected sandbox policy: full access, model-only, or a domain allowlist.

To create another persistent agent or update itself, FX writes a bounded request to `.console/control-plane.json`. The trusted control plane validates at most five requests after completion, applies them to Neon, records an audit event, and clears the file. Creating an FX subagent does not register a persistent Console agent.

## Setup

Requirements: Node.js 24+, a Clerk application, Neon Postgres, Vercel AI Gateway, and either Vercel Sandbox or local microsandbox support.

1. Copy `.env.example` to `.env.local` and provide the Clerk, Neon, AI Gateway, signing, and sandbox values.
2. Keep `DATABASE_NAME=console_agents_dev` locally, or use a separate Neon development branch, so tests and cleanup never target production.
3. Install, migrate, and run:

```bash
npm install
npm run db:migrate
npm run dev
```

Local execution uses microsandbox. Production uses `@vercel/sandbox` directly. Each owner/agent pair has a deterministic persistent sandbox identity. The first activation installs the pinned FX release and verifies its published SHA-256 checksum.

## Verification

```bash
npm test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run lint
npm run build
```

Unit tests cover the signed callback and sandbox-facing configuration. Integration tests exercise FIFO claims, idempotency, stale-lease recovery, peer correlation, stop semantics, artifacts, and owner isolation against the development database. Playwright verifies same-agent queuing after browser disconnect, concurrent registered agents, and signed idempotent completion through the real HTTP routes.

Important state belongs in Neon. A sandbox is a persistent private workspace, not the registry or sole backup.
