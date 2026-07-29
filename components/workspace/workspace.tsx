"use client";

import { ArrowRight, Bot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ContextPanel } from "@/components/workspace/context-panel";
import { NewAgentDialog } from "@/components/workspace/new-agent-dialog";
import { NewTaskDialog } from "@/components/workspace/new-task-dialog";
import { Sidebar } from "@/components/workspace/sidebar";
import { TaskList, type TaskFilter } from "@/components/workspace/task-list";
import { TaskThread } from "@/components/workspace/task-thread";
import type { AgentProfile, AgentTask, WorkspaceSnapshot } from "@/lib/types";

export function Workspace({ initialSnapshot }: { initialSnapshot: WorkspaceSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState(initialSnapshot.tasks[0]?.id ?? "");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [contextOpen, setContextOpen] = useState(true);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [openTaskAfterAgent, setOpenTaskAfterAgent] = useState(false);
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
  function requestNewTask() {
    if (!snapshot.agents.length) {
      setOpenTaskAfterAgent(true);
      setNewAgentOpen(true);
      return;
    }
    setNewTaskOpen(true);
  }
  async function createAgent(input: { name: string; specialty: string; instructions: string }) {
    setError(undefined);
    const response = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json() as AgentProfile & { error?: string };
    if (!response.ok) { const message = body.error ?? "Unable to create agent"; setError(message); throw new Error(message); }
    setSnapshot((current) => ({ ...current, agents: [...current.agents, body] }));
    if (openTaskAfterAgent) { setOpenTaskAfterAgent(false); setNewTaskOpen(true); }
  }
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
    <Sidebar agents={snapshot.agents} tasks={snapshot.tasks} filter={filter} onFilter={setFilter} onNewTask={requestNewTask} onAddAgent={() => { setOpenTaskAfterAgent(false); setNewAgentOpen(true); }} />
    <div className="app-surface">
      <TaskList tasks={snapshot.tasks} agents={snapshot.agents} selectedId={selectedTask?.id ?? ""} filter={filter} onFilter={setFilter} onSelect={selectTask} onNewTask={requestNewTask} />
      {selectedTask ? <TaskThread task={selectedTask} agent={selectedAgent} sending={sending} onSend={sendMessage} onBack={() => setMobileThread(false)} onToggleContext={() => setContextOpen((value) => !value)} /> : null}
      {selectedTask && contextOpen ? <ContextPanel task={selectedTask} agent={selectedAgent} onClose={() => setContextOpen(false)} /> : null}
      {!selectedTask ? <EmptyWorkspace hasAgents={snapshot.agents.length > 0} onAction={snapshot.agents.length ? requestNewTask : () => { setOpenTaskAfterAgent(false); setNewAgentOpen(true); }} /> : null}
    </div>
    {error ? <button className="error-toast" type="button" onClick={() => setError(undefined)}>{error}<XIcon /></button> : null}
    {newAgentOpen ? <NewAgentDialog onClose={() => { setNewAgentOpen(false); setOpenTaskAfterAgent(false); }} onCreate={createAgent} /> : null}
    {newTaskOpen ? <NewTaskDialog agents={snapshot.agents} onClose={() => setNewTaskOpen(false)} onCreate={createTask} /> : null}
  </div>;
}

function EmptyWorkspace({ hasAgents, onAction }: { hasAgents: boolean; onAction: () => void }) {
  return <section className="empty-workspace" aria-label="Get started">
    <span className="empty-workspace-icon"><Bot size={22} /></span>
    <h2>{hasAgents ? "Your workspace is ready" : "Build your agent bench"}</h2>
    <p>{hasAgents ? "Give an agent its first outcome and keep the work moving here." : "Create the roles you actually need, with instructions that carry into every task."}</p>
    <button className="primary-button" type="button" onClick={onAction}>{hasAgents ? "Create first task" : "Create an agent"}<ArrowRight size={16} /></button>
  </section>;
}

function XIcon() { return <span aria-hidden="true">×</span>; }
