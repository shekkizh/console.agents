# Console Agents

Console is a private interface for persistent, self-building agents. Eve is deliberately kept as a thin trusted control plane: it authenticates Clerk users, accepts messages into a durable mailbox, wakes one sequential worker, validates configuration changes, and owns the sandbox lifecycle. The fx runtime performs the actual agent work.

## Architecture

```text
Clerk-authenticated UI
        |
        v
Minimal Eve orchestrator
identity · durable mailbox · wake-up session · config validation
        |
        v
Persistent Vercel Sandbox (microsandbox locally)
        |
        v
Sandboxed execution engine
workspace · tools · skills · sessions · subagents · agent proposals
```

Each conversation owns a durable event mailbox, one Eve wake-up session, a persistent sandbox, and one resumable fx session. Sending never waits for the current fx activation: the channel records the message first and queues a wake-up. The single worker drains messages in arrival order and runs one distinct fx activation per message. Eve may coalesce wake-ups, but it cannot merge or lose mailbox messages. Tool-result events notify the UI as each reply is committed, so no browser polling or open tab is required for execution.

The execution engine has unrestricted filesystem and process access inside the sandbox. It receives the AI Gateway key only in the environment of an active fx process; Clerk, Neon, and control-plane credentials remain outside the sandbox. Each agent can use full network access, no tool egress, or a domain allowlist; the model connection remains available in every mode.

To create another persistent agent or update itself, the engine writes a bounded request to `.console/control-plane.json`. After the turn, trusted Eve code validates at most five requests, applies them to Neon, records an audit event, and clears the outbox. Newly created agents appear in the UI after the roster refresh.

Agents can also publish inline-only previews by declaring files from `.console/previews/` in `.console/artifacts.json`. Before sandbox shutdown, the trusted runtime verifies paths, sizes, file signatures, and UTF-8 text, then stores the private preview with the conversation. Authenticated message views render images, PDFs, and text/code directly in the chat; raw sandbox paths are never exposed to the browser.

## Setup

Requirements: Node.js 24+, a Clerk application, Neon Postgres, Vercel AI Gateway, and either Vercel Sandbox or local microsandbox support.

1. Copy `.env.example` to `.env.local` and provide the Clerk, Neon, and AI Gateway values.
2. Apply the additive Neon migration with `npm run db:migrate`. It can migrate the previous Console `agents` table safely and is repeatable.
3. Install and run:

```bash
npm install
npm run dev
```

`withEve()` starts the Eve service next to Next.js in development. Production `next build` emits Next and Eve as separate Vercel services with same-origin `/eve/v1/*` routing.

Local execution uses microsandbox. The first run may install the microsandbox runtime and the pinned execution engine. Its GitHub release archive is verified against the published SHA-256 file before installation.

## Verification

```bash
npm test
npm run test:integration
npm run test:e2e
# or run every test layer:
npm run test:all
npm run typecheck
npx eve build
npm run build
```

`npm test` runs the fast unit suite. The integration suite migrates the configured Neon database, uses an isolated test owner, and removes its rows afterward. The Playwright suite starts the full Next + Eve application with a development-only bearer identity and deterministic fx worker, sends overlapping messages, closes the browser while work is active, and verifies ordered completion after reconnecting. The test bypass cannot be enabled in a production build.

Install Playwright's pinned browser once with `npx playwright install chromium` before the first end-to-end run.

Important state belongs in Neon or a durable external store. The sandbox is the working environment, not the registry or sole backup.
