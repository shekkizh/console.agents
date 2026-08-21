export type FxPermissionMode = "auto" | "yolo";

export interface FxSkillConfig {
  name: string;
  description: string;
  instructions: string;
}

export interface FxMcpServerConfig {
  type: "http" | "sse" | "local" | "stdio";
  url?: string;
  command?: string[];
  enabled?: boolean;
  required?: boolean;
  headers?: Record<string, string>;
  headerEnv?: Record<string, string>;
  bearerTokenEnv?: string;
  environment?: Record<string, string>;
}

export interface FxAgentConfig {
  model: string;
  maxSteps: number;
  permissionMode: FxPermissionMode;
  skills: FxSkillConfig[];
  mcpServers: Record<string, FxMcpServerConfig>;
}

export interface AgentProfile {
  id: string;
  name: string;
  specialty: string;
  instructions: string;
  fxConfig: FxAgentConfig;
  configVersion: number;
  eveSessionId: string | null;
  createdByAgentId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentArtifactKind = "image" | "pdf" | "text";

export interface AgentArtifact {
  id: string;
  name: string;
  title: string;
  mediaType: string;
  kind: AgentArtifactKind;
  size: number;
}

export interface AgentMessage {
  id: string;
  requestId: string;
  role: "user" | "assistant";
  text: string;
  artifacts: AgentArtifact[];
  failed: boolean;
  createdAt: string;
}

export type ConversationStatus = "ready" | "working" | "completed" | "failed" | "needs_input";

export interface ConversationProfile {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  eveSessionId: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface FxAskResult {
  output: string;
  exitCode: number;
  model: string;
  sessionId: string;
  steps: number;
  toolCalls: unknown[];
}
