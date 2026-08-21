"use client";

import { useAuth, UserButton } from "@clerk/nextjs";
import { Client } from "eve/client";
import { useEveAgent } from "eve/react";
import {
  createContext,
  FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Markdown } from "@/components/markdown";
import type { AgentMessage, AgentProfile, ConversationProfile } from "@/lib/types";

interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  failed: boolean;
}

type DeleteTarget =
  | { kind: "conversation"; conversation: ConversationProfile }
  | { kind: "agent"; agent: AgentProfile };

type ConsoleToken = () => Promise<string>;
type ColorTheme = "dark" | "light" | "system";
type ChatWidth = "default" | "wide";

const e2eToken =
  process.env.NODE_ENV === "production" ? undefined : process.env.NEXT_PUBLIC_E2E_TEST_TOKEN;
const ConsoleTokenContext = createContext<ConsoleToken | undefined>(undefined);

function useConsoleToken(): ConsoleToken {
  const getToken = useContext(ConsoleTokenContext);
  if (!getToken) throw new Error("Console authentication is unavailable");
  return getToken;
}

function ClerkConsoleTokenProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const consoleToken = useCallback(async () => (await getToken()) ?? "", [getToken]);
  return (
    <ConsoleTokenContext.Provider value={consoleToken}>
      {children}
    </ConsoleTokenContext.Provider>
  );
}

function PlusIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M4.8 6.2h10.4M8 3.8h4M6.4 6.2l.6 9h6l.6-9M8.5 8.6v4.2m3-4.2v4.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M10 6.7a3.3 3.3 0 1 0 0 6.6 3.3 3.3 0 0 0 0-6.6Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="m16.1 11.2 1.1.8-1.5 2.6-1.3-.5a6.8 6.8 0 0 1-1.6.9l-.2 1.4h-3l-.2-1.4a6.8 6.8 0 0 1-1.6-.9l-1.3.5L5 12l1.1-.8a6.6 6.6 0 0 1 0-1.8L5 8.6 6.5 6l1.3.5a6.8 6.8 0 0 1 1.6-.9l.2-1.4h3l.2 1.4a6.8 6.8 0 0 1 1.6.9l1.3-.5 1.5 2.6-1.1.8a6.6 6.6 0 0 1 0 1.8Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 2.5v1.4M10 16.1v1.4M2.5 10h1.4M16.1 10h1.4M4.7 4.7l1 1m8.6 8.6 1 1m0-10.6-1 1m-8.6 8.6-1 1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M15.8 12.9A6.5 6.5 0 0 1 7.1 4.2 6.5 6.5 0 1 0 15.8 13Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
    </svg>
  );
}

function SiteSettings() {
  const [theme, setTheme] = useState<ColorTheme>("system");
  const [chatWidth, setChatWidth] = useState<ChatWidth>("default");

  useEffect(() => {
    const syncSettings = () => {
      const storedTheme = window.localStorage.getItem("agent-console-theme");
      const nextTheme: ColorTheme = storedTheme === "dark" || storedTheme === "light"
        ? storedTheme
        : "system";
      const nextWidth = window.localStorage.getItem("agent-console-chat-width") === "wide"
        ? "wide"
        : "default";
      const resolvedTheme = nextTheme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
        : nextTheme;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.chatWidth = nextWidth;
      setTheme(nextTheme);
      setChatWidth(nextWidth);
    };
    const timer = window.setTimeout(syncSettings, 0);
    window.addEventListener("agent-console-settings", syncSettings);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("agent-console-settings", syncSettings);
    };
  }, []);

  function updateTheme(next: ColorTheme) {
    if (next === "system") window.localStorage.removeItem("agent-console-theme");
    else window.localStorage.setItem("agent-console-theme", next);
    window.dispatchEvent(new Event("agent-console-settings"));
  }

  function updateChatWidth(next: ChatWidth) {
    if (next === "wide") window.localStorage.setItem("agent-console-chat-width", next);
    else window.localStorage.removeItem("agent-console-chat-width");
    window.dispatchEvent(new Event("agent-console-settings"));
  }

  return (
    <details className="site-settings">
      <summary><SettingsIcon /><span>Site settings</span><i>⌃</i></summary>
      <div className="site-settings-menu">
        <strong>Appearance</strong>
        <div className="setting-options three">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              className={theme === option ? "active" : ""}
              key={option}
              onClick={() => updateTheme(option)}
              type="button"
            >
              {option === "system" ? "System" : option === "light" ? <><SunIcon /> Light</> : <><MoonIcon /> Dark</>}
            </button>
          ))}
        </div>
        <strong>Chat width</strong>
        <div className="setting-options">
          <button className={chatWidth === "default" ? "active" : ""} onClick={() => updateChatWidth("default")} type="button">Default</button>
          <button className={chatWidth === "wide" ? "active" : ""} onClick={() => updateChatWidth("wide")} type="button">Wide</button>
        </div>
      </div>
    </details>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M15.7 6.5V3.8m0 0H13m2.7 0-2.1 2.1A6 6 0 1 0 16 10.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="m5.5 10 4.5-4.5m0 0 4.5 4.5M10 5.5v9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M12 2.8c.7 5.6 3.6 8.5 9.2 9.2-5.6.7-8.5 3.6-9.2 9.2-.7-5.6-3.6-8.5-9.2-9.2 5.6-.7 8.5-3.6 9.2-9.2Z" fill="currentColor" />
    </svg>
  );
}

