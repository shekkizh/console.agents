import path from "node:path";
import type { AgentArtifactKind } from "@/lib/types";

export const A2A_OUTBOX_DIRECTORY = ".console/outbox";

const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

const imageTypes = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const textExtensions = new Set([
  ".bash", ".c", ".cc", ".cpp", ".cs", ".css", ".csv", ".env", ".fish",
  ".go", ".h", ".hpp", ".htm", ".html", ".ini", ".java", ".js", ".json",
  ".jsx", ".kt", ".kts", ".less", ".log", ".markdown", ".md", ".mjs", ".php",
  ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".svg", ".swift", ".toml",
  ".ts", ".tsv", ".tsx", ".txt", ".xml", ".yaml", ".yml", ".zsh",
]);

export interface CapturedArtifact {
  path: string;
  name: string;
  title: string;
  mediaType: string;
  kind: AgentArtifactKind;
  content: Uint8Array;
}

interface ArtifactType {
  mediaType: string;
  kind: AgentArtifactKind;
  maxBytes: number;
}

function artifactType(filePath: string): ArtifactType | undefined {
  const extension = path.posix.extname(filePath).toLowerCase();
  const imageType = imageTypes.get(extension);
  if (imageType) return { mediaType: imageType, kind: "image", maxBytes: MAX_BINARY_BYTES };
  if (extension === ".pdf") {
    return { mediaType: "application/pdf", kind: "pdf", maxBytes: MAX_BINARY_BYTES };
  }
  if (textExtensions.has(extension)) {
    return { mediaType: "text/plain; charset=utf-8", kind: "text", maxBytes: MAX_TEXT_BYTES };
  }
  return undefined;
}

export function validPeerArtifactPath(value: string): string | undefined {
  if (value.startsWith("/") || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) return;
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return;
  if (!normalized.startsWith(`${A2A_OUTBOX_DIRECTORY}/`)) return;
  return normalized;
}

export function capturePeerArtifact(input: {
  path: string;
  title?: string;
  content: Uint8Array;
}): CapturedArtifact {
  const normalized = validPeerArtifactPath(input.path);
  const type = normalized ? artifactType(normalized) : undefined;
  if (!normalized || !type) throw new Error("Peer artifact path or type is unsupported");
  if (input.content.byteLength > type.maxBytes) throw new Error("Peer artifact is too large");
  if (
    type.kind === "text"
      ? !validUtf8Text(input.content)
      : !validBinarySignature(input.content, type.mediaType)
  ) {
    throw new Error("Peer artifact content does not match its file type");
  }
  const name = path.posix.basename(normalized);
  return {
    path: normalized,
    name,
    title: input.title?.trim().slice(0, 120) || name,
    mediaType: type.mediaType,
    kind: type.kind,
    content: input.content,
  };
}

function startsWith(content: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((byte, index) => content[offset + index] === byte);
}

function validBinarySignature(content: Uint8Array, mediaType: string): boolean {
  switch (mediaType) {
    case "application/pdf":
      return startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case "image/png":
      return startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(content, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(content, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case "image/webp":
      return startsWith(content, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(content, [0x57, 0x45, 0x42, 0x50], 8);
    default:
      return true;
  }
}

function validUtf8Text(content: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return !content.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}
