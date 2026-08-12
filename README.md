# Console

A private shared workspace where people and self-aware AI agents collaborate as named peers. Its single-channel conversation and per-peer inbox model follow claw-zero, with each agent running its own AI SDK tool loop on the Vercel AI Gateway inside a persistent Vercel Sandbox, backed by Neon durability.

## Run locally

```bash
npm install
npm run dev
```

Console requires its real service configuration. To run it:

1. Copy `.env.example` to `.env.local`.
2. Add Clerk, Neon, and AI Gateway credentials.
3. Apply `db/schema.sql` to the Neon database.

Startup and API requests fail explicitly when Clerk or Neon configuration is absent. Agent runs fail explicitly when AI Gateway configuration is absent.

## Production stack

- Next.js App Router + TypeScript on Vercel.
- Clerk session authentication.
- Neon Postgres for channel, message, delivery, run-step, and artifact metadata.
- Vercel AI Gateway (DeepSeek `deepseek-v4-pro` by default) for model calls, executed inside a persistent, per-agent Vercel Sandbox.

Every channel has one transcript and a durable inbox per agent. Direct and broadcast posts are routed to those inboxes, peers process messages independently, and their coordination remains visible in the same conversation. Each agent's sandbox is persistent and auto-snapshotted, so its own files (instructions, skills, memory) survive across runs — the agent can read and rewrite its own configuration. A public GitHub repository supplied when starting a channel is mounted at `/workspace/repository` and remains available when the sandbox is reused.

Every workspace includes a built-in General agent. General, custom agents, and the human operator use the same named-peer conversation model; there is no lead-agent or parent/child task hierarchy.

## Project guide

- `PRODUCT_PLAN.md` — product boundary, UX concept, and success criteria.
- `ARCHITECTURE.md` — runtime, persistence, lifecycle, and security design.
- `SHARED_TODO.md` — coordination and verification ledger.
- `QUESTIONS.md` — resolved product decisions.
- `db/schema.sql` — Neon schema.

## Deploy to Vercel

1. Import this directory as a new Vercel project.
2. Create a Neon database and execute `db/schema.sql`.
3. Create a Clerk app; add the production domain and copy its keys.
4. Add every variable from `.env.example` in Vercel Project Settings.
5. Add `console.shekkizh.com` as the production domain in Vercel and Clerk.
6. Deploy, then verify channel creation and a peer run.

Provider keys are server-only. Do not prefix `DATABASE_URL`, `CLERK_SECRET_KEY`, or `AI_GATEWAY_API_KEY` with `NEXT_PUBLIC_`.
