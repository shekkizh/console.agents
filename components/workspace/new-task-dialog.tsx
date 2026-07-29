import { ArrowRight, X } from "lucide-react";
import { useState } from "react";
import type { AgentProfile } from "@/lib/types";

export function NewTaskDialog({ agents, onClose, onCreate }: { agents: AgentProfile[]; onClose: () => void; onCreate: (input: { title: string; summary: string; agentId: string; repositoryUrl?: string }) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); if (!title.trim() || !summary.trim()) return; setSaving(true); try { await onCreate({ title, summary, agentId, repositoryUrl: repositoryUrl.trim() || undefined }); onClose(); } finally { setSaving(false); } }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="new-task-dialog" onSubmit={submit}>
    <header><div><span>New task</span><h2>What should we move forward?</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
    <label><span>Task name</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Prepare the launch analysis" maxLength={120} /></label>
    <label><span>Brief</span><textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Describe the outcome, useful context, and what good looks like…" rows={5} /></label>
    <label><span>GitHub repository <em>Optional</em></span><input type="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository" /></label>
    <fieldset><legend>Work with</legend><div className="agent-picker">{agents.map((agent) => <label className={agentId === agent.id ? "selected" : ""} key={agent.id}><input type="radio" name="agent" value={agent.id} checked={agentId === agent.id} onChange={() => setAgentId(agent.id)} /><span className="avatar" style={{ background: agent.color }}>{agent.initials}</span><span><strong>{agent.name}</strong><small>{agent.specialty}</small></span></label>)}</div></fieldset>
    <footer><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!title.trim() || !summary.trim() || saving}>{saving ? "Creating…" : "Create task"}<ArrowRight size={16} /></button></footer>
  </form></div>;
}
