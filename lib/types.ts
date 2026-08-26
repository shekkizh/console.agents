export type FxNetworkAccess = "full" | "none" | "allowlist";

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
  networkAccess: FxNetworkAccess;
  networkAllowlist: string[];
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
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export type MessageDeliveryState =
  | "queued"
  | "claimed"
  | "running"
  | "completed"
  | "failed";

export interface ConversationMessageActivity {
  id: string;
  senderType: "human" | "agent" | "system";
  senderId: string;
  senderName: string;
  recipientType: "human" | "agent";
  recipientId: string;
  recipientName: string;
  kind: "message" | "error";
  inReplyTo: string | null;
  content: string;
  summary: string | null;
  state: MessageDeliveryState;
  artifactCount: number;
  createdAt: string;
}
