# Console agent design review

The architecture matches the intended product: each registered agent is an independent FX coding agent with a private persistent sandbox and durable mailbox. Neon owns identity and delivery state; FX owns coding and collaboration decisions. Discovery reaches all enabled peers belonging to the same owner.

## Incident findings

The pasted research-child session called the old `a2a complete` command for its parent request. That could finish the Console task before the parent and its other children finished. The old CLI also guessed the resume target from the newest FX session, which could select a child. A subsequent worker had no live process while Console remained Working, but discarded stdout/stderr prevented identifying its startup error.

The `network_interrupted` recovery checkpoint alone does not establish a transport failure. Inspection of the pinned FX source showed that this checkpoint can be persisted before a request. It needs corroboration from process state, stderr, and later events.

## Implemented fixes

- Default agents to `zai/glm-5.3-flash`, including UI, schema, server configuration, and a one-time migration of the old default. Preserve custom models.
- Upgrade FX from v0.0.4 to the latest stable v0.0.8. Verify release checksums on the server and upgrade existing sandbox binaries. Consume v0.0.8's authoritative `final_output`.
- Give lifecycle callbacks to a launcher that waits for the top-level FX process. Remove agent-side completion and save the actual parent session ID. Reject old child-session resume targets.
- Persist exact callback output and artifact bytes for recovery. Retain private process, exit, and bounded Gateway connection diagnostics. Fail dead workers instead of leaving them indefinitely Working.
- Serialize launch, recovery, settlement, and stop using per-agent database session locks. Retain unsettled activation markers across process loss, inspect live workers before cleanup, and never reclaim an active delivery by age alone. A new retry receives a new delivery ID and token.
- Add a scheduled production reconciler and local worker for queued work, missed callbacks, and interrupted settlement. Rotate candidates fairly and persist background failure status.
- Revoke messaging and model access when an activation ends. Keep the account Gateway key in the control plane behind a streamed, model-restricted proxy with a persistent request budget.
- Separate installation downloads from guest network access. Preserve local sandbox files when runtime policy changes.
- Bound peer waits to 60 seconds, prevent renewal of the same dependency deadline, and avoid blocking on known ancestor cycles. Preserve progress in history without accepting it as a final reply.
- Stop correlated processes before disabling/deleting an agent or deleting its conversation. Preserve other peers' working state when reassigning history.

## Validation

The real local smoke passed with FX v0.0.8 and `zai/glm-5.3-flash` in a disposable Microsandbox: terminal execution, artifact delivery, callback settlement, parent-session resume, credential isolation, completed-token revocation, and restricted network egress. Test resources were removed. No production deployment was required for this test.

Final verification passed: 46 unit tests, 15 development-database integration tests, all four Playwright HTTP/browser tests, typecheck, lint, and a production build. The cron regression also passed again after adding explicit test-owner isolation. The development migration was applied; production was not migrated or deployed.

## Operational limits

Production unattended recovery requires deploying the cron configuration and setting `CRON_SECRET`. FX and its native children share one sandbox OS identity; launcher token separation protects against accidental misuse, not hostile code in that same sandbox. The model proxy limits request count and output length rather than monetary spend. Private job files require a retention policy chosen for the deployment. Cross-conversation peer cycles are bounded by timeout rather than a global dependency graph.
