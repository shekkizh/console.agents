# Console Agents

Console is a private interface for persistent, self-building peer agents. Eve is deliberately kept as a thin trusted runtime: it authenticates callers, persists messages, wakes an agent, validates bounded platform changes, and owns sandbox lifecycle. The fx runtime performs the actual work and decides for itself when and how to collaborate.

## Architecture

```text
Clerk-authenticated UI
        |
        v
Minimal Eve runtime
identity · conversation bus · wake-up · config validation
        |
        v
Persistent Vercel Sandbox (microsandbox locally)
        |
        v
Sandboxed execution engine
workspace · tools · skills · sessions · subagents · agent proposals
        |
        +---- same conversation + explicit artifacts ----> peer sandbox
```

Each registered agent owns one durable Eve session, one sequential worker, and one persistent isolated sandbox. A conversation is both the user-visible task transcript and the durable message bus shared by its human and agent participants; creating a new conversation does not create another agent or workspace. Every user or agent message is persisted first, then the recipient is woken. Workers claim queued messages in arrival order, and committed replies remain available after the browser closes.

Every sandbox receives a small `a2a` terminal command plus usage notes in its generated `AGENTS.md`. The command calls one authenticated Console messaging API directly; there is no messaging MCP server, filesystem bridge, hidden peer conversation, or background sandbox polling. Messages are durable, owner-scoped, scoped to the current conversation, and correlated by reply id. Database notifications wake waiting processes without interval polling. Agents may address the user or any reachable peer and choose their own collaboration pattern; Console does not impose a coordinator, delegation graph, fan-out policy, or task decomposition scheme.

Participants share only the message and artifacts explicitly sent. The `a2a` command uploads selected files from `.console/outbox/`; Console validates and snapshots them into Neon, then writes private copies into an agent recipient's `.console/inbox/<messageId>/`. Each sandbox otherwise remains private, which also leaves room for externally operated agents to use the same transport boundary later. The conversation's Chat tab projects human-facing messages, while Activity exposes the complete participant flow and delivery state.

The execution engine has unrestricted filesystem and process access inside its sandbox. It receives the AI Gateway key only in the environment of an active fx process; Clerk, Neon, signing, and control-plane credentials remain outside. Network access remains a user-selected platform policy: full access, model-only, or a domain allowlist.

To create another persistent agent or update itself, the engine writes a bounded request to `.console/control-plane.json`. After the turn, trusted Eve code validates at most five requests, applies them to Neon, records an audit event, and clears the outbox. Newly created agents appear in the UI after the roster refresh.

Agents can also publish inline-only previews by declaring files from `.console/previews/` in `.console/artifacts.json`. Before sandbox shutdown, the trusted runtime verifies paths, sizes, file signatures, and UTF-8 text, then stores the private preview with the conversation. Authenticated message views render images, PDFs, and text/code directly in the chat; raw sandbox paths are never exposed to the browser.

## Setup

Requirements: Node.js 24+, a Clerk application, Neon Postgres, Vercel AI Gateway, and either Vercel Sandbox or local microsandbox support.

1. Copy `.env.example` to `.env.local` and provide the Clerk, Neon, and AI Gateway values. Keep `DATABASE_NAME=console_agents_dev` locally (or use a separate Neon branch) so development and test cleanup never touch the deployed database.
2. Create that development database once if needed, then apply the additive migration with `npm run db:migrate`. The migration is repeatable and preserves legacy session references while adopting one for agents that do not yet own a sandbox.
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

`npm test` runs the fast unit suite. The integration suite migrates the configured development database, uses isolated owners, and removes its rows afterward. The Playwright suite starts the full Next + Eve application with a development-only bearer identity and deterministic fx worker, verifies queued work after browser disconnect, and exercises a signed conversation-message wake-up through the real local transport. The test bypass cannot be enabled in a production build.

Install Playwright's pinned browser once with `npx playwright install chromium` before the first end-to-end run.

Important state belongs in Neon or a durable external store. The sandbox is the working environment, not the registry or sole backup.
