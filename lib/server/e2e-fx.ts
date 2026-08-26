import type { AgentProfile } from "@/lib/types";
import type { CapturedArtifact } from "@/lib/server/artifact-capture";

interface E2EFakeFxOutcome {
  output: string;
  model: string;
  sessionId: string;
  steps: number;
  artifacts: CapturedArtifact[];
}

const fakeRequestPattern = /^E2E_FAKE delay=(\d{1,5}) reply=([A-Za-z0-9_-]{1,100})$/;

export function parseE2EFakeRequest(prompt: string): { delayMs: number; reply: string } {
  const payload = prompt.startsWith("[message]\n")
    ? prompt.slice(prompt.indexOf("\n\n") + 2)
    : prompt;
  const match = fakeRequestPattern.exec(payload);
  if (!match) throw new Error("Invalid E2E fake fx request");
  return { delayMs: Number(match[1]), reply: match[2]! };
}

async function waitForDelay(delayMs: number, abortSignal?: AbortSignal): Promise<void> {
  abortSignal?.throwIfAborted();
  if (delayMs === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortSignal.reason);
      },
      { once: true },
    );
  });
}

export async function runE2EFakeFxTurn(input: {
  agent: AgentProfile;
  prompt: string;
  abortSignal?: AbortSignal;
}): Promise<E2EFakeFxOutcome> {
  const request = parseE2EFakeRequest(input.prompt);
  await waitForDelay(request.delayMs, input.abortSignal);
  return {
    output: request.reply,
    model: "e2e/fake-fx",
    sessionId: `e2e-${input.agent.id}`,
    steps: 1,
    artifacts: [],
  };
}
