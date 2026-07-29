"use client";

import { useEffect, useMemo, useState } from "react";
import { ContextPanel } from "@/components/workspace/context-panel";
import { NewTaskDialog } from "@/components/workspace/new-task-dialog";
import { Sidebar } from "@/components/workspace/sidebar";
import { TaskList, type TaskFilter } from "@/components/workspace/task-list";
import { TaskThread } from "@/components/workspace/task-thread";
import type { AgentTask, WorkspaceSnapshot } from "@/lib/types";

export function Workspace({ initialSnapshot }: { initialSnapshot: WorkspaceSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState(initialSnapshot.tasks[0]?.id ?? "");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [contextOpen, setContextOpen] = useState(true);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const selectedTask = useMemo(() => snapshot.tasks.find((task) => task.id === selectedId) ?? snapshot.tasks[0], [snapshot.tasks, selectedId]);
  const selectedAgent = snapshot.agents.find((agent) => agent.id === selectedTask?.agentId);

  useEffect(() => {
    if (!selectedTask || selectedTask.status !== "running" || !selectedTask.interactionId) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/tasks/${selectedTask.id}/run`);
      if (!response.ok) return;
      const updated = await response.json() as AgentTask;
      setSnapshot((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === updated.id ? updated : task) }));
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [selectedTask]);

  function selectTask(id: string) { setSelectedId(id); setMobileThread(true); setContextOpen(false); }
  async function sendMessage(content: string) {
    if (!selectedTask) return;
    setSending(true); setError(undefined);
    const optimistic = { id: crypto.randomUUID(), role: "user" as const, author: "You", content, createdAt: new Date().toISOString() };
    setSnapshot((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === selectedTask.id ? { ...task, status: "running", messages: [...task.messages, optimistic] } : task) }));
    try {
      const response = await fetch(`/api/tasks/${selectedTask.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Unable to send message");
      setSnapshot((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === body.id ? body : task) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to send message"); }
    finally { setSending(false); }
  }
  async function createTask(input: { title: string; summary: string; agentId: string; repositoryUrl?: string }) {
    setError(undefined);
    const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok) { const message = body.error ?? "Unable to create task"; setError(message); throw new Error(message); }
    setSnapshot((current) => ({ ...current, tasks: [body, ...current.tasks] })); setSelectedId(body.id); setFilter("all"); setMobileThread(true);
  }

  return <div className={`workspace-shell ${mobileThread ? "show-mobile-thread" : ""} ${contextOpen ? "context-is-open" : ""}`}>
    <Sidebar agents={snapshot.agents} onNewTask={() => setNewTaskOpen(true)} />
    <div className="app-surface">
      <TaskList tasks={snapshot.tasks} agents={snapshot.agents} selectedId={selectedTask?.id ?? ""} filter={filter} onFilter={setFilter} onSelect={selectTask} onNewTask={() => setNewTaskOpen(true)} />
      {selectedTask ? <TaskThread task={selectedTask} agent={selectedAgent} sending={sending} onSend={sendMessage} onBack={() => setMobileThread(false)} onToggleContext={() => setContextOpen((value) => !value)} /> : null}
      {selectedTask && contextOpen ? <ContextPanel task={selectedTask} agent={selectedAgent} onClose={() => setContextOpen(false)} /> : null}
    </div>
    {error ? <button className="error-toast" type="button" onClick={() => setError(undefined)}>{error}<XIcon /></button> : null}
    {newTaskOpen ? <NewTaskDialog agents={snapshot.agents} onClose={() => setNewTaskOpen(false)} onCreate={createTask} /> : null}
  </div>;
}

function XIcon() { return <span aria-hidden="true">×</span>; }
