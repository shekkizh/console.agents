# Console

A private workspace for briefing and supervising Gemini managed agents, designed for `console.shekkizh.com`. The UI is inspired by Buzz's shared-room model; the execution lifecycle follows claw-zero's bounded agent activations while replacing its in-process runtime with Gemini remote environments and Neon durability.

## Run locally

```bash
npm install
npm run dev
```

Console requires its real service configuration. To run it:

1. Copy `.env.example` to `.env.local`.
2. Add Clerk, Neon, and Gemini credentials.
3. Apply `db/schema.sql` to the Neon database.

Startup and API requests fail explicitly when Clerk or Neon configuration is absent. Managed runs fail explicitly when Gemini configuration is absent.

## Production stack

- Next.js App Router + TypeScript on Vercel.
- Clerk session authentication.
- Neon Postgres for task, message, run-step, and artifact metadata.
- Gemini Interactions API with the Antigravity managed agent and remote environments.

Long agent work starts with `background: true`; the web client polls through short-lived Vercel route handlers. Follow-up turns retain both the previous interaction ID and remote environment ID. A public GitHub repository supplied on task creation is mounted at `/workspace/repository` and remains available when the environment is reused.

Every workspace includes a built-in General agent. It handles ordinary work directly and can use Gemini custom function calling to delegate up to three independent subtasks to temporary workers. Delegated tasks run as background interactions, cannot delegate further, remain linked through `parent_task_id`, and are folded back into General's final response without appearing as permanent user-created agents.

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
6. Deploy, then verify task creation and a managed run.

Provider keys are server-only. Do not prefix `DATABASE_URL`, `CLERK_SECRET_KEY`, or `GEMINI_API_KEY` with `NEXT_PUBLIC_`.
