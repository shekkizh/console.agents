import { ArrowLeft, ArrowUp, Check, ChevronDown, Code2, ExternalLink, FileText, FolderOpen, Github, Reply, Search, Sparkles, UsersRound, X } from "lucide-react";
import type { ReactNode } from "react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Status } from "@/components/workspace/status";
import type { Artifact, Channel, ChannelMessage, ChannelParticipant, RunStep } from "@/lib/types";

const stepIcons: Record<RunStep["kind"], React.ReactNode> = {
  plan: <Sparkles size={14} />, search: <Search size={14} />, code: <Code2 size={14} />, file: <FileText size={14} />, result: <Check size={14} />,
};

function messageTime(value: string) {
  return new Date(value).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function channelName(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "team-channel";
}

export function TaskThread({ channel, currentUser, sending, onSend, onBack }: {
  channel: Channel;
  currentUser: ChannelParticipant;
  sending: boolean;
  onSend: (content: string, recipientIds: string[], replyToId?: string) => Promise<void>;
  onBack: () => void;
}) {
  const [content, setContent] = useState("");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [replyToId, setReplyToId] = useState<string>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const peersById = useMemo(() => new Map(channel.participants.map((peer) => [peer.id, peer])), [channel.participants]);
  const replyMessage = replyToId ? channel.messages.find((message) => message.id === replyToId) : undefined;
  const recipients = recipientIds.map((id) => peersById.get(id)).filter((peer): peer is ChannelParticipant => Boolean(peer));

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [channel.artifacts.length, channel.messages.length, sending]);

  function toggleRecipient(id: string) {
    setRecipientIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
  }

  function startReply(message: ChannelMessage) {
    setReplyToId(message.id);
    setRecipientIds(message.authorId === currentUser.id ? [] : [message.authorId]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = content.trim();
    if (!value || sending) return;
    const sendRecipients = recipientIds;
    const sendReplyTo = replyToId;
    setContent(""); setReplyToId(undefined);
    await onSend(value, sendRecipients, sendReplyTo);
  }

  return (
    <main className="thread-panel">
      <header className="thread-header">
        <button className="mobile-back icon-button" type="button" onClick={onBack} aria-label="Back to channels"><ArrowLeft size={18} /></button>
        <div className="thread-heading"><h2><span aria-hidden="true">#</span>{channelName(channel.title)}</h2><div><Status status={channel.status} compact /><span>{channel.participants.length} peers</span></div></div>
        <div className="channel-participants" aria-label={`Channel members: ${channel.participants.map((peer) => peer.name).join(", ")}`}>
          <div className="participant-stack">{channel.participants.slice(0, 5).map((peer) => <span className="avatar avatar-small" title={`${peer.name}${peer.specialty ? ` · ${peer.specialty}` : ""}`} style={{ background: peer.color }} key={peer.id}>{peer.initials}</span>)}</div>
          <span className="participant-names">{channel.participants.map((peer) => peer.name).join(", ")}</span>
        </div>
      </header>
      <div className="message-scroll" ref={scrollRef}>
        <section className="channel-intro" aria-label="Channel overview">
          <span className="channel-intro-icon"><UsersRound size={18} /></span>
          <h1>{channel.title}</h1>
          <p>{channel.summary}</p>
          <div>{channel.participants.map((peer) => <span key={peer.id}><span className="avatar avatar-tiny" style={{ background: peer.color }}>{peer.initials}</span>{peer.name}{peer.specialty ? <small>{peer.specialty}</small> : null}</span>)}</div>
        </section>
        <div className="conversation-date"><span>Channel started {new Date(channel.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}</span></div>
        {channel.messages.map((message) => <PeerMessage message={message} channel={channel} currentUser={currentUser} peersById={peersById} onReply={startReply} key={message.id} />)}
        <ChannelOutputs artifacts={channel.artifacts} repositoryUrl={channel.repositoryUrl} status={channel.status} />
        {sending || channel.status === "running" ? <div className="working-row"><span className="working-pulse"><i /><i /><i /></span><span>Teammates are coordinating</span></div> : null}
      </div>
      <form className="composer" onSubmit={submit}>
        <div className="recipient-bar" aria-label="Message recipients">
          <span>To</span>
          <button type="button" className={recipientIds.length === 0 ? "selected" : ""} onClick={() => setRecipientIds([])}><UsersRound size={12} />Everyone</button>
          {channel.participants.filter((peer) => peer.id !== currentUser.id).map((peer) => <button type="button" className={recipientIds.includes(peer.id) ? "selected" : ""} onClick={() => toggleRecipient(peer.id)} key={peer.id}><span className="avatar avatar-micro" style={{ background: peer.color }}>{peer.initials}</span>{peer.name}</button>)}
        </div>
        {replyMessage ? <div className="composer-reply"><Reply size={12} /><span>Replying to <strong>{replyMessage.authorName}</strong></span><button type="button" onClick={() => setReplyToId(undefined)} aria-label="Cancel reply"><X size={13} /></button></div> : null}
        <textarea value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} placeholder={recipients.length ? `Message ${recipients.map((peer) => peer.name).join(", ")}…` : "Message everyone…"} rows={2} aria-label="Channel message" />
        <div className="composer-footer"><span>{recipientIds.length ? "Only selected peers will receive this" : "Broadcast to the channel"} · <kbd>⌘</kbd><kbd>↵</kbd> to send</span><button className="send-button" type="submit" disabled={!content.trim() || sending} aria-label="Send message"><ArrowUp size={18} /></button></div>
      </form>
    </main>
  );
}

function PeerMessage({ message, channel, currentUser, peersById, onReply }: {
  message: ChannelMessage;
  channel: Channel;
  currentUser: ChannelParticipant;
  peersById: Map<string, ChannelParticipant>;
  onReply: (message: ChannelMessage) => void;
}) {
  const peer = peersById.get(message.authorId);
  const repliedTo = message.replyToId ? channel.messages.find((candidate) => candidate.id === message.replyToId) : undefined;
  const recipientNames = message.recipientIds.map((id) => peersById.get(id)?.name).filter(Boolean);
  return <article className={`message message-peer ${message.authorId === currentUser.id ? "message-current-user" : ""}`}>
    <span className="avatar" style={{ background: peer?.color }}>{peer?.initials ?? message.authorName.slice(0, 2).toUpperCase()}</span>
    <div className="message-body">
      <div className="message-meta"><strong>{message.authorName}</strong>{peer?.specialty ? <span>{peer.specialty}</span> : null}<time>{messageTime(message.createdAt)}</time><span className={`delivery-label ${message.delivery === "direct" ? "delivery-direct" : ""}`}>{message.delivery === "direct" ? `to ${recipientNames.join(", ") || "selected peers"}` : "to everyone"}</span></div>
      {repliedTo ? <div className="quoted-message"><strong>{repliedTo.authorName}</strong><span>{repliedTo.content}</span></div> : null}
      {message.steps?.length ? <details className="run-steps">
        <summary className="run-steps-title"><span>Work details · {message.steps.length} update{message.steps.length === 1 ? "" : "s"}</span><ChevronDown size={14} /></summary>
        {message.steps.map((step) => <div className="run-step" key={step.id}><span className="step-icon">{stepIcons[step.kind]}</span><span><strong>{step.label}</strong>{step.detail ? <small>{step.detail}</small> : null}</span></div>)}
      </details> : null}
      <MessageContent content={message.content} />
      <button className="message-reply-button" type="button" onClick={() => onReply(message)}><Reply size={12} />Reply</button>
    </div>
  </article>;
}

function ChannelOutputs({ artifacts, repositoryUrl, status }: { artifacts: Artifact[]; repositoryUrl?: string; status: Channel["status"] }) {
  const hasResources = artifacts.length > 0 || Boolean(repositoryUrl);
  return <section className={`channel-outputs ${hasResources ? "" : "channel-outputs-empty"}`} aria-label="Channel files and links">
    <header><span><FolderOpen size={16} />Shared files & links</span><small>{artifacts.length} file{artifacts.length === 1 ? "" : "s"}</small></header>
    {hasResources ? <div className="output-grid">
      {artifacts.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} />)}
      {repositoryUrl ? <a className="output-card" href={repositoryUrl} target="_blank" rel="noreferrer"><span className="output-icon"><Github size={17} /></span><span><strong>Source repository</strong><small>{repositoryUrl.replace("https://github.com/", "")}</small></span><ExternalLink size={14} /></a> : null}
    </div> : <p>{status === "running" || status === "queued" ? "Files and links shared in the conversation will collect here." : "No files or links were shared in this channel."}</p>}
  </section>;
}

