import { ArrowLeft, ArrowUp, Bot, Check, ChevronDown, Code2, FileText, Search, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Status } from "@/components/workspace/status";
import type { AgentProfile, AgentTask, RunStep } from "@/lib/types";

const stepIcons: Record<RunStep["kind"], React.ReactNode> = {
  plan: <Sparkles size={14} />, search: <Search size={14} />, code: <Code2 size={14} />, file: <FileText size={14} />, result: <Check size={14} />,
};

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function TaskThread({ task, childTasks, agent, sending, onSend, onBack }: {
  task: AgentTask;
  childTasks: AgentTask[];
  agent?: AgentProfile;
  sending: boolean;
  onSend: (content: string) => Promise<void>;
  onBack: () => void;
}) {
  const [content, setContent] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [task.messages.length, sending]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = content.trim();
    if (!value || sending) return;
    setContent("");
    await onSend(value);
  }

  return (
    <main className="thread-panel">
      <header className="thread-header">
        <button className="mobile-back icon-button" type="button" onClick={onBack} aria-label="Back to tasks"><ArrowLeft size={18} /></button>
        <div className="thread-heading"><h2>{task.title}</h2><div><Status status={task.status} compact /><span>with {agent?.name ?? "Agent"}</span></div></div>
      </header>
      <div className="message-scroll">
        <div className="conversation-date"><span>Task started {new Date(task.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}</span></div>
        {childTasks.length ? <section className="delegated-work" aria-label="Delegated work">
          <header><span><Bot size={14} />Delegated work</span><small>{childTasks.length} temporary worker{childTasks.length === 1 ? "" : "s"}</small></header>
          <div>{childTasks.map((child) => <div className="delegated-task" key={child.id}><span className="avatar avatar-tiny" style={{ background: agent?.color }}>{agent?.initials ?? "GE"}</span><strong>{child.title}</strong><Status status={child.status} compact /></div>)}</div>
        </section> : null}
        {task.messages.map((message) => message.role === "user" ? (
          <article className="message message-user" key={message.id}>
            <div className="message-meta"><strong>You</strong><time>{messageTime(message.createdAt)}</time></div>
            <div className="user-bubble">{message.content}</div>
          </article>
        ) : (
          <article className="message message-agent" key={message.id}>
            <span className="avatar" style={{ background: agent?.color }}>{agent?.initials ?? "AI"}</span>
            <div className="message-body">
              <div className="message-meta"><strong>{message.author}</strong><time>{messageTime(message.createdAt)}</time></div>
              {message.steps?.length ? <div className="run-steps">
                <div className="run-steps-title"><span>Work log</span><ChevronDown size={14} /></div>
                {message.steps.map((step) => <div className="run-step" key={step.id}><span className="step-icon">{stepIcons[step.kind]}</span><span><strong>{step.label}</strong>{step.detail ? <small>{step.detail}</small> : null}</span></div>)}
              </div> : null}
              <div className="agent-copy">{message.content}</div>
            </div>
          </article>
        ))}
        {sending || task.status === "running" && task.messages.at(-1)?.role === "user" ? <div className="working-row"><span className="avatar" style={{ background: agent?.color }}>{agent?.initials ?? "AI"}</span><span className="working-pulse"><i /><i /><i /></span><span>{agent?.name ?? "Agent"} is working</span></div> : null}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={task.status === "waiting" ? `Reply to ${agent?.name ?? "agent"}…` : "Add a message or redirect the work…"} rows={2} aria-label="Message" />
        <div className="composer-footer"><span><kbd>⌘</kbd><kbd>↵</kbd> to send</span><button className="send-button" type="submit" disabled={!content.trim() || sending} aria-label="Send message"><ArrowUp size={18} /></button></div>
      </form>
    </main>
  );
}
