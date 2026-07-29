export type TaskStatus = "queued" | "running" | "waiting" | "completed" | "failed";
export type AgentStatus = "ready" | "working" | "offline";
export type MessageRole = "user" | "agent" | "system";
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

export interface Message {
  id: string;
  role: MessageRole;
  author: string;
  content: string;
  createdAt: string;
  steps?: RunStep[];
}

export interface Artifact {
  id: string;
  name: string;
  kind: string;
  size?: string;
  url?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high";
  agentId: string;
  updatedAt: string;
  createdAt: string;
  messages: Message[];
  artifacts: Artifact[];
  interactionId?: string;
  environmentId?: string;
  repositoryUrl?: string;
  parentTaskId?: string;
}

export interface WorkspaceSnapshot {
  agents: AgentProfile[];
  tasks: AgentTask[];
}