function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const content = <><span className="output-icon"><FileText size={17} /></span><span><strong>{artifact.name}</strong><small>{artifact.kind}{artifact.size ? ` · ${artifact.size}` : ""}</small></span>{artifact.url ? <ExternalLink size={14} /> : null}</>;
  return artifact.url ? <a className="output-card" href={artifact.url} target="_blank" rel="noreferrer">{content}</a> : <div className="output-card">{content}</div>;
}

function inlineContent(value: string): ReactNode[] {
  const tokens = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) return <a href={link[2]} target="_blank" rel="noreferrer" key={index}>{link[1]}<ExternalLink size={11} /></a>;
    return token;
  });
}

function MessageContent({ content }: { content: string }) {
  const blocks = content.trim().split(/\n{2,}/);
  return <div className="agent-copy">{blocks.map((block, index) => {
    const lines = block.split("\n");
    if (block.startsWith("```") && block.endsWith("```")) return <pre key={index}><code>{lines.slice(1, -1).join("\n")}</code></pre>;
    const heading = block.match(/^(#{1,4})\s+(.+)$/s);
    if (heading && !heading[2].includes("\n")) return <h3 key={index}>{inlineContent(heading[2])}</h3>;
    if (lines.every((line) => /^\s*[-*]\s+/.test(line))) return <ul key={index}>{lines.map((line, lineIndex) => <li key={lineIndex}>{inlineContent(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    return <p key={index}>{lines.map((line, lineIndex) => <span key={lineIndex}>{inlineContent(line)}{lineIndex < lines.length - 1 ? <br /> : null}</span>)}</p>;
  })}</div>;
}
