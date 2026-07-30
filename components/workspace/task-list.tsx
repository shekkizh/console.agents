import { ChevronRight, Plus, Sparkles, UserRoundPlus } from "lucide-react";
import { Status } from "@/components/workspace/status";
import type { Channel, TaskStatus } from "@/lib/types";

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

export function TaskList({ channels, selectedId, filter, onFilter, onSelect, onNewTask, onAddAgent }: {
  channels: Channel[];
  selectedId: string;
  filter: TaskFilter;
  onFilter: (filter: TaskFilter) => void;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  onAddAgent: () => void;
}) {
  const visibleChannels = channels.filter((channel) => matchesFilter(channel.status, filter));
  return (
    <section className="task-list-panel" aria-label="Channels">
      <header className="task-list-header"><span className="brand-mark"><Sparkles size={17} /></span><strong>Console</strong></header>
      <button className="new-task-button" type="button" onClick={onNewTask}><Plus size={17} />New channel</button>
      <div className="filters" role="tablist" aria-label="Filter channels">
        {filters.map((item) => <button key={item.value} className={filter === item.value ? "active" : ""} onClick={() => onFilter(item.value)} type="button" role="tab" aria-selected={filter === item.value}>{item.label}</button>)}
      </div>
      <div className="task-scroll">
        {visibleChannels.length ? visibleChannels.map((channel) => (
          <button className={`task-row ${selectedId === channel.id ? "selected" : ""}`} type="button" key={channel.id} onClick={() => onSelect(channel.id)}>
            <div className="task-row-top"><Status status={channel.status} compact /><time>{relativeTime(channel.updatedAt)}</time></div>
            <strong className="task-title">{channel.title}</strong>
            <span className="task-summary">{channel.summary}</span>
            <div className="task-row-bottom">
              <span className="task-peer-stack" aria-label={`${channel.participants.length} participants`}>
                {channel.participants.slice(0, 4).map((peer) => <span className="avatar avatar-tiny" style={{ background: peer.color }} key={peer.id}>{peer.initials}</span>)}
                <span>{channel.participants.length} peers</span>
              </span>
              <ChevronRight size={16} />
            </div>
          </button>
        )) : <div className="empty-list"><strong>Nothing here</strong><span>This view is clear for now.</span></div>}
      </div>
      <footer className="task-list-footer">
        <button type="button" onClick={onAddAgent}><UserRoundPlus size={16} /><span>New agent</span></button>
      </footer>
    </section>
  );
}
