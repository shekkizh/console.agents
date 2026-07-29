import { ChevronRight, Plus, Sparkles, UserRoundPlus } from "lucide-react";
import { Status } from "@/components/workspace/status";
import type { AgentProfile, AgentTask, TaskStatus } from "@/lib/types";

export type TaskFilter = "all" | "active" | "waiting" | "completed";

const filters: Array<{ value: TaskFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "waiting", label: "Needs you" },
  { value: "completed", label: "Done" },
];

function matchesFilter(status: TaskStatus, filter: TaskFilter) {
  if (filter === "all") return true;
  if (filter === "active") return status === "queued" || status === "running";
  if (filter === "waiting") return status === "waiting";
  return status === "completed";
}

function relativeTime(value: string) {
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return day === new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : day;
}

export function TaskList({ tasks, agents, selectedId, filter, onFilter, onSelect, onNewTask, onAddAgent }: {
  tasks: AgentTask[];
  agents: AgentProfile[];
  selectedId: string;
  filter: TaskFilter;
  onFilter: (filter: TaskFilter) => void;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onAddAgent: () => void;
}) {
  const visibleTasks = tasks.filter((task) => matchesFilter(task.status, filter));
  return (
    <section className="task-list-panel" aria-label="Tasks">
      <header className="task-list-header"><span className="brand-mark"><Sparkles size={17} /></span><strong>Console</strong></header>
      <button className="new-task-button" type="button" onClick={onNewTask}><Plus size={17} />New task</button>
      <div className="filters" role="tablist" aria-label="Filter tasks">
        {filters.map((item) => <button key={item.value} className={filter === item.value ? "active" : ""} onClick={() => onFilter(item.value)} type="button" role="tab" aria-selected={filter === item.value}>{item.label}</button>)}
      </div>
      <div className="task-scroll">
        {visibleTasks.length ? visibleTasks.map((task) => {
          const agent = agents.find((item) => item.id === task.agentId);
          return (
            <button className={`task-row ${selectedId === task.id ? "selected" : ""}`} type="button" key={task.id} onClick={() => onSelect(task.id)}>
              <div className="task-row-top"><Status status={task.status} compact /><time>{relativeTime(task.updatedAt)}</time></div>
              <strong className="task-title">{task.title}</strong>
              <span className="task-summary">{task.summary}</span>
              <div className="task-row-bottom">
                {agent ? <span className="task-agent"><span className="avatar avatar-tiny" style={{ background: agent.color }}>{agent.initials}</span>{agent.name}</span> : <span />}
                <ChevronRight size={16} />
              </div>
            </button>
          );
        }) : <div className="empty-list"><strong>Nothing here</strong><span>This view is clear for now.</span></div>}
      </div>
      <footer className="task-list-footer">
        <button type="button" onClick={onAddAgent}><UserRoundPlus size={16} /><span>New agent</span></button>
      </footer>
    </section>
  );
}