function PanelIcon({ open = false }: { open?: boolean }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <rect height="14" rx="2" stroke="currentColor" strokeWidth="1.4" width="16" x="2" y="3" />
      <path d="M7 3v14" stroke="currentColor" strokeWidth="1.4" />
      {open ? <path d="m12 7 3 3-3 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" /> : null}
    </svg>
  );
}

function EveMark() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <path d="M12 4 21 20H3L12 4Z" fill="currentColor" />
    </svg>
  );
}

function mergeTranscript(saved: readonly AgentMessage[], live: readonly TranscriptEntry[]) {
  const merged: TranscriptEntry[] = saved.map(({ id, role, text, failed }) => ({
    id,
    role,
    text,
    failed,
  }));
  const savedCounts = new Map<string, number>();
  for (const entry of saved) {
    const key = `${entry.role}\u0000${entry.text}`;
    savedCounts.set(key, (savedCounts.get(key) ?? 0) + 1);
  }
  for (const entry of live) {
    const key = `${entry.role}\u0000${entry.text}`;
    const remaining = savedCounts.get(key) ?? 0;
    if (remaining > 0) savedCounts.set(key, remaining - 1);
    else merged.push(entry);
  }
  return merged;
}

function isInternalNotification(text: string): boolean {
  return (
    text === "__CONSOLE_MAILBOX_IDLE__" ||
    /^Background task task_[A-Za-z0-9]+ \(send_message\) is (?:completed|failed|cancelled)\./.test(
      text,
    )
  );
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${response.status})`;
}

function MessageText({ text }: { text: string }) {
  return text.split(/(```[\s\S]*?```)/g).map((part, index) => {
    if (!part.startsWith("```")) return <span key={`${index}:${part.slice(0, 12)}`}>{part}</span>;
    const code = part.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return (
      <pre key={`${index}:${code.slice(0, 12)}`}>
        <code>{code}</code>
      </pre>
    );
  });
}

