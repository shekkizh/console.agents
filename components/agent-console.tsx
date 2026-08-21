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
import {
  ChevronDownIcon,
  CircleIcon,
  FileCode2Icon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  MoonIcon as LucideMoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon as LucidePlusIcon,
  SendIcon as LucideSendIcon,
  Settings2Icon,
  SparklesIcon,
  SunIcon as LucideSunIcon,
  Trash2Icon,
  TriangleIcon,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { AgentArtifact, AgentMessage, AgentProfile, ConversationProfile } from "@/lib/types";

interface TranscriptEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  artifacts: AgentArtifact[];
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
      document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="w-full justify-start text-muted-foreground" size="sm" variant="ghost">
          <Settings2Icon />
          Site settings
          <ChevronDownIcon className="ml-auto" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" side="top">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => updateTheme(value as ColorTheme)}>
          <DropdownMenuRadioItem value="system"><CircleIcon /> System</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light"><LucideSunIcon /> Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark"><LucideMoonIcon /> Dark</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Chat width</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={chatWidth} onValueChange={(value) => updateChatWidth(value as ChatWidth)}>
          <DropdownMenuRadioItem value="default">Default</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="wide">Wide</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function mergeTranscript(saved: readonly AgentMessage[], live: readonly TranscriptEntry[]) {
  const merged: TranscriptEntry[] = saved.map(({ id, role, text, artifacts, failed }) => ({
    id,
    role,
    text,
    artifacts,
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

function preserveConversationTitle(
  updated: ConversationProfile,
  existing: ConversationProfile | undefined,
): ConversationProfile {
  return existing && updated.title === "New conversation" && existing.title !== "New conversation"
    ? { ...updated, title: existing.title }
    : updated;
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

function artifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TextArtifactPreview({ artifact }: { artifact: AgentArtifact }) {
  const [content, setContent] = useState<string>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/artifacts/${encodeURIComponent(artifact.id)}`, {
      cache: "force-cache",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        setContent(await response.text());
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, [artifact.id]);

  if (error) {
    return <div className="px-4 py-8 text-center text-sm text-muted-foreground">Preview unavailable</div>;
  }
  if (content === undefined) {
    return <div className="shimmer px-4 py-8 text-center text-sm text-muted-foreground">Loading preview</div>;
  }
  return (
    <pre className="max-h-[32rem] overflow-auto p-4 text-xs leading-5">
      <code>{content}</code>
    </pre>
  );
}

function ArtifactPreview({ artifact }: { artifact: AgentArtifact }) {
  const source = `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const Icon = artifact.kind === "image" ? ImageIcon : artifact.kind === "pdf" ? FileTextIcon : FileCode2Icon;
  return (
    <figure className="overflow-hidden rounded-2xl border bg-card">
      <figcaption className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{artifact.title}</span>
        <span className="shrink-0 text-muted-foreground">{artifactSize(artifact.size)}</span>
      </figcaption>
      {artifact.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={artifact.title} className="max-h-[42rem] w-full bg-muted/30 object-contain" loading="lazy" src={source} />
      ) : artifact.kind === "pdf" ? (
        <iframe className="h-[36rem] w-full bg-white" src={source} title={artifact.title} />
      ) : (
        <TextArtifactPreview artifact={artifact} />
      )}
    </figure>
  );
}

function ArtifactPreviews({ artifacts }: { artifacts: readonly AgentArtifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-4 grid gap-3">
      {artifacts.map((artifact) => <ArtifactPreview artifact={artifact} key={artifact.id} />)}
    </div>
  );
}

function AgentChat({
  agent,
  conversation,
  onConversationUpdate,
  onOpenSidebar,
  refreshConversations,
  refreshRoster,
  sidebarOpen,
}: {
  agent: AgentProfile;
  conversation: ConversationProfile;
  onConversationUpdate: (conversation: ConversationProfile) => void;
  onOpenSidebar: () => void;
  refreshConversations: () => void;
  refreshRoster: () => void;
  sidebarOpen: boolean;
}) {
  const getToken = useConsoleToken();
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string>();
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
                artifacts: [],
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
        artifacts: [],
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

  const activityLabel = eve.status === "submitted"
    ? "Queued"
    : eve.status === "streaming"
      ? "Generating response"
      : "Working in the sandbox";

  return (
    <section className="grid min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-background">
      <header className="flex min-h-16 items-center justify-between gap-3 border-b bg-background/90 px-3 backdrop-blur-md sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button aria-label="Open sidebar" className={sidebarOpen ? "md:hidden" : ""} onClick={onOpenSidebar} size="icon" type="button" variant="ghost">
            <PanelLeftOpenIcon />
          </Button>
          <Avatar className="hidden size-9 rounded-xl sm:flex">
            <AvatarFallback className="rounded-xl bg-primary text-xs text-primary-foreground">
              {agent.name.slice(0, 1).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{agent.name}</h1>
              <Badge className="gap-1 px-1.5 font-normal" variant="secondary">
                <span className={`size-1.5 rounded-full ${working ? "animate-pulse bg-amber-500" : "bg-emerald-500"}`} />
                {working ? "Working" : "Ready"}
              </Badge>
            </div>
            <p className="hidden truncate text-xs text-muted-foreground sm:block">{agent.specialty}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge className="hidden max-w-52 truncate font-mono font-normal lg:inline-flex" title={agent.fxConfig.model} variant="outline">
            {agent.fxConfig.model}
          </Badge>
        </div>
      </header>

      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent aria-busy={working} className="gap-7 py-8 sm:py-10">
              {entries.length === 0 ? (
                <MessageScrollerItem className="flex min-h-[calc(100dvh-17rem)] items-center px-4">
                  <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
                    <div className="mb-5 flex size-14 items-center justify-center rounded-3xl border bg-card shadow-sm">
                      <SparklesIcon className="size-6" />
                    </div>
                    <Badge className="mb-3" variant="secondary">{agent.name} is ready</Badge>
                    <h2 className="text-balance font-heading text-2xl font-medium tracking-tight sm:text-3xl">What can I help you accomplish?</h2>
                    <p className="mt-3 max-w-lg text-pretty text-sm leading-6 text-muted-foreground">
                      Work continues in a private persistent workspace, with tools, skills, and context available across sessions.
                    </p>
                    <div className="mt-7 grid w-full gap-2 sm:grid-cols-3">
                      {["Explore this workspace", "Build and test a feature", "Create a specialist agent"].map((suggestion) => (
                        <Button className="h-auto min-h-14 justify-between whitespace-normal px-4 py-3 text-left" key={suggestion} onClick={() => setDraft(suggestion)} type="button" variant="outline">
                          {suggestion}<span aria-hidden="true">↗</span>
                        </Button>
                      ))}
                    </div>
                  </div>
                </MessageScrollerItem>
              ) : entries.map((entry) => (
                <MessageScrollerItem
                  className="mx-auto w-full max-w-[var(--chat-content-width)] px-4 sm:px-6"
                  key={entry.id}
                  messageId={entry.id}
                  scrollAnchor={entry.role === "user"}
                >
                  <article className={`message ${entry.role}${entry.failed ? " failed" : ""}`}>
                    <Message align={entry.role === "user" ? "end" : "start"}>
                      {entry.role === "assistant" ? (
                        <MessageAvatar className="self-start">
                          <Avatar className="size-8">
                            <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">
                              {agent.name.slice(0, 1).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        </MessageAvatar>
                      ) : null}
                      <MessageContent>
                        {entry.role === "assistant" ? <MessageHeader>{agent.name}</MessageHeader> : null}
                        <Bubble className={entry.role === "assistant" ? "w-full" : "max-w-[min(85%,40rem)]"} variant={entry.failed ? "destructive" : entry.role === "assistant" ? "ghost" : "secondary"}>
                          <BubbleContent className={entry.role === "assistant" ? "message-copy w-full text-[0.925rem] leading-7" : "message-copy whitespace-pre-wrap px-4 py-3"}>
                            {entry.role === "assistant" ? (
                              <>
                                <Markdown>{entry.text}</Markdown>
                                <ArtifactPreviews artifacts={entry.artifacts} />
                              </>
                            ) : <MessageText text={entry.text} />}
                          </BubbleContent>
                        </Bubble>
                        {entry.failed ? (
                          <MessageFooter className="gap-2 text-destructive">
                            Request failed. Your message is safely preserved.
                            <Button disabled={retrying} onClick={retryLastRequest} size="xs" type="button" variant="destructive">
                              {retrying ? "Retrying…" : "Retry"}
                            </Button>
                          </MessageFooter>
                        ) : null}
                      </MessageContent>
                    </Message>
                  </article>
                </MessageScrollerItem>
              ))}
              {working ? (
                <MessageScrollerItem className="mx-auto w-full max-w-[var(--chat-content-width)] px-4 sm:px-6">
                  <article className="message assistant pending">
                    <Marker role="status">
                      <MarkerIcon><LoaderCircleIcon className="animate-spin" /></MarkerIcon>
                      <MarkerContent className="shimmer">{activityLabel}</MarkerContent>
                    </Marker>
                  </article>
                </MessageScrollerItem>
              ) : null}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      <div className="border-t bg-background/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto w-full max-w-[var(--chat-content-width)]">
          {localError || eve.error ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>{localError ?? eve.error?.message}</span>
              {lastRequest ? <Button disabled={retrying} onClick={retryLastRequest} size="xs" type="button" variant="destructive">Retry</Button> : null}
            </div>
          ) : null}
          <form className="relative rounded-3xl border bg-card shadow-sm transition-shadow focus-within:ring-3 focus-within:ring-ring/20" onSubmit={submit}>
            <Textarea
              aria-label={`Message ${agent.name}`}
              className="max-h-40 min-h-20 resize-none border-0 bg-transparent px-4 pb-11 pt-3 shadow-none focus-visible:ring-0"
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
            <div className="absolute inset-x-3 bottom-2 flex items-center justify-between">
              <span className="hidden text-[11px] text-muted-foreground sm:inline"><kbd>Enter</kbd> to send · <kbd>Shift Enter</kbd> for a new line</span>
              <Button aria-label="Send message" className="ml-auto rounded-xl" disabled={!draft.trim() || (busy && !eveSessionId)} size="icon-sm" type="submit">
                <LucideSendIcon />
              </Button>
            </div>
          </form>
          <footer className="mt-2 flex justify-between px-1 text-[10px] text-muted-foreground">
            <span>Private workspace · Persistent context</span>
            <a className="hover:text-foreground" href="https://shekkizh.com" rel="noreferrer" target="_blank">© 2026 shekkizh.com</a>
          </footer>
        </div>
      </div>
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
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <Badge className="mb-1" variant="secondary">{agent ? "Agent settings" : "New persistent agent"}</Badge>
            <DialogTitle className="text-xl">{agent ? agent.name : "Create an agent"}</DialogTitle>
            <DialogDescription>Configure the agent’s identity, runtime, skills, and tool connections.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="agent-name">Name</Label>
              <Input id="agent-name" minLength={2} onChange={(event) => setName(event.target.value)} required value={name} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-specialty">Specialty</Label>
              <Input id="agent-specialty" minLength={2} onChange={(event) => setSpecialty(event.target.value)} required value={specialty} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="agent-instructions">Durable instructions</Label>
            <Textarea id="agent-instructions" minLength={8} onChange={(event) => setInstructions(event.target.value)} required rows={6} value={instructions} />
          </div>
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem_12rem]">
            <div className="grid gap-2">
              <Label htmlFor="agent-model">Model</Label>
              <Input id="agent-model" onChange={(event) => setModel(event.target.value)} required value={model} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="agent-steps">Max steps</Label>
              <Input id="agent-steps" max={128} min={1} onChange={(event) => setMaxSteps(Number(event.target.value))} required type="number" value={maxSteps} />
            </div>
            <div className="grid gap-2">
              <Label>Permissions</Label>
              <Select onValueChange={(value) => setPermissionMode(value as "auto" | "yolo")} value={permissionMode}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Ask when needed</SelectItem>
                  <SelectItem value="yolo">Full sandbox access</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <details className="group rounded-3xl border bg-muted/20">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
              <span>Skills & MCP</span>
              <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                {agent?.fxConfig.skills.length ?? 0} skills · {Object.keys(agent?.fxConfig.mcpServers ?? {}).length} servers
                <ChevronDownIcon className="transition-transform group-open:rotate-180" />
              </span>
            </summary>
            <Separator />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="agent-skills">Skills</Label>
                <Textarea className="font-mono text-xs" id="agent-skills" onChange={(event) => setSkills(event.target.value)} rows={10} spellCheck={false} value={skills} />
                <p className="text-xs text-muted-foreground">JSON list of installed skills.</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="agent-mcp">MCP servers</Label>
                <Textarea className="font-mono text-xs" id="agent-mcp" onChange={(event) => setMcpServers(event.target.value)} rows={10} spellCheck={false} value={mcpServers} />
                <p className="text-xs text-muted-foreground">JSON object keyed by server name.</p>
              </div>
            </div>
          </details>
          {error ? <p className="rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button onClick={close} type="button" variant="outline">Cancel</Button>
            <Button disabled={saving} type="submit">{saving ? "Saving…" : agent ? "Save config" : "Create agent"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
    <Dialog open onOpenChange={(open) => { if (!open && !deleting) close(); }}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-5" onSubmit={submit}>
          <DialogHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <Trash2Icon />
            </div>
            <Badge className="mb-1" variant="destructive">Permanent deletion</Badge>
            <DialogTitle className="text-xl">Delete {isAgent ? "agent" : "conversation"}?</DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">{name}</strong> {isAgent
                ? "will be permanently deleted. Its conversations and history will remain available through General."
                : "and its complete message history will be permanently deleted."}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">This action cannot be undone.</p>
          {error ? <p className="rounded-2xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button disabled={deleting} onClick={close} type="button" variant="outline">Cancel</Button>
            <Button disabled={deleting} type="submit" variant="destructive">
              {deleting ? "Deleting…" : `Delete ${isAgent ? "agent" : "conversation"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const [editingAgentId, setEditingAgentId] = useState<string>();
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
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === updated.id);
      const next = preserveConversationTitle(updated, existing);
      return [next, ...current.filter((conversation) => conversation.id !== updated.id)];
    });
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
    setConversations((current) => body.conversations.map((conversation) =>
      preserveConversationTitle(
        conversation,
        current.find((existing) => existing.id === conversation.id),
      ),
    ));
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
    <aside className="sidebar flex h-full min-h-0 flex-col border-r bg-sidebar p-2 text-sidebar-foreground">
      <div className="flex items-center gap-2 px-2 py-2">
        <div className="flex size-8 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground">
          <TriangleIcon className="size-4 fill-current" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Agent Console</p>
          <p className="text-[11px] text-muted-foreground">Persistent workers</p>
        </div>
        <Button aria-label="Close sidebar" onClick={() => mobile ? setMobileSidebarOpen(false) : setSidebarOpen(false)} size="icon-sm" type="button" variant="ghost">
          <PanelLeftCloseIcon />
        </Button>
      </div>
      <Button className="mt-1 justify-start" onClick={() => void startConversation(selected.id)} type="button" variant="ghost">
        <LucidePlusIcon /> New conversation
      </Button>
      <div className="flex items-center justify-between px-3 pb-1 pt-5 text-xs font-medium text-muted-foreground">
        <span>Conversations</span><Badge className="h-5 min-w-5 px-1.5" variant="secondary">{conversations.length}</Badge>
      </div>
      <nav aria-label="Conversations" className="conversation-list min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {conversations.map((conversation) => (
          <div className="conversation-row group flex min-w-0 items-center" key={conversation.id}>
            <Button
              className={`conversation-link h-auto min-w-0 flex-1 justify-start rounded-xl px-2.5 py-2 text-left ${conversation.id === selectedConversation.id ? "active bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground"}`}
              onClick={() => chooseConversation(conversation.id)}
              type="button"
              variant="ghost"
            >
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <strong className="w-full truncate text-xs font-medium">{conversation.title}</strong>
                <small className="mt-0.5 w-full truncate text-[10px] font-normal text-muted-foreground">{conversation.agentName}</small>
              </span>
              <i className={`conversation-status ${conversation.status} size-1.5 shrink-0 rounded-full ${conversation.status === "working" ? "animate-pulse bg-amber-500" : conversation.status === "completed" ? "bg-emerald-500" : conversation.status === "failed" ? "bg-destructive" : conversation.status === "needs_input" ? "bg-blue-500" : "bg-muted-foreground/50"}`} title={conversation.status} />
            </Button>
            <Button
              aria-label={`Delete conversation ${conversation.title}`}
              className="row-delete-button size-7 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100"
              onClick={() => setDeleteTarget({ kind: "conversation", conversation })}
              size="icon-sm"
              title="Delete conversation"
              type="button"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
      </nav>
      <Separator className="my-2" />
      <details className="group shrink-0">
        <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent">
          <span>Agents</span>
          <span className="flex items-center gap-1"><Badge className="h-5 min-w-5 px-1.5" variant="secondary">{agents.length}</Badge><ChevronDownIcon className="transition-transform group-open:rotate-180" /></span>
        </summary>
        <div className="agent-directory-list mt-1 hidden max-h-52 space-y-0.5 overflow-y-auto group-open:block">
          {agents.map((agent) => (
            <div className="agent-directory-row group/agent flex min-w-0 items-center" key={agent.id}>
              <Button className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-1.5 text-left" onClick={() => void chooseAgent(agent.id)} type="button" variant="ghost">
                <Avatar className="size-7"><AvatarFallback className="text-[9px]">{agent.name.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
                <span className="flex min-w-0 flex-1 flex-col items-start"><strong className="w-full truncate text-xs font-medium">{agent.name}</strong><small className="w-full truncate text-[10px] font-normal text-muted-foreground">{agent.specialty}</small></span>
              </Button>
              <Button
                aria-label={`Edit agent ${agent.name}`}
                className="size-7 shrink-0 text-muted-foreground"
                onClick={() => {
                  setEditingAgentId(agent.id);
                  setDialog("edit");
                  setMobileSidebarOpen(false);
                }}
                size="icon-sm"
                title={`Edit ${agent.name}`}
                type="button"
                variant="ghost"
              >
                <Settings2Icon />
              </Button>
              {agent.id.startsWith("general-") ? null : (
                <Button
                  aria-label={`Delete agent ${agent.name}`}
                  className="row-delete-button size-7 opacity-0 group-hover/agent:opacity-100 group-focus-within/agent:opacity-100 max-md:opacity-100"
                  onClick={() => setDeleteTarget({ kind: "agent", agent })}
                  size="icon-sm"
                  title="Delete agent"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              )}
            </div>
          ))}
          <Button
            className="create-agent-link w-full justify-start text-xs text-muted-foreground"
            onClick={() => { setEditingAgentId(undefined); setDialog("create"); setMobileSidebarOpen(false); }}
            type="button"
            variant="ghost"
          >
            <LucidePlusIcon /> Create agent
          </Button>
        </div>
      </details>
      <div className="mt-2 flex shrink-0 items-center gap-2 border-t pt-2">
        <div className="min-w-0 flex-1"><SiteSettings /></div>
        <div className="user-button-wrap">{e2eToken ? null : <UserButton />}</div>
      </div>
    </aside>
  );

  return (
    <main className="console-layout flex h-dvh overflow-hidden bg-background">
      <div className={`desktop-sidebar hidden shrink-0 overflow-hidden transition-[width] duration-200 md:block ${desktopSidebarOpen ? "w-64" : "w-0"}`}>
        {sidebar()}
      </div>
      <AgentChat
        agent={selected}
        conversation={selectedConversation}
        key={`${selectedConversation.id}:${selected.id}:${selectedConversation.eveSessionId ?? "new"}`}
        onConversationUpdate={updateConversation}
        onOpenSidebar={() => {
          if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen(true);
          else setSidebarOpen(true);
        }}
        refreshConversations={refreshConversations}
        refreshRoster={refreshRoster}
        sidebarOpen={desktopSidebarOpen}
      />
      <div
        aria-hidden={!mobileSidebarOpen}
        className={`mobile-sidebar-backdrop fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity md:hidden ${mobileSidebarOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
        onClick={() => setMobileSidebarOpen(false)}
      />
      <div className={`mobile-sidebar fixed inset-y-0 left-0 z-50 w-[min(84vw,20rem)] shadow-2xl transition-transform duration-200 md:hidden ${mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        {sidebar(true)}
      </div>
      {dialog ? (
        <AgentDialog
          agent={dialog === "edit" ? agents.find((agent) => agent.id === editingAgentId) ?? selected : undefined}
          close={() => setDialog(null)}
          saved={refreshRoster}
        />
      ) : null}
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
