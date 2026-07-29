import { Archive, Bot, ChevronDown, CircleUserRound, Library, ListTodo, Plus, Search, Sparkles } from "lucide-react";
import type { AgentProfile } from "@/lib/types";

export function Sidebar({ agents, onNewTask }: { agents: AgentProfile[]; onNewTask: () => void }) {
  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>Console</span></div>
      <button className="search-button" type="button"><Search size={16} /><span>Search workspace</span><kbd>⌘ K</kbd></button>
      <nav className="primary-nav" aria-label="Primary navigation">
        <a className="nav-item active" href="#today"><ListTodo size={17} /><span>Today</span><span className="nav-count">4</span></a>
        <a className="nav-item" href="#agents"><Bot size={17} /><span>Agents</span></a>
        <a className="nav-item" href="#library"><Library size={17} /><span>Library</span></a>
        <a className="nav-item" href="#archive"><Archive size={17} /><span>Archive</span></a>
      </nav>
      <div className="sidebar-section">
        <div className="section-label"><span>Your agents</span><button aria-label="Add agent" type="button"><Plus size={14} /></button></div>
        <div className="agent-mini-list">
          {agents.map((agent) => (
            <div className="agent-mini" key={agent.id}>
              <span className="avatar avatar-small" style={{ background: agent.color }}>{agent.initials}</span>
              <span className="agent-mini-copy"><strong>{agent.name}</strong><small>{agent.status === "working" ? "Working now" : agent.specialty}</small></span>
              <span className={`presence presence-${agent.status}`} aria-label={agent.status} />
            </div>
          ))}
        </div>
      </div>
      <button className="new-task-sidebar" type="button" onClick={onNewTask}><Plus size={16} />New task</button>
      <button className="account-button" type="button"><CircleUserRound size={26} /><span><strong>Sarath</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button>
    </aside>
  );
}
