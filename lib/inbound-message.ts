import type { UserContent } from "ai";

export const consoleMessageIdPattern = /^[A-Za-z0-9_-]{8,100}$/;

export function validConsoleMessageId(value: string | null | undefined): value is string {
  return typeof value === "string" && consoleMessageIdPattern.test(value);
}

export function flattenInboundMessage(message: string | UserContent): string {
  if (typeof message === "string") return message;
  return message
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "file"
          ? `[file: ${part.filename ?? "attachment"}]`
          : "",
    )
    .filter(Boolean)
    .join("\n");
}