function AgentChat({
  agent,
  conversation,
  onConversationUpdate,
  onOpenSidebar,
  onOpenSettings,
  onStartConversation,
  refreshConversations,
  refreshRoster,
  sidebarOpen,
}: {
  agent: AgentProfile;
  conversation: ConversationProfile;
  onConversationUpdate: (conversation: ConversationProfile) => void;
  onOpenSidebar: () => void;
  onOpenSettings: () => void;
  onStartConversation: (agentId: string) => Promise<void>;
  refreshConversations: () => void;
  refreshRoster: () => void;
  sidebarOpen: boolean;
}) {
  const getToken = useConsoleToken();
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [savedMessages, setSavedMessages] = useState<AgentMessage[]>([]);
  const refreshMessages = useCallback(async () => {
    const response = await fetch(`/api/conversations/${conversation.id}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as {
      conversation: ConversationProfile;
      messages: AgentMessage[];
    };
    setSavedMessages(body.messages);
    onConversationUpdate(body.conversation);
  }, [conversation.id, onConversationUpdate]);
  useEffect(() => {
    let ignore = false;
    void fetch(`/api/conversations/${conversation.id}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { conversation: ConversationProfile; messages: AgentMessage[] } | undefined) => {
        if (!ignore && body) {
          setSavedMessages(body.messages);
          onConversationUpdate(body.conversation);
        }
      });
    return () => {
      ignore = true;
    };
  }, [conversation.id, onConversationUpdate]);
  const eve = useEveAgent({
    auth: { bearer: async () => (await getToken()) ?? "" },
    headers: () => ({
      "x-console-agent-id": agent.id,
      "x-console-conversation-id": conversation.id,
    }),
    initialSession: conversation.eveSessionId
      ? { sessionId: conversation.eveSessionId, streamIndex: 0 }
      : undefined,
    onFinish: () => {
      refreshRoster();
      refreshConversations();
      void refreshMessages();
    },
  });
  const liveEntries = useMemo<TranscriptEntry[]>(
    () =>
      eve.data.messages.flatMap((message) => {
        if (message.role !== "user" && message.role !== "assistant") return [];
        const text = message.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim();
        return text && !isInternalNotification(text)
          ? [
              {
                id: message.id,
                role: message.role,
                text,
                failed: message.metadata?.status === "failed",
              },
            ]
          : [];
      }),
    [eve.data.messages],
  );
  const entries = useMemo(
    () => mergeTranscript(savedMessages, liveEntries),
    [liveEntries, savedMessages],
  );
  const busy = eve.status === "submitted" || eve.status === "streaming";
  const latestEntry = entries.at(-1);
  const awaitingFx = latestEntry?.role === "user" && !latestEntry.failed;
  const working = busy || awaitingFx || conversation.status === "working";
  const lastRequest = [...entries].reverse().find((entry) => entry.role === "user")?.text;
  const eveSessionId = eve.session?.sessionId ?? conversation.eveSessionId;

  useEffect(() => {
    if (!eveSessionId) return;
    const abortController = new AbortController();
    const client = new Client({
      host: "",
      auth: { bearer: async () => (await getToken()) ?? "" },
      headers: () => ({
        "x-console-agent-id": agent.id,
        "x-console-conversation-id": conversation.id,
      }),
    });
    const session = client.sessions.attach(eveSessionId);

    void (async () => {
      try {
        for await (const event of session.stream({
          signal: abortController.signal,
          startIndex: -1,
        })) {
          if (
            event.type === "action.partial" ||
            event.type === "action.result" ||
            event.type === "turn.completed" ||
            event.type === "turn.failed" ||
            event.type === "turn.cancelled"
          ) {
            await refreshMessages();
            refreshConversations();
            refreshRoster();
          }
        }
      } catch {
        // The durable stream can disconnect during development rebuilds or
        // navigation. The next mount resumes from Eve's persisted session.
      }
    })();

    return () => abortController.abort();
  }, [
    agent.id,
    conversation.id,
    eveSessionId,
    getToken,
    refreshConversations,
    refreshMessages,
    refreshRoster,
  ]);

  async function dispatchMessage(message: string) {
    const messageId = crypto.randomUUID();
    setSavedMessages((current) => [
      ...current,
      {
        id: `optimistic:${messageId}`,
        requestId: messageId,
        role: "user",
        text: message,
        failed: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    const options = {
      turnPolicy: "queue" as const,
      headers: { "x-console-message-id": messageId },
    };
    try {
      if (!eveSessionId) {
        await eve.send(message, options);
        return;
      }
      const client = new Client({
        host: "",
        auth: { bearer: async () => (await getToken()) ?? "" },
        headers: () => ({
          "x-console-agent-id": agent.id,
          "x-console-conversation-id": conversation.id,
        }),
      });
      await client.sessions.attach(eveSessionId).send(message, options);
      await refreshMessages();
    } catch (error) {
      setSavedMessages((current) =>
        current.map((entry) =>
          entry.id === `optimistic:${messageId}` ? { ...entry, failed: true } : entry,
        ),
      );
      throw error;
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || (busy && !eveSessionId)) return;
    setDraft("");
    setLocalError(undefined);
    onConversationUpdate({
      ...conversation,
      status: "working",
      title: conversation.title === "New conversation" ? message.slice(0, 64) : conversation.title,
      updatedAt: new Date().toISOString(),
    });
    try {
      await dispatchMessage(message);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to send message");
    }
  }

  async function retryLastRequest() {
    if (!lastRequest || retrying) return;
    setRetrying(true);
    setLocalError(undefined);
    try {
      await dispatchMessage(lastRequest);
      refreshConversations();
      refreshRoster();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to retry request");
    } finally {
      setRetrying(false);
    }
  }

  async function startFreshSession() {
    setLocalError(undefined);
    setStarting(true);
    try {
      await onStartConversation(agent.id);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to start a new session");
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="chat-shell">
      <header className="agent-header">
        <div className="agent-header-start">
          <button
            aria-label="Open sidebar"
            className={`sidebar-open-button${sidebarOpen ? " desktop-hidden" : ""}`}
            onClick={onOpenSidebar}
            type="button"
          >
            <PanelIcon open />
          </button>
          <div className="agent-identity">
          <div className="agent-header-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="agent-title-row">
              <h1>{agent.name}</h1>
              <span className="agent-state"><i />{working ? "Working" : "Ready"}</span>
            </div>
            <p>{agent.specialty}</p>
          </div>
          </div>
        </div>
        <div className="header-actions">
          <button
            aria-label="Start a fresh session"
            className="header-action"
            disabled={starting}
            onClick={startFreshSession}
            type="button"
          >
            <RefreshIcon />
            <span>{starting ? "Starting…" : "New session"}</span>
          </button>
          <div className="runtime-badge" title={agent.fxConfig.model}>
            {agent.fxConfig.model}
          </div>
          <button
            aria-label="Agent settings"
            className="header-icon-button"
            onClick={onOpenSettings}
            title="Agent settings"
            type="button"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      <div className="messages">
        {entries.length === 0 ? (
          <div className="empty-state">
            <div className="agent-mark"><SparkIcon /></div>
            <p className="empty-kicker">{agent.name} is ready</p>
            <h2>What can I help you accomplish?</h2>
            <p>
              Work continues in a private persistent workspace, with tools, skills, and context
              available across sessions.
            </p>
            <div className="prompt-suggestions">
              {[
                "Explore this workspace",
                "Build and test a feature",
                "Create a specialist agent",
              ].map((suggestion) => (
                <button key={suggestion} onClick={() => setDraft(suggestion)} type="button">
                  {suggestion}
                  <span>↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          entries.map((entry) => (
            <article className={`message ${entry.role}${entry.failed ? " failed" : ""}`} key={entry.id}>
              {entry.role === "assistant" ? (
                <div className="message-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              ) : null}
              <div className="message-body">
                {entry.role === "assistant" ? <span>{agent.name}</span> : null}
                <div className="message-copy">
                  {entry.role === "assistant" ? (
                    <Markdown>{entry.text}</Markdown>
                  ) : (
                    <MessageText text={entry.text} />
                  )}
                </div>
                {entry.failed ? (
                  <div className="failed-message-actions">
                    <small>Request failed. Your message is safely preserved.</small>
                    <button disabled={retrying} onClick={retryLastRequest} type="button">
                      {retrying ? "Retrying…" : "Retry"}
                    </button>
                  </div>
                ) : null}
              </div>
            </article>
          ))
        )}
        {working ? (
          <article className="message assistant pending">
            <div className="message-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
            <div className="message-body">
              <span>{agent.name}</span>
              <div className="thinking-row">
                <i />
                <i />
                <i />
                <small>Working in the sandbox</small>
              </div>
            </div>
          </article>
        ) : null}
      </div>

      <div className="composer-area">
        <form className="composer" onSubmit={submit}>
          <textarea
            aria-label={`Message ${agent.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={`Message ${agent.name}…`}
            rows={2}
            value={draft}
          />
          <div className="composer-footer">
            <span><kbd>Enter</kbd> to send · <kbd>Shift Enter</kbd> for a new line</span>
            <button
              aria-label="Send message"
              disabled={!draft.trim() || (busy && !eveSessionId)}
              type="submit"
            >
              <SendIcon />
            </button>
          </div>
        </form>
        <footer className="workspace-footer">
          <span>Private workspace · Persistent context</span>
          <span>© 2026 <a href="https://shekkizh.com" rel="noreferrer" target="_blank">shekkizh.com</a></span>
        </footer>
      </div>
      {localError || eve.error ? (
        <div className="request-error">
          <span>{localError ?? eve.error?.message}</span>
          {lastRequest ? (
            <button disabled={retrying} onClick={retryLastRequest} type="button">
              {retrying ? "Retrying…" : "Retry request"}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AgentDialog({
  agent,
  close,
  saved,
}: {
  agent?: AgentProfile;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [specialty, setSpecialty] = useState(agent?.specialty ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [model, setModel] = useState(agent?.fxConfig.model ?? "zai/glm-5.2");
  const [maxSteps, setMaxSteps] = useState(agent?.fxConfig.maxSteps ?? 48);
  const [permissionMode, setPermissionMode] = useState(agent?.fxConfig.permissionMode ?? "yolo");
  const [skills, setSkills] = useState(JSON.stringify(agent?.fxConfig.skills ?? [], null, 2));
  const [mcpServers, setMcpServers] = useState(
    JSON.stringify(agent?.fxConfig.mcpServers ?? {}, null, 2),
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    let parsedSkills: unknown;
    let parsedMcpServers: unknown;
    try {
      parsedSkills = JSON.parse(skills);
      parsedMcpServers = JSON.parse(mcpServers);
    } catch {
      setError("Skills and MCP servers must be valid JSON.");
      setSaving(false);
      return;
    }
    const response = await fetch(agent ? `/api/agents/${agent.id}` : "/api/agents", {
      method: agent ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        specialty,
        instructions,
        model,
        maxSteps,
        permissionMode,
        skills: parsedSkills,
        mcpServers: parsedMcpServers,
      }),
    });
    if (!response.ok) {
      setError(await readError(response));
      setSaving(false);
      return;
    }
    saved();
    close();
  }

  return (
    <div className="dialog-backdrop" onMouseDown={close}>
      <form className="dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">{agent ? "Agent settings" : "New persistent agent"}</p>
            <h2>{agent ? agent.name : "Create an agent"}</h2>
          </div>
          <button className="icon-button" onClick={close} type="button">×</button>
        </div>
        <label>
          Name
          <input minLength={2} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        <label>
          Specialty
          <input minLength={2} onChange={(event) => setSpecialty(event.target.value)} required value={specialty} />
        </label>
        <label>
          Durable instructions
          <textarea minLength={8} onChange={(event) => setInstructions(event.target.value)} required rows={6} value={instructions} />
        </label>
        <div className="field-row">
          <label>
            Model
            <input onChange={(event) => setModel(event.target.value)} required value={model} />
          </label>
          <label>
            Max steps
            <input max={128} min={1} onChange={(event) => setMaxSteps(Number(event.target.value))} required type="number" value={maxSteps} />
          </label>
          <label>
            Permissions
            <select onChange={(event) => setPermissionMode(event.target.value as "auto" | "yolo")} value={permissionMode}>
              <option value="auto">Ask when needed</option>
              <option value="yolo">Full sandbox access</option>
            </select>
          </label>
        </div>
        <details className="capabilities-section">
          <summary>
            <span>Skills & MCP</span>
            <small>{agent?.fxConfig.skills.length ?? 0} skills · {Object.keys(agent?.fxConfig.mcpServers ?? {}).length} servers</small>
          </summary>
          <div className="capability-fields">
            <label>
              Skills
              <textarea aria-label="Skills JSON" onChange={(event) => setSkills(event.target.value)} rows={8} spellCheck={false} value={skills} />
              <small>A JSON list of name, description, and instructions. These are installed into this agent’s workspace.</small>
            </label>
            <label>
              MCP servers
              <textarea aria-label="MCP servers JSON" onChange={(event) => setMcpServers(event.target.value)} rows={8} spellCheck={false} value={mcpServers} />
              <small>A JSON object keyed by server name using fx’s HTTP, SSE, local, or stdio format.</small>
            </label>
          </div>
        </details>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="secondary" onClick={close} type="button">Cancel</button>
          <button disabled={saving} type="submit">{saving ? "Saving…" : agent ? "Save config" : "Create agent"}</button>
        </div>
      </form>
    </div>
  );
}

function ConfirmDeleteDialog({
  close,
  confirm,
  target,
}: {
  close: () => void;
  confirm: () => Promise<void>;
  target: DeleteTarget;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const isAgent = target.kind === "agent";
  const name = isAgent ? target.agent.name : target.conversation.title;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDeleting(true);
    setError(undefined);
    try {
      await confirm();
      close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete");
      setDeleting(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={deleting ? undefined : close}>
      <form
        aria-labelledby="delete-dialog-title"
        aria-modal="true"
        className="dialog delete-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
        role="dialog"
      >
        <div className="delete-dialog-icon"><TrashIcon /></div>
        <div>
          <p className="delete-dialog-kicker">Permanent deletion</p>
          <h2 id="delete-dialog-title">Delete {isAgent ? "agent" : "conversation"}?</h2>
        </div>
        <p className="delete-dialog-copy">
          <strong>{name}</strong> {isAgent
            ? "will be permanently deleted. Its conversations and history will remain available through General."
            : "and its complete message history will be permanently deleted."}
        </p>
        <p className="delete-dialog-warning">This action cannot be undone.</p>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="dialog-actions delete-dialog-actions">
          <button className="secondary" disabled={deleting} onClick={close} type="button">Cancel</button>
          <button className="danger" disabled={deleting} type="submit">
            {deleting ? "Deleting…" : `Delete ${isAgent ? "agent" : "conversation"}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function AgentConsoleContent({
  initialAgents,
  initialConversations,
}: {
  initialAgents: AgentProfile[];
  initialConversations: ConversationProfile[];
}) {
  const getToken = useConsoleToken();
  const [agents, setAgents] = useState(initialAgents);
  const [conversations, setConversations] = useState(initialConversations);
  const [selectedConversationId, setSelectedConversationId] = useState(
    initialConversations[0]?.id,
  );
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>();
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const seenBackgroundEvents = useRef(new Set<string>());
  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedConversationId) ??
    conversations[0];
  const selected =
    agents.find((agent) => agent.id === selectedConversation?.agentId) ?? agents[0];

  function setSidebarOpen(open: boolean) {
    setDesktopSidebarOpen(open);
  }

  function chooseConversation(conversationId: string) {
    setSelectedConversationId(conversationId);
    setMobileSidebarOpen(false);
  }

  const updateConversation = useCallback((updated: ConversationProfile) => {
    setConversations((current) => [
      updated,
      ...current.filter((conversation) => conversation.id !== updated.id),
    ]);
  }, []);

  const refreshRoster = useCallback(async () => {
    const response = await fetch("/api/agents", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { agents: AgentProfile[] };
    setAgents(body.agents);
  }, []);

  const refreshConversations = useCallback(async () => {
    const response = await fetch("/api/conversations", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { conversations: ConversationProfile[] };
    setConversations(body.conversations);
    setSelectedConversationId((current) => current ?? body.conversations[0]?.id);
  }, []);

  const startConversation = useCallback(async (agentId: string) => {
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const created = (await response.json()) as ConversationProfile;
    setConversations((current) => [created, ...current]);
    setSelectedConversationId(created.id);
    setMobileSidebarOpen(false);
  }, []);

  const retireConversation = useCallback(async (conversation: ConversationProfile) => {
    if (!conversation.eveSessionId) return;
    const client = new Client({
      host: "",
      auth: { bearer: async () => (await getToken()) ?? "" },
      headers: {
        "x-console-agent-id": conversation.agentId,
        "x-console-conversation-id": conversation.id,
      },
    });
    const session = client.sessions.attach(conversation.eveSessionId);
    await session.cancel().catch(() => undefined);
    await session.reset({ reason: "Deleted from Agent Console" }).catch(() => undefined);
  }, [getToken]);

  const removeConversation = useCallback(async (conversation: ConversationProfile) => {
    await retireConversation(conversation);
    const response = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await readError(response));

    const remaining = conversations.filter((candidate) => candidate.id !== conversation.id);
    setConversations(remaining);
    if (selectedConversationId === conversation.id) {
      setSelectedConversationId(remaining[0]?.id);
    }
    if (remaining.length === 0) {
      const fallback = agents.find((agent) => agent.id.startsWith("general-")) ?? agents[0];
      if (fallback) await startConversation(fallback.id);
    }
  }, [agents, conversations, retireConversation, selectedConversationId, startConversation]);

  const removeAgent = useCallback(async (agent: AgentProfile) => {
    await Promise.all(
      conversations
        .filter((conversation) => conversation.agentId === agent.id)
        .map(retireConversation),
    );
    const response = await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await readError(response));

    const remainingAgents = agents.filter((candidate) => candidate.id !== agent.id);
    const fallback = remainingAgents.find((candidate) => candidate.id.startsWith("general-"));
    const remainingConversations = conversations.map((conversation) =>
      conversation.agentId === agent.id && fallback
        ? {
            ...conversation,
            agentId: fallback.id,
            agentName: fallback.name,
            eveSessionId: null,
            status: conversation.status === "working" ? "failed" as const : conversation.status,
          }
        : conversation,
    );
    setAgents(remainingAgents);
    setConversations(remainingConversations);
  }, [agents, conversations, retireConversation]);

  const chooseAgent = useCallback(
    async (agentId: string) => {
      const recent = conversations.find((conversation) => conversation.agentId === agentId);
      if (recent) chooseConversation(recent.id);
      else await startConversation(agentId);
    },
    [conversations, startConversation],
  );

  useEffect(() => {
    const watchers = conversations
      .filter(
        (conversation) =>
          conversation.id !== selectedConversationId &&
          conversation.status === "working" &&
          Boolean(conversation.eveSessionId),
      )
      .map((conversation) => {
        const abortController = new AbortController();
        const client = new Client({
          host: "",
          auth: { bearer: async () => (await getToken()) ?? "" },
          headers: () => ({
            "x-console-agent-id": conversation.agentId,
            "x-console-conversation-id": conversation.id,
          }),
        });
        const session = client.sessions.attach(conversation.eveSessionId!);
        void (async () => {
          try {
            for await (const event of session.stream({
              signal: abortController.signal,
              startIndex: -1,
            })) {
              if (
                event.type === "turn.completed" ||
                event.type === "turn.failed" ||
                event.type === "turn.cancelled"
              ) {
                const eventId = event.meta.id;
                if (seenBackgroundEvents.current.has(eventId)) continue;
                seenBackgroundEvents.current.add(eventId);
                await refreshConversations();
              }
            }
          } catch {
            // Leaving a conversation only closes its browser stream; the
            // durable Eve task and fx sandbox continue server-side.
          }
        })();
        return abortController;
      });
    return () => watchers.forEach((watcher) => watcher.abort());
  }, [conversations, getToken, refreshConversations, selectedConversationId]);

  if (!selected || !selectedConversation) return null;

  const sidebar = (mobile = false) => (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><EveMark /></div>
        <div><strong>Agent Console</strong><span>Persistent workers</span></div>
        <button
          aria-label="Close sidebar"
          className="sidebar-close-button"
          onClick={() => mobile ? setMobileSidebarOpen(false) : setSidebarOpen(false)}
          type="button"
        >
          <PanelIcon />
        </button>
      </div>
      <button
        className="new-agent-button"
        onClick={() => void startConversation(selected.id)}
        type="button"
      >
        <PlusIcon />
        New conversation
      </button>
      <div className="sidebar-heading">
        <span>Conversations</span><small>{conversations.length}</small>
      </div>
      <nav aria-label="Conversations" className="conversation-list">
        {conversations.map((conversation) => (
          <div className="conversation-row" key={conversation.id}>
            <button
              className={
                conversation.id === selectedConversation.id
                  ? "conversation-link active"
                  : "conversation-link"
              }
              onClick={() => chooseConversation(conversation.id)}
              type="button"
            >
              <span>
                <strong>{conversation.title}</strong>
                <small>{conversation.agentName}</small>
              </span>
              <i className={`conversation-status ${conversation.status}`} title={conversation.status} />
            </button>
            <button
              aria-label={`Delete conversation ${conversation.title}`}
              className="row-delete-button"
              onClick={() => setDeleteTarget({ kind: "conversation", conversation })}
              title="Delete conversation"
              type="button"
            >
              <TrashIcon />
            </button>
          </div>
        ))}
      </nav>
      <details className="agent-directory">
        <summary>
          <span>Agents</span><small>{agents.length}</small>
        </summary>
        <div className="agent-directory-list">
          {agents.map((agent) => (
            <div className="agent-directory-row" key={agent.id}>
              <button onClick={() => void chooseAgent(agent.id)} type="button">
                <span className="avatar">{agent.name.slice(0, 2).toUpperCase()}</span>
                <span><strong>{agent.name}</strong><small>{agent.specialty}</small></span>
              </button>
              {agent.id.startsWith("general-") ? null : (
                <button
                  aria-label={`Delete agent ${agent.name}`}
                  className="row-delete-button"
                  onClick={() => setDeleteTarget({ kind: "agent", agent })}
                  title="Delete agent"
                  type="button"
                >
                  <TrashIcon />
                </button>
              )}
            </div>
          ))}
          <button
            className="create-agent-link"
            onClick={() => { setDialog("create"); setMobileSidebarOpen(false); }}
            type="button"
          >
            <PlusIcon /> Create agent
          </button>
        </div>
      </details>
      <div className="sidebar-footer">
        <SiteSettings />
        <div className="user-button-wrap">{e2eToken ? null : <UserButton />}</div>
      </div>
    </aside>
  );

  return (
    <main className="console-layout">
      <div className={`desktop-sidebar${desktopSidebarOpen ? "" : " closed"}`}>
        {sidebar()}
      </div>
      <AgentChat
        agent={selected}
        conversation={selectedConversation}
        key={`${selectedConversation.id}:${selected.id}:${selectedConversation.eveSessionId ?? "new"}`}
        onConversationUpdate={updateConversation}
        onOpenSettings={() => setDialog("edit")}
        onOpenSidebar={() => {
          if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen(true);
          else setSidebarOpen(true);
        }}
        onStartConversation={startConversation}
        refreshConversations={refreshConversations}
        refreshRoster={refreshRoster}
        sidebarOpen={desktopSidebarOpen}
      />
      <div
        aria-hidden={!mobileSidebarOpen}
        className={`mobile-sidebar-backdrop${mobileSidebarOpen ? " open" : ""}`}
        onClick={() => setMobileSidebarOpen(false)}
      />
      <div className={`mobile-sidebar${mobileSidebarOpen ? " open" : ""}`}>
        {sidebar(true)}
      </div>
      {dialog ? <AgentDialog agent={dialog === "edit" ? selected : undefined} close={() => setDialog(null)} saved={refreshRoster} /> : null}
      {deleteTarget ? (
        <ConfirmDeleteDialog
          close={() => setDeleteTarget(undefined)}
          confirm={() => deleteTarget.kind === "agent"
            ? removeAgent(deleteTarget.agent)
            : removeConversation(deleteTarget.conversation)}
          target={deleteTarget}
        />
      ) : null}
    </main>
  );
}

export function AgentConsole(props: {
  initialAgents: AgentProfile[];
  initialConversations: ConversationProfile[];
}) {
  if (e2eToken) {
    return (
      <ConsoleTokenContext.Provider value={async () => e2eToken}>
        <AgentConsoleContent {...props} />
      </ConsoleTokenContext.Provider>
    );
  }
  return (
    <ClerkConsoleTokenProvider>
      <AgentConsoleContent {...props} />
    </ClerkConsoleTokenProvider>
  );
}
