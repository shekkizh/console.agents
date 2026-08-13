/**
 * Single source of truth for which file types agents are allowed to share as previewable
 * artifacts. Consumed by the sandbox runner (embedded as a JSON literal), the artifact preview
 * API route, and the client renderer — so the allow list can never drift between them.
 */

export type ArtifactPreviewKind = "markdown" | "text" | "json" | "csv" | "image";

export interface RenderableArtifactRule {
  previewKind: ArtifactPreviewKind;
  mimeType: string;
  label: string;
}

export const RENDERABLE_ARTIFACT_EXTENSIONS: Record<string, RenderableArtifactRule> = {
  md: { previewKind: "markdown", mimeType: "text/markdown", label: "Markdown" },
  markdown: { previewKind: "markdown", mimeType: "text/markdown", label: "Markdown" },
  txt: { previewKind: "text", mimeType: "text/plain", label: "Text" },
  log: { previewKind: "text", mimeType: "text/plain", label: "Log" },
  json: { previewKind: "json", mimeType: "application/json", label: "JSON" },
  csv: { previewKind: "csv", mimeType: "text/csv", label: "CSV" },
  tsv: { previewKind: "csv", mimeType: "text/tab-separated-values", label: "TSV" },
  ts: { previewKind: "text", mimeType: "text/plain", label: "TypeScript" },
  tsx: { previewKind: "text", mimeType: "text/plain", label: "TypeScript" },
  js: { previewKind: "text", mimeType: "text/plain", label: "JavaScript" },
  jsx: { previewKind: "text", mimeType: "text/plain", label: "JavaScript" },
  py: { previewKind: "text", mimeType: "text/plain", label: "Python" },
  sh: { previewKind: "text", mimeType: "text/plain", label: "Shell" },
  sql: { previewKind: "text", mimeType: "text/plain", label: "SQL" },
  html: { previewKind: "text", mimeType: "text/plain", label: "HTML" },
  css: { previewKind: "text", mimeType: "text/plain", label: "CSS" },
  yaml: { previewKind: "text", mimeType: "text/plain", label: "YAML" },
  yml: { previewKind: "text", mimeType: "text/plain", label: "YAML" },
  xml: { previewKind: "text", mimeType: "text/plain", label: "XML" },
  png: { previewKind: "image", mimeType: "image/png", label: "Image" },
  jpg: { previewKind: "image", mimeType: "image/jpeg", label: "Image" },
  jpeg: { previewKind: "image", mimeType: "image/jpeg", label: "Image" },
  gif: { previewKind: "image", mimeType: "image/gif", label: "Image" },
  webp: { previewKind: "image", mimeType: "image/webp", label: "Image" },
  svg: { previewKind: "image", mimeType: "image/svg+xml", label: "Image" },
};

export const MAX_TEXT_ARTIFACT_BYTES = 256 * 1024;
export const MAX_IMAGE_ARTIFACT_BYTES = 5 * 1024 * 1024;

export function maxBytesForPreviewKind(previewKind: ArtifactPreviewKind): number {
  return previewKind === "image" ? MAX_IMAGE_ARTIFACT_BYTES : MAX_TEXT_ARTIFACT_BYTES;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
