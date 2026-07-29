import { FileText, Github, Timer, X } from "lucide-react";
import type { AgentProfile, AgentTask } from "@/lib/types";
import { Status } from "@/components/workspace/status";

export function ContextPanel({ task, agent, onClose }: { task: AgentTask; agent?: AgentProfile; onClose: () => void }) {
  return (
    <aside className="context-panel">
      <header><h3>Task context</h3><button className="icon-button" type="button" onClick={onClose} aria-label="Close context"><X size={17} /></button></header>
      {agent ? <section className="context-agent"><div className="agent-identity"><span className="avatar avatar-large" style={{ background: agent.color }}>{agent.initials}</span><div><strong>{agent.name}</strong><span>{agent.specialty}</span></div></div><p>{agent.description}</p></section> : null}
      <section className="context-section"><h4>Run</h4><dl><div><dt>Status</dt><dd><Status status={task.status} compact /></dd></div><div><dt>Started</dt><dd>{new Date(task.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</dd></div><div><dt>Priority</dt><dd className="capitalize">{task.priority}</dd></div></dl></section>
      {task.repositoryUrl ? <section className="context-section repository-source"><h4>Source</h4><a href={task.repositoryUrl} target="_blank" rel="noreferrer"><Github size={15} /><span>{task.repositoryUrl.replace("https://github.com/", "")}</span></a></section> : null}
      <section className="context-section artifacts"><h4>Artifacts <span>{task.artifacts.length}</span></h4>{task.artifacts.length ? task.artifacts.map((artifact) => <button type="button" className="artifact-row" key={artifact.id}><span><FileText size={16} /></span><span><strong>{artifact.name}</strong><small>{artifact.kind}{artifact.size ? ` · ${artifact.size}` : ""}</small></span></button>) : <div className="empty-artifacts"><Timer size={19} /><span>Outputs from this task will appear here.</span></div>}</section>
      {task.interactionId ? <section className="context-section run-id"><h4>Managed run</h4><code>{task.interactionId}</code></section> : null}
    </aside>
  );
}
