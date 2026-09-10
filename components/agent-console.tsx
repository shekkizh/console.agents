"use client";

import { UserButton } from "@clerk/nextjs";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowRightIcon,
  ChevronDownIcon,
  CircleIcon,
  ExternalLinkIcon,
  FileCode2Icon,
  FileTextIcon,
  ImageIcon,
  LoaderCircleIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  MoonIcon as LucideMoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon as LucidePlusIcon,
  RefreshCwIcon,
  SendIcon as LucideSendIcon,
  Settings2Icon,
  SquareIcon,
  SparklesIcon,
  SunIcon as LucideSunIcon,
  Trash2Icon,
  TriangleIcon,
} from "lucide-react";
import { useForegroundPolling } from "@/lib/foreground-polling";
import { Markdown } from "@/components/markdown";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import type {
  AgentArtifact,
  AgentMessage,
  AgentProfile,
  ConversationMessageActivity,
  ConversationProfile,
  FxNetworkAccess,
} from "@/lib/types";

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

type ColorTheme = "dark" | "light" | "system";
type ChatWidth = "default" | "wide";

const e2eToken =
  process.env.NODE_ENV === "production" ? undefined : process.env.NEXT_PUBLIC_E2E_TEST_TOKEN;
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

function preserveConversationTitle(
  updated: ConversationProfile,
  existing: ConversationProfile | undefined,
): ConversationProfile {
  return existing && updated.title === "New conversation" && existing.title !== "New conversation"
    ? { ...updated, title: existing.title }
    : updated;
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

function TextArtifactPreview({
  artifact,
  compact = false,
}: {
  artifact: AgentArtifact;
  compact?: boolean;
}) {
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
    return <div className={compact ? "px-4 py-5 text-sm text-muted-foreground" : "px-4 py-8 text-center text-sm text-muted-foreground"}>Preview unavailable</div>;
  }
  if (content === undefined) {
    return <div className={compact ? "shimmer px-4 py-5 text-sm text-muted-foreground" : "shimmer px-4 py-8 text-center text-sm text-muted-foreground"}>Loading preview</div>;
  }
  return (
    <pre className={compact
      ? "artifact-text-fade max-h-20 overflow-hidden whitespace-pre-wrap px-4 py-3 text-left text-xs leading-5 text-muted-foreground"
      : "h-full overflow-auto bg-background p-5 text-xs leading-5 sm:p-8 sm:text-sm sm:leading-6"}>
      <code>{content}</code>
    </pre>
  );
}

