import type { TaskStatus } from "@/lib/types";

const labels: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Needs you",
  completed: "Done",
  failed: "Failed",
};

export function Status({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  return (
    <span className={`status status-${status} ${compact ? "status-compact" : ""}`}>
      <span className="status-dot" aria-hidden="true" />
      {labels[status]}
    </span>
  );
}
