"use client";

import { ArrowRight, Bot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NewAgentDialog } from "@/components/workspace/new-agent-dialog";
import { NewTaskDialog } from "@/components/workspace/new-task-dialog";
import { TaskList, type TaskFilter } from "@/components/workspace/task-list";
import { TaskThread } from "@/components/workspace/task-thread";
import type { AgentProfile, WorkspaceSnapshot } from "@/lib/types";

export function Workspace({ initialSnapshot }: { initialSnapshot: WorkspaceSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState(initialSnapshot.tasks.find((task) => !task.parentTaskId)?.id ?? "");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [openTaskAfterAgent, setOpenTaskAfterAgent] = useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const rootTasks = useMemo(() => snapshot.tasks.filter((task) => !task.parentTaskId), [snapshot.tasks]);
  const selectedTask = useMemo(() => rootTasks.find((task) => task.id === selectedId) ?? rootTasks[0], [rootTasks, selectedId]);
  const selectedAgent = snapshot.agents.find((agent) => agent.id === selectedTask?.agentId);
  const childTasks = useMemo(() => snapshot.tasks.filter((task) => task.parentTaskId === selectedTask?.id), [snapshot.tasks, selectedTask?.id]);

  useEffect(() => {
    if (!selectedTask || selectedTask.status !== "running" || !selectedTask.interactionId) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const response = await fetch(`/api/tasks/${selectedTask.id}/run`);
        if (response.ok && active) setSnapshot(await response.json() as WorkspaceSnapshot);
      } catch {
        // A later poll can recover from transient navigation or network failures.
      } finally {
        if (active) timer = window.setTimeout(poll, 5_000);
      }
    }
    timer = window.setTimeout(poll, 5_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedTask]);

  function selectTask(id: string) { setSelectedId(id); setMobileThread(true); }
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

  return <div className={`workspace-shell ${mobileThread ? "show-mobile-thread" : ""}`}>
    <div className="app-surface">
      <TaskList tasks={rootTasks} agents={snapshot.agents} selectedId={selectedTask?.id ?? ""} filter={filter} onFilter={setFilter} onSelect={selectTask} onNewTask={requestNewTask} onAddAgent={() => { setOpenTaskAfterAgent(false); setNewAgentOpen(true); }} />
      {selectedTask ? <TaskThread task={selectedTask} childTasks={childTasks} agent={selectedAgent} sending={sending} onSend={sendMessage} onBack={() => setMobileThread(false)} /> : null}
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