function ArtifactPreview({ artifact }: { artifact: AgentArtifact }) {
  const [open, setOpen] = useState(false);
  const source = `/api/artifacts/${encodeURIComponent(artifact.id)}`;
  const Icon = artifact.kind === "image" ? ImageIcon : artifact.kind === "pdf" ? FileTextIcon : FileCode2Icon;
  const typeLabel = artifact.kind === "image" ? "Image" : artifact.kind === "pdf" ? "PDF" : "Text";
  return (
    <>
      <figure className="group overflow-hidden rounded-2xl border bg-card shadow-sm transition-colors hover:border-foreground/20">
        <figcaption className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{artifact.title}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{typeLabel} · {artifactSize(artifact.size)}</span>
          </span>
          <Button aria-label={`Open ${artifact.title} in a new tab`} asChild size="icon-sm" variant="ghost">
            <a href={source} rel="noopener noreferrer" target="_blank">
              <ExternalLinkIcon />
            </a>
          </Button>
          <Button onClick={() => setOpen(true)} size="sm" type="button" variant="secondary">
            <Maximize2Icon />
            View
          </Button>
        </figcaption>
        <div className="relative h-20 w-full overflow-hidden border-t bg-muted/20 transition-colors hover:bg-muted/35">
          <button
            aria-label={`View ${artifact.title}`}
            className="absolute inset-0 z-10 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/30"
            onClick={() => setOpen(true)}
            type="button"
          />
          {artifact.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="" className="h-full w-full object-cover object-top opacity-80 transition-opacity group-hover:opacity-100" loading="lazy" src={source} />
          ) : artifact.kind === "pdf" ? (
            <iframe
              aria-hidden="true"
              className="pointer-events-none h-48 w-full -translate-y-9 bg-white opacity-75"
              src={`${source}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
              tabIndex={-1}
              title=""
            />
          ) : (
            <TextArtifactPreview artifact={artifact} compact />
          )}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent" />
        </div>
      </figure>

      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          aria-describedby={undefined}
          className="h-[calc(100dvh-1rem)] max-h-none w-[calc(100vw-1rem)] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none"
          showCloseButton={false}
        >
          <DialogHeader className="flex-row items-center gap-3 border-b px-4 py-3 pr-3 sm:px-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <DialogTitle className="truncate">{artifact.title}</DialogTitle>
              <DialogDescription className="mt-1 text-xs">{typeLabel} · {artifactSize(artifact.size)}</DialogDescription>
            </span>
            <Button aria-label={`Open ${artifact.title} in a new tab`} asChild size="sm" variant="outline">
              <a href={source} rel="noopener noreferrer" target="_blank">
                <ExternalLinkIcon />
                <span className="hidden sm:inline">Open in new tab</span>
              </a>
            </Button>
            <DialogClose asChild>
              <Button aria-label="Close artifact viewer" size="icon-sm" type="button" variant="ghost">
                <span aria-hidden="true" className="text-lg leading-none">×</span>
              </Button>
            </DialogClose>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden bg-muted/30">
            {artifact.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={artifact.title} className="h-full w-full object-contain" src={source} />
            ) : artifact.kind === "pdf" ? (
              <iframe className="h-full w-full bg-white" src={source} title={artifact.title} />
            ) : (
              <TextArtifactPreview artifact={artifact} />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
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

function activityStateLabel(state: ConversationMessageActivity["state"]): string {
  return state === "completed"
    ? "Delivered"
    : state === "failed"
      ? "Failed"
      : state === "running"
        ? "Working"
        : state === "claimed"
          ? "Received"
          : "Queued";
}

function ConversationActivityLog({
  messages,
}: {
  messages: readonly ConversationMessageActivity[];
}) {
  return (
    <div className="scrollbar-thin min-h-0 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-3 px-4 py-6 sm:px-6 sm:py-8">
        {messages.length === 0 ? (
          <div className="flex min-h-[50dvh] flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-card">
              <MessagesSquareIcon className="size-5 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold">No activity yet</h2>
            <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
              Human and agent messages for this conversation appear here.
            </p>
          </div>
        ) : messages.map((message) => (
          <article className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5" key={message.id}>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm">{message.senderName}</strong>
              {message.purpose === "receipt" ? (
                <span className="text-xs text-muted-foreground">Processing note · not sent</span>
              ) : <><ArrowRightIcon className="size-3.5 text-muted-foreground" /><strong className="text-sm">{message.recipientName}</strong></>}
              <Badge className="ml-auto" variant={message.state === "failed" ? "destructive" : message.state === "queued" ? "secondary" : "outline"}>
                {message.purpose === "receipt" ? "Recorded" : activityStateLabel(message.state)}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {new Date(message.createdAt).toLocaleString()}
            </p>
            {message.summary ? <p className="mt-3 text-xs font-medium text-muted-foreground">{message.summary}</p> : null}
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{message.content}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 font-mono text-[10px] text-muted-foreground">
              <span title={message.id}>message {message.id.slice(0, 8)}</span>
              {message.inReplyTo ? <span title={message.inReplyTo}>reply to {message.inReplyTo.slice(0, 8)}</span> : null}
              {message.artifactCount > 0 ? <span>{message.artifactCount} attachment{message.artifactCount === 1 ? "" : "s"}</span> : null}
            </div>
          </article>
        ))}
      </div>
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
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [pollingPaused, setPollingPaused] = useState(false);
  const [monitoringSession, setMonitoringSession] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [savedMessages, setSavedMessages] = useState<AgentMessage[]>([]);
  const [activity, setActivity] = useState<ConversationMessageActivity[]>([]);
  const [conversationTab, setConversationTab] = useState<"chat" | "activity">("chat");
  const refreshMessages = useCallback(async (recover = false) => {
    const suffix = recover ? "?recover=1" : "";
    const response = await fetch(`/api/conversations/${conversation.id}${suffix}`, { cache: "no-store" });
    if (!response.ok) return false;
    const body = (await response.json()) as {
      conversation: ConversationProfile;
      messages: AgentMessage[];
      activity: ConversationMessageActivity[];
    };
    setSavedMessages(body.messages);
    setActivity(body.activity);
    onConversationUpdate(body.conversation);
    return true;
  }, [conversation.id, onConversationUpdate]);
  useEffect(() => {
    let ignore = false;
    void fetch(`/api/conversations/${conversation.id}?recover=1`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: {
        conversation: ConversationProfile;
        messages: AgentMessage[];
        activity: ConversationMessageActivity[];
      } | undefined) => {
        if (!ignore && body) {
          setSavedMessages(body.messages);
          setActivity(body.activity);
          onConversationUpdate(body.conversation);
        }
      });
    return () => {
      ignore = true;
    };
  }, [conversation.id, onConversationUpdate]);
  const entries = useMemo<TranscriptEntry[]>(
    () => savedMessages.map(({ id, role, text, artifacts, failed }) => ({
      id, role, text, artifacts, failed,
    })),
    [savedMessages],
  );
  const working = submitting || conversation.status === "working";
  const lastRequest = [...savedMessages].reverse().find((entry) => entry.role === "user");

  const lastRecoveryCheck = useRef(0);
  useEffect(() => { lastRecoveryCheck.current = Date.now(); }, []);
  const wasWorking = useRef(working);
  useForegroundPolling(working, 5_000, async () => {
    const recover = Date.now() - lastRecoveryCheck.current >= 60_000;
    if (recover) lastRecoveryCheck.current = Date.now();
    await refreshMessages(recover);
  }, () => setPollingPaused(true), monitoringSession);
  useEffect(() => {
    if (wasWorking.current && !working) {
      void refreshConversations();
      void refreshRoster();
    }
    wasWorking.current = working;
  }, [working, refreshConversations, refreshRoster]);

  async function dispatchMessage(message: string, existingMessageId?: string) {
    setPollingPaused(false);
    setMonitoringSession((session) => session + 1);
    const messageId = existingMessageId ?? crypto.randomUUID();
    setSavedMessages((current) => current.some((entry) => entry.requestId === messageId)
      ? current
      : [
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
    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: messageId, content: message }),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      await refreshMessages();
    } finally {
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || submitting) return;
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
      await dispatchMessage(
        lastRequest.text,
        lastRequest.failed ? undefined : lastRequest.requestId,
      );
      refreshConversations();
      refreshRoster();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to retry request");
    } finally {
      setRetrying(false);
    }
  }

  async function refreshConversation() {
    if (refreshing) return;
    setRefreshing(true);
    setLocalError(undefined);
    try {
      const refreshed = await refreshMessages(true);
      refreshConversations();
      refreshRoster();
      if (!refreshed) setLocalError("Unable to refresh this conversation");
      else {
        setPollingPaused(false);
        setMonitoringSession((session) => session + 1);
      }
    } finally {
      setRefreshing(false);
    }
  }

  async function stopConversation() {
    if (!working || stopping) return;
    setStopping(true);
    setLocalError(undefined);
    try {
      const response = await fetch(
        `/api/conversations/${encodeURIComponent(conversation.id)}/stop`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await readError(response));
      const body = (await response.json()) as { conversation: ConversationProfile };
      onConversationUpdate(body.conversation);
      await refreshMessages();
      refreshConversations();
      refreshRoster();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to stop conversation");
    } finally {
      setStopping(false);
    }
  }

  const activityLabel = submitting ? "Queuing message" : "Working in the sandbox";

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
          <Button onClick={() => setConversationTab("chat")} size="sm" type="button" variant={conversationTab === "chat" ? "secondary" : "ghost"}>
            Chat
          </Button>
          <Button onClick={() => setConversationTab("activity")} size="sm" type="button" variant={conversationTab === "activity" ? "secondary" : "ghost"}>
            <MessagesSquareIcon /> Activity
          </Button>
          <Button
            aria-label="Stop conversation"
            disabled={!working || stopping}
            onClick={stopConversation}
            size="icon-sm"
            title="Stop conversation"
            type="button"
            variant="ghost"
          >
            {stopping ? <LoaderCircleIcon className="animate-spin" /> : <SquareIcon />}
          </Button>
          <Button
            aria-label="Refresh conversation"
            disabled={refreshing}
            onClick={refreshConversation}
            size="icon-sm"
            title="Refresh conversation"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          </Button>
          <Badge className="hidden max-w-52 truncate font-mono font-normal lg:inline-flex" title={agent.fxConfig.model} variant="outline">
            {agent.fxConfig.model}
          </Badge>
        </div>
      </header>

      {conversationTab === "activity" ? (
        <ConversationActivityLog messages={activity} />
      ) : (
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
      )}

      <div className="border-t bg-background/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-md sm:px-6">
        <div className="mx-auto w-full max-w-[var(--chat-content-width)]">
          {pollingPaused && working ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-muted px-3 py-2 text-xs text-muted-foreground" role="status">
              <span>Automatic updates paused after 15 minutes. Your agents can keep working.</span>
              <Button disabled={refreshing} onClick={refreshConversation} size="xs" type="button" variant="outline">Resume updates</Button>
            </div>
          ) : null}
          {localError ? (
            <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <span>{localError}</span>
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
              <Button aria-label="Send message" className="ml-auto rounded-xl" disabled={!draft.trim() || submitting} size="icon-sm" type="submit">
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
  defaultModel,
  agent,
  close,
  saved,
}: {
  defaultModel: string;
  agent?: AgentProfile;
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [specialty, setSpecialty] = useState(agent?.specialty ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [model, setModel] = useState(agent?.fxConfig.model ?? defaultModel);
  const [networkAccess, setNetworkAccess] = useState<FxNetworkAccess>(agent?.fxConfig.networkAccess ?? "full");
  const [networkAllowlist, setNetworkAllowlist] = useState(
    (agent?.fxConfig.networkAllowlist ?? []).join("\n"),
  );
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
    const parsedNetworkAllowlist = [
      ...new Set(
        networkAllowlist
          .split(/[\n,]/)
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const response = await fetch(agent ? `/api/agents/${agent.id}` : "/api/agents", {
      method: agent ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        specialty,
        instructions,
        model,
        networkAccess,
        networkAllowlist: parsedNetworkAllowlist,
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
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <div className="grid gap-2">
              <Label htmlFor="agent-model">Model</Label>
              <Input id="agent-model" onChange={(event) => setModel(event.target.value)} required value={model} />
            </div>
            <div className="grid gap-2">
              <Label>Network access</Label>
              <Select onValueChange={(value) => setNetworkAccess(value as FxNetworkAccess)} value={networkAccess}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="full">Full access</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="allowlist">Allowlist</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {networkAccess === "allowlist" ? (
            <div className="grid gap-2">
              <Label htmlFor="agent-network-allowlist">Allowed domains</Label>
              <Textarea
                id="agent-network-allowlist"
                onChange={(event) => setNetworkAllowlist(event.target.value)}
                placeholder={"github.com\n*.npmjs.org"}
                rows={3}
                spellCheck={false}
                value={networkAllowlist}
              />
              <p className="text-xs text-muted-foreground">One domain per line. The model connection remains available in every mode.</p>
            </div>
          ) : (
            <p className="-mt-3 text-xs text-muted-foreground">Controls outbound internet access from agent tools. The model connection remains available.</p>
          )}
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
  defaultModel,
  initialAgents,
  initialConversations,
}: {
  defaultModel: string;
  initialAgents: AgentProfile[];
  initialConversations: ConversationProfile[];
}) {
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
  const selectedConversation =
    conversations.find((conversation) => conversation.id === selectedConversationId) ??
    conversations[0];
  const selected =
    agents.find((agent) => agent.id === selectedConversation?.agentId) ?? agents[0];

  function setSidebarOpen(open: boolean) {
    setDesktopSidebarOpen(open);
  }

  function openSidebar() {
    if (window.matchMedia("(max-width: 760px)").matches) setMobileSidebarOpen(true);
    else setSidebarOpen(true);
  }

  function chooseConversation(conversationId: string) {
    setSelectedConversationId(conversationId);
    setMobileSidebarOpen(false);
  }

  const updateConversation = useCallback((updated: ConversationProfile) => {
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === updated.id);
      const next = preserveConversationTitle(updated, existing);
      if (!existing) return [next, ...current];
      const existingActivity = Date.parse(existing.updatedAt);
      const nextActivity = Date.parse(next.updatedAt);
      if (nextActivity < existingActivity) return current;
      if (nextActivity === existingActivity) {
        return current.map((conversation) => conversation.id === next.id ? next : conversation);
      }
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

  const removeConversation = useCallback(async (conversation: ConversationProfile) => {
    if (conversation.status === "working") {
      await fetch(`/api/conversations/${conversation.id}/stop`, { method: "POST" });
    }
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
  }, [agents, conversations, selectedConversationId, startConversation]);

  const removeAgent = useCallback(async (agent: AgentProfile) => {
    await Promise.allSettled(
      conversations
        .filter((conversation) =>
          conversation.agentId === agent.id && conversation.status === "working"
        )
        .map((conversation) =>
          fetch(`/api/conversations/${conversation.id}/stop`, { method: "POST" })
        ),
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
            status: conversation.status === "working" ? "failed" as const : conversation.status,
          }
        : conversation,
    );
    setAgents(remainingAgents);
    setConversations(remainingConversations);
  }, [agents, conversations]);

  const chooseAgent = useCallback(
    async (agentId: string) => {
      const recent = conversations.find((conversation) => conversation.agentId === agentId);
      if (recent) chooseConversation(recent.id);
      else await startConversation(agentId);
    },
    [conversations, startConversation],
  );

  const otherConversationWorking = conversations.some((conversation) =>
    conversation.id !== selectedConversationId && conversation.status === "working"
  );
  useForegroundPolling(otherConversationWorking, 15_000, refreshConversations);

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
      <details className="agent-directory group shrink-0">
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
        key={`${selectedConversation.id}:${selected.id}`}
        onConversationUpdate={updateConversation}
        onOpenSidebar={openSidebar}
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
          defaultModel={defaultModel}
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
  defaultModel: string;
  initialAgents: AgentProfile[];
  initialConversations: ConversationProfile[];
}) {
  return <AgentConsoleContent {...props} />;
}
