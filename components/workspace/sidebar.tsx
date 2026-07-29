import { Bot, CheckCircle2, ChevronDown, CircleUserRound, Clock3, ListTodo, Plus, Sparkles, UserRoundPlus } from "lucide-react";
import type { TaskFilter } from "@/components/workspace/task-list";
import type { AgentProfile, AgentTask } from "@/lib/types";

export function Sidebar({ agents, tasks, filter, onFilter, onNewTask, onAddAgent }: {
  agents: AgentProfile[];
  tasks: AgentTask[];
  filter: TaskFilter;
  onFilter: (filter: TaskFilter) => void;
  onNewTask: () => void;
  onAddAgent: () => void;
}) {
  const builtInAgents = agents.filter((agent) => agent.builtIn);
  const customAgents = agents.filter((agent) => !agent.builtIn);
  const counts: Record<TaskFilter, number> = {
    all: tasks.length,
    active: tasks.filter((task) => task.status === "queued" || task.status === "running").length,
    waiting: tasks.filter((task) => task.status === "waiting").length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };
  const taskViews: Array<{ filter: TaskFilter; label: string; icon: typeof ListTodo }> = [
    { filter: "all", label: "All tasks", icon: ListTodo },
    { filter: "active", label: "In progress", icon: Clock3 },
    { filter: "waiting", label: "Needs you", icon: Bot },
    { filter: "completed", label: "Completed", icon: CheckCircle2 },
  ];

  return (
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><Sparkles size={17} /></span><span>Console</span></div>
      <button className="new-task-sidebar new-task-sidebar-top" type="button" onClick={onNewTask}><Plus size={16} />New task</button>
      <nav className="primary-nav" aria-label="Task views">
        {taskViews.map((item) => {
          const Icon = item.icon;
          return <button className={`nav-item ${filter === item.filter ? "active" : ""}`} type="button" key={item.filter} onClick={() => onFilter(item.filter)}><Icon size={17} /><span>{item.label}</span><span className="nav-count">{counts[item.filter]}</span></button>;
        })}
      </nav>
      <div className="sidebar-section sidebar-section-built-in">
        <div className="section-label"><span>Built in</span></div>
        <div className="agent-mini-list">
          {builtInAgents.map((agent) => (
            <div className="agent-mini" key={agent.id}>
              <span className="avatar avatar-small" style={{ background: agent.color }}>{agent.initials}</span>
              <span className="agent-mini-copy"><strong>{agent.name}</strong><small>{agent.specialty}</small></span>
              <span className={`presence presence-${agent.status}`} aria-label={agent.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="sidebar-section">
        <div className="section-label"><span>Your agents</span><button aria-label="Add agent" type="button" onClick={onAddAgent}><Plus size={14} /></button></div>
        {customAgents.length ? <div className="agent-mini-list">
          {customAgents.map((agent) => (
            <div className="agent-mini" key={agent.id}>
              <span className="avatar avatar-small" style={{ background: agent.color }}>{agent.initials}</span>
              <span className="agent-mini-copy"><strong>{agent.name}</strong><small>{agent.status === "working" ? "Working now" : agent.specialty}</small></span>
              <span className={`presence presence-${agent.status}`} aria-label={agent.status} />
            </div>
          ))}
        </div> : <button className="empty-agents" type="button" onClick={onAddAgent}><span><UserRoundPlus size={16} /></span><strong>Create your first agent</strong><small>Add the roles you actually use.</small></button>}
      </div>
      <button className="account-button" type="button"><CircleUserRound size={26} /><span><strong>Sarath</strong><small>Personal workspace</small></span><ChevronDown size={15} /></button>
    </aside>
  );
}
