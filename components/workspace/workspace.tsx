"use client";

import { ArrowRight, Bot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NewChat } from "@/components/workspace/new-chat";
import { NewAgentDialog } from "@/components/workspace/new-agent-dialog";
import { TaskList, type TaskFilter } from "@/components/workspace/task-list";
import { TaskThread } from "@/components/workspace/task-thread";
import type { AgentProfile, ChannelMessage, CreateChatInput, WorkspaceSnapshot } from "@/lib/types";

export function Workspace({ initialSnapshot }: { initialSnapshot: WorkspaceSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedId, setSelectedId] = useState(initialSnapshot.channels[0]?.id ?? "");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [mobileThread, setMobileThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const channels = useMemo(() => snapshot.channels, [snapshot.channels]);
  const selectedChannel = useMemo(() => channels.find((channel) => channel.id === selectedId) ?? channels[0], [channels, selectedId]);
  const selectedChannelId = selectedChannel?.id;
  const selectedChannelStatus = selectedChannel?.status;

  useEffect(() => {
    if (!selectedChannelId || !["running", "waiting"].includes(selectedChannelStatus ?? "") || sending) return;
    let active = true;
    let timer: number;
    async function poll() {
      try {
        const response = await fetch(`/api/channels/${selectedChannelId}/run`);
        const body = await response.json() as WorkspaceSnapshot & { error?: string };
        if (response.ok && active) { setSnapshot(body); setError(undefined); }
        else if (active) setError(body.error ?? "Unable to refresh the channel");
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to refresh the channel");
      } finally {
        if (active) timer = window.setTimeout(poll, 5_000);
      }
    }
    timer = window.setTimeout(poll, 5_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [selectedChannelId, selectedChannelStatus, sending]);

  function selectChannel(id: string) { setSelectedId(id); setNewChatOpen(false); setMobileThread(true); }
  function requestNewChannel() { setNewChatOpen(true); setMobileThread(true); }

  async function createAgent(input: { name: string; specialty: string; instructions: string }) {
    setError(undefined);
    const response = await fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json() as AgentProfile & { error?: string };
    if (!response.ok) { const message = body.error ?? "Unable to create agent"; setError(message); throw new Error(message); }
    setSnapshot((current) => ({ ...current, agents: [...current.agents, body] }));
  }

  async function sendMessage(content: string, recipientIds: string[], replyToId?: string) {
    if (!selectedChannel) return;
    setSending(true); setError(undefined);
    const optimistic: ChannelMessage = {
      id: crypto.randomUUID(), role: "user", author: snapshot.currentUser.name, authorId: snapshot.currentUser.id, authorName: snapshot.currentUser.name,
      authorType: "human", content, createdAt: new Date().toISOString(), recipientIds, delivery: recipientIds.length ? "direct" : "broadcast", replyToId,
    };
    setSnapshot((current) => ({ ...current, channels: current.channels.map((channel) => channel.id === selectedChannel.id ? { ...channel, status: "running", messages: [...channel.messages, optimistic] } : channel) }));
    try {
      const response = await fetch(`/api/channels/${selectedChannel.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, recipientIds, replyToId }) });
      const body = await response.json() as WorkspaceSnapshot & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Unable to send message");
      setSnapshot(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to send message"); }
    finally { setSending(false); }
  }

  async function createChannel(input: CreateChatInput) {
    setError(undefined);
    const response = await fetch("/api/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const body = await response.json() as { channelId?: string; snapshot?: WorkspaceSnapshot; error?: string };
    if (!response.ok) { const message = body.error ?? "Unable to create channel"; setError(message); throw new Error(message); }
    if (!body.channelId || !body.snapshot) throw new Error("The new channel could not be loaded");
    setSnapshot(body.snapshot); setSelectedId(body.channelId); setFilter("all"); setNewChatOpen(false); setMobileThread(true);
  }

  return <div className={`workspace-shell ${mobileThread ? "show-mobile-thread" : ""}`}>
    <div className="app-surface">
      <TaskList channels={channels} selectedId={selectedChannel?.id ?? ""} filter={filter} onFilter={setFilter} onSelect={selectChannel} onNewTask={requestNewChannel} onAddAgent={() => setNewAgentOpen(true)} />
      {newChatOpen ? <NewChat agents={snapshot.agents} currentUser={snapshot.currentUser} onBack={() => { setNewChatOpen(false); setMobileThread(false); }} onCreate={createChannel} /> : selectedChannel ? <TaskThread channel={selectedChannel} currentUser={snapshot.currentUser} sending={sending} onSend={sendMessage} onBack={() => setMobileThread(false)} /> : null}
      {!selectedChannel && !newChatOpen ? <EmptyWorkspace hasAgents={snapshot.agents.length > 0} onAction={requestNewChannel} /> : null}
    </div>
    {error ? <button className="error-toast" type="button" onClick={() => setError(undefined)}>{error}<span aria-hidden="true">×</span></button> : null}
    {newAgentOpen ? <NewAgentDialog onClose={() => setNewAgentOpen(false)} onCreate={createAgent} /> : null}
  </div>;
}

function EmptyWorkspace({ hasAgents, onAction }: { hasAgents: boolean; onAction: () => void }) {
  return <section className="empty-workspace" aria-label="Get started">
    <span className="empty-workspace-icon"><Bot size={22} /></span>
    <h2>{hasAgents ? "Start a team channel" : "Invite your first teammate"}</h2>
    <p>Bring people and agents into one shared conversation. Everyone can coordinate, reply, and share results as a peer.</p>
    <button className="primary-button" type="button" onClick={onAction}>New channel<ArrowRight size={16} /></button>
  </section>;
}
