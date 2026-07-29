import assert from "node:assert/strict";
import test from "node:test";
// Node's type-stripping test runner requires the explicit extension; the app build resolves TypeScript modules itself.
// @ts-expect-error TypeScript disallows explicit .ts imports unless allowImportingTsExtensions is enabled.
import { interactionOutputText, stepText } from "../lib/server/gemini-response.ts";

test("extracts text from the May 2026 model_output steps schema", () => {
  const output = interactionOutputText({
    id: "interaction-1",
    status: "completed",
    steps: [
      { type: "thought", summary: [{ type: "text", text: "Working on it" }] },
      { type: "google_search_call" },
      {
        type: "model_output",
        content: [
          { type: "text", text: "The agent " },
          { type: "text", text: "did respond." },
        ],
      },
    ],
  });

  assert.equal(output, "The agent did respond.");
});

test("keeps SDK and legacy response compatibility", () => {
  assert.equal(interactionOutputText({ output_text: "SDK response", steps: [] }), "SDK response");
  assert.equal(
    interactionOutputText({ outputs: [{ type: "text", text: "Legacy REST response" }] }),
    "Legacy REST response",
  );
});

test("does not mistake thoughts for the final response", () => {
  assert.equal(
    interactionOutputText({ steps: [{ type: "thought", summary: [{ type: "text", text: "Private work" }] }] }),
    "",
  );
  assert.equal(stepText({ type: "thought", summary: [{ type: "text", text: "Work summary" }] }), "Work summary");
});
