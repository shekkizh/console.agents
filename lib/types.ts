export type TaskStatus = "queued" | "running" | "waiting" | "completed" | "failed";
export type AgentStatus = "ready" | "working" | "offline";
export type MessageRole = "user" | "agent" | "system";
export type ParticipantType = "human" | "agent";
export type MessageDelivery = "broadcast" | "direct";
export type StepKind = "plan" | "search" | "code" | "file" | "result";

export interface AgentProfile {
  id: string;
  name: string;
  initials: string;
  specialty: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  color: string;
  builtIn?: boolean;
}

export interface RunStep {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  createdAt: string;
}

export interface ChannelMessage {
  id: string;
  role: MessageRole;
  author: string;
  content: string;
  createdAt: string;
  steps?: RunStep[];
  authorId: string;
  authorName: string;
  authorType: ParticipantType | "system";
  recipientIds: string[];
  delivery: MessageDelivery;
  replyToId?: string;
}

export interface ChannelParticipant {
  id: string;
  type: ParticipantType;
  name: string;
  initials: string;
  specialty?: string;
  color: string;
  status: AgentStatus;
  agentId?: string;
}

export interface Artifact {
  id: string;
  name: string;
  kind: string;
  size?: string;
  url?: string;
}

export interface Channel {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  participantIds: string[];
  participants: ChannelParticipant[];
  messages: ChannelMessage[];
  artifacts: Artifact[];
  repositoryUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateChatInput {
  title: string;
  summary: string;
  agentIds: string[];
  repositoryUrl?: string;
}

export interface WorkspaceSnapshot {
  agents: AgentProfile[];
  channels: Channel[];
  currentUser: ChannelParticipant;
}
