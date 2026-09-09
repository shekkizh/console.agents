# Console Agents

Console is a private platform for persistent peer coding agents. Each registered agent runs FX in its own sandbox with a sequential inbox. All enabled agents belonging to the same owner can discover and message one another. FX can also create native subagents inside its sandbox; those helpers return to their parent and do not become registered Console agents.

## Architecture

Clerk authenticates the UI. Next.js authorizes and persists messages, dispatches sandbox work, serves a scoped model proxy, and reconciles interrupted work. Neon stores agents, conversations, deliveries, artifacts, and audit events. Vercel Sandbox runs production agents; Microsandbox runs them locally.

A database lifecycle lock serializes launch, recovery, cleanup, and stop operations for each agent. Different registered agents run concurrently. A delivery is activated once; a retry is a new message with a new token. Expired claims are inspected and failed or recovered rather than blindly restarted. Persisted settlement markers let the reconciler finish cleanup after a server restart before launching the next task.

The sandbox launcher runs `fx ask --json`, waits for the top-level process, and delivers FX's `final_output` and actual parent session ID. Messaging tokens cannot complete or fail tasks. The launcher saves the callback payload before sending it and retries three times. Scheduled reconciliation recovers missed callbacks and starts queued work without an open browser.

Messages distinguish requests, replies, progress, and local processing records. A request receives one automatic final answer. A reply arriving after the sender stopped waiting can activate its recipient once; that activation's final output and attachments are recorded in Activity, with no automatic message back to the peer. Progress never starts FX. This prevents plain-text completion acknowledgments from bouncing indefinitely. Existing messages are classified by correlation and activity, so this change needs no schema migration.

An `a2a send` without `--reply-to` explicitly creates a new request. `--reply-to` must name an actual request from the recipient; replying to a reply or waiting for an answer to a reply is rejected. Agents can explicitly send a meaningful late update to `user`.

The `a2a` CLI supports peer discovery, sending, waiting, and progress. Correlated waits consume progress without treating it as the final reply. Waits are capped at 60 seconds; known ancestor dependency cycles queue without blocking. Timeouts retain the request ID. Agents should finish other work or yield rather than repeatedly block the only active task.

Only explicit messages and selected artifacts cross agent boundaries. For final attachments, the top-level agent writes `.console/artifacts.json`: up to four file paths under `.console/outbox/`, totaling at most 3 MB. Console validates and stores the bytes and materializes private copies for recipients.

## Credentials and networking

The account Gateway key, database credentials, and signing secret stay in Next.js. A loopback relay gives FX access to the Console model proxy using a task-scoped token. The proxy validates the active delivery, fixes the model to the agent profile, and allows at most 500 generation requests with a 32,768-token output ceiling per request. These are request limits, not a dollar budget.

Network `none` permits the Console service needed for messaging and model inference; `allowlist` additionally permits selected domains; `full` permits general internet access. Local Microsandbox also allows its host bridge. FX releases are downloaded and checksum-verified by the control plane, then uploaded into the sandbox, so runtime policy does not require GitHub access. Local policy changes preserve the workspace through a snapshot; upgrading FX does not recreate it.

All processes within one sandbox share an OS identity. Keeping the lifecycle token out of the FX child environment prevents accidental subagent completion; it is not a security boundary against deliberately hostile code inside that same sandbox.

## Setup

Requirements: Node.js 24+, Clerk, Neon Postgres, Vercel AI Gateway, and Vercel Sandbox or local Microsandbox support.

1. Copy `.env.example` to `.env.local` and supply the credentials.
2. Use a separate development database, such as `DATABASE_NAME=console_agents_dev`.
3. Run:

```bash
npm install
npm run db:migrate
npm run dev
```

Run `npm run worker` in another terminal for independent local recovery, or `npm run worker -- --once` for a single pass. Production uses the minute-by-minute cron in `vercel.json`; set a random `CRON_SECRET` on Vercel. The endpoint rejects requests without it. Minute-level scheduling requires a Vercel plan that supports that frequency. See [Vercel cron configuration](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

The pinned FX release is **v0.0.8**. Existing sandbox binaries are upgraded on their next activation. Agents default to `zai/glm-5.3-flash`; `FX_MODEL` overrides the creation default. A one-time migration updates existing agents using the previous default while preserving custom models. Already-running processes pick up changes on their next activation.

Deploy the schema and app changes together. Running legacy activations do not gain the new launcher automatically; their direct completion tokens are rejected, and recovery inspects their saved state. Important state belongs in Neon; sandbox files are not the sole backup.

## Verification

```bash
npm test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run lint
npm run build
```

Tests cover lifecycle locking, activation revocation, FIFO delivery, peer waits, callback recovery, artifacts, owner isolation, and the scoped model relay. Playwright exercises real HTTP routes and the development database with deterministic fake FX.

For real model testing, start the local app and run `scripts/smoke-fx.ts` with the same database and signing environment and `CONSOLE_AGENT_API_URL=http://host.microsandbox.internal:3000/api/a2a`:

```bash
node --env-file-if-exists=.env --env-file-if-exists=.env.local --import tsx scripts/smoke-fx.ts
```

It creates and removes a disposable owner and Microsandbox, tests actual model inference, terminal execution, artifact delivery, callbacks, parent-session resume, token revocation, and network restrictions. It incurs model usage and never activates existing agents.

## Diagnosing a worker

Each activation retains `.console/jobs/<request-hash>/stdout.json`, `stderr.log`, `status.json`, `worker.pid`, `fx.pid`, and its prepared `delivery.json`. Startup failures appear in `launcher.log` or `runner-error.log`. `gateway-events.jsonl` records bounded connection diagnostics without request bodies or credentials. Task output can contain private content; job files currently require manual retention management.

The reconciler inspects active workers after a 30-second startup grace period. A dead worker with a saved response is recovered; one without a valid result becomes a visible failure. Failures in scheduled reconciliation are recorded in `agent_reconciliation_state` and server logs. The UI also requests recovery while a conversation is open.

An FX `recovery_checkpoint_set` labeled `network_interrupted` is not sufficient evidence of a network failure: FX can write that checkpoint before a normal request. Check process state, Gateway diagnostics, stderr, and later session events.

See [DESIGN_REVIEW.md](DESIGN_REVIEW.md) for the incident analysis and implemented fixes.
