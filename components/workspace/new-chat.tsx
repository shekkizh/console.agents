import { ArrowLeft, ArrowUp, Github, UsersRound } from "lucide-react";
import { useState } from "react";
import type { AgentProfile, ChannelParticipant, CreateChatInput } from "@/lib/types";

function chatTitle(prompt: string) {
  const firstThought = prompt.trim().split(/\n|[.!?](?:\s|$)/)[0]?.trim() ?? "";
  return firstThought.slice(0, 120) || "New chat";
}

export function NewChat({ agents, currentUser, onBack, onCreate }: {
  agents: AgentProfile[];
  currentUser: ChannelParticipant;
  onBack: () => void;
  onCreate: (input: CreateChatInput) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>(() => [agents.find((agent) => agent.builtIn)?.id ?? agents[0]?.id].filter(Boolean) as string[]);
  const [sending, setSending] = useState(false);

  function toggleAgent(agentId: string) {
    setAgentIds((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const summary = prompt.trim();
    if (!summary || !agentIds.length || sending) return;
    setSending(true);
    try {
      await onCreate({ title: chatTitle(summary), summary, agentIds, repositoryUrl: repositoryUrl.trim() || undefined });
    } finally {
      setSending(false);
    }
  }

  return <main className="new-chat-panel">
    <header className="new-chat-header"><button className="mobile-back icon-button" type="button" onClick={onBack} aria-label="Back to channels"><ArrowLeft size={18} /></button><span>New channel</span></header>
    <form className="new-chat-form" onSubmit={submit}>
      <div className="new-chat-copy"><span className="new-chat-icon"><UsersRound size={21} /></span><h1>Start a team channel</h1><p>Choose your agent teammates. You join as a peer and everyone shares one conversation.</p></div>
      <fieldset className="team-picker"><legend>Channel members</legend><div>
        <div className="team-picker-person team-picker-human">
          <span className="avatar avatar-small" style={{ background: currentUser.color }}>{currentUser.initials}</span>
          <span><strong>{currentUser.name}</strong><small>{currentUser.specialty ?? "Human peer"}</small></span>
          <i aria-hidden="true" />
        </div>
        {agents.map((agent) => {
        const selected = agentIds.includes(agent.id);
        return <label className={selected ? "selected" : ""} key={agent.id}>
          <input type="checkbox" checked={selected} onChange={() => toggleAgent(agent.id)} />
          <span className="avatar avatar-small" style={{ background: agent.color }}>{agent.initials}</span>
          <span><strong>{agent.name}</strong><small>{agent.specialty}</small></span>
          <i aria-hidden="true" />
        </label>;
      })}</div></fieldset>
      <div className="new-chat-composer">
        <textarea autoFocus value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} placeholder="What should this team work on?" rows={5} aria-label="First channel message" />
        <label className="repository-field"><Github size={15} /><input type="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="GitHub repository (optional)" aria-label="GitHub repository" /></label>
        <footer><span><kbd>⌘</kbd><kbd>↵</kbd> to start</span><button className="send-button" type="submit" disabled={!prompt.trim() || !agentIds.length || sending} aria-label="Start channel">{sending ? <span className="button-spinner" /> : <ArrowUp size={18} />}</button></footer>
      </div>
    </form>
  </main>;
}
