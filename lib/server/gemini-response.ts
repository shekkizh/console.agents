export interface GeminiContentPart {
  type?: string;
  text?: string;
}

export interface GeminiInteractionStep extends Record<string, unknown> {
  type?: string;
  text?: string;
  content?: GeminiContentPart[];
  summary?: GeminiContentPart[];
}

export interface GeminiInteractionPayload {
  id?: string;
  status?: string;
  output_text?: string;
  outputs?: GeminiInteractionStep[];
  steps?: GeminiInteractionStep[];
  error?: { message?: string };
  environment_id?: string;
}

function contentText(parts: GeminiContentPart[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!)
    .join("");
}

export function stepText(step: GeminiInteractionStep): string {
  if (typeof step.text === "string") return step.text;
  return contentText(step.content) || contentText(step.summary);
}

export function interactionOutputText(payload: GeminiInteractionPayload): string {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;

  const modelOutput = (payload.steps ?? [])
    .filter((step) => step.type === "model_output")
    .map(stepText)
    .filter(Boolean)
    .join("\n");
  if (modelOutput) return modelOutput;

  // The legacy REST schema returned final text items in `outputs`.
  return (payload.outputs ?? [])
    .filter((output) => output.type === "text" || output.type === "model_output")
    .map(stepText)
    .filter(Boolean)
    .join("\n");
}
