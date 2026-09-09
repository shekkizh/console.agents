import { setTimeout } from "node:timers/promises";
import { reconcileAgentTasks } from "../lib/server/reconciler.ts";

const once = process.argv.includes("--once");
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
do {
  try {
    console.log(JSON.stringify(await reconcileAgentTasks()));
  } catch (error) {
    console.error("Reconciliation failed:", error instanceof Error ? error.name : "UnknownError");
    if (once) process.exitCode = 1;
  }
  if (once || controller.signal.aborted) break;
  await setTimeout(15_000, undefined, { signal: controller.signal }).catch(() => undefined);
} while (!controller.signal.aborted);
