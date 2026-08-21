import path from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { z } from "zod";
import type { AgentArtifactKind } from "@/lib/types";

export const ARTIFACT_MANIFEST_PATH = ".console/artifacts.json";
export const ARTIFACT_PREVIEW_DIRECTORY = ".console/previews";
export const EMPTY_ARTIFACT_MANIFEST = '{"files":[]}\n';

const MAX_ARTIFACTS = 4;
const MAX_MANIFEST_BYTES = 16_384;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const manifestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().trim().min(1).max(300),
            title: z.string().trim().min(1).max(120).optional(),
          })
          .strict(),
      )
      .max(MAX_ARTIFACTS),
  })
  .strict();

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

export function validArtifactPath(value: string): string | undefined {
  if (value.startsWith("/") || value.includes("\\") || /[\0-\x1f\x7f]/.test(value)) return;
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return;
  if (!normalized.startsWith(`${ARTIFACT_PREVIEW_DIRECTORY}/`)) return;
  return normalized;
}

export function parseArtifactManifest(raw: string): Array<{ path: string; title?: string }> {
  const parsed = manifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return [];
  return parsed.data.files.flatMap((file) => {
    const normalized = validArtifactPath(file.path);
    return normalized ? [{ path: normalized, title: file.title }] : [];
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function sandboxFileSize(
  sandbox: SandboxSession,
  filePath: string,
  previewOnly = false,
): Promise<number | undefined> {
  const absolutePath = `/workspace/${filePath}`;
  const boundary = previewOnly
    ? 'case "$resolved" in /workspace/.console/previews/*) ;; *) exit 3 ;; esac'
    : `test "$resolved" = ${shellQuote(absolutePath)} || exit 3`;
  const command = `resolved="$(realpath -e -- ${shellQuote(absolutePath)})" || exit 2
${boundary}
test -f "$resolved" || exit 4
stat -c '%s' -- "$resolved"`;
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) return;
  const size = Number(result.stdout.trim());
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
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

export async function collectPreviewArtifacts(
  sandbox: SandboxSession,
): Promise<CapturedArtifact[]> {
  const manifestSize = await sandboxFileSize(sandbox, ARTIFACT_MANIFEST_PATH);
  if (manifestSize === undefined || manifestSize > MAX_MANIFEST_BYTES) return [];
  const rawManifest = await sandbox.readTextFile({ path: ARTIFACT_MANIFEST_PATH });
  if (!rawManifest?.trim()) return [];

  let files: Array<{ path: string; title?: string }>;
  try {
    files = parseArtifactManifest(rawManifest);
  } catch {
    return [];
  }

  const artifacts: CapturedArtifact[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const type = artifactType(file.path);
    if (!type) continue;
    const size = await sandboxFileSize(sandbox, file.path, true);
    if (size === undefined || size > type.maxBytes || totalBytes + size > MAX_TOTAL_BYTES) continue;
    const content = await sandbox.readBinaryFile({ path: file.path });
    if (!content || content.byteLength !== size) continue;
    if (type.kind === "text" ? !validUtf8Text(content) : !validBinarySignature(content, type.mediaType)) {
      continue;
    }
    const name = path.posix.basename(file.path);
    artifacts.push({
      path: file.path,
      name,
      title: file.title ?? name,
      mediaType: type.mediaType,
      kind: type.kind,
      content,
    });
    totalBytes += size;
  }
  return artifacts;
}
