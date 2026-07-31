import * as React from "react";
import {
  ArrowUpIcon,
  BotIcon,
  MessageCircleDashedIcon,
  RotateCwIcon,
  UserIcon,
} from "lucide-react";
import { Button } from "./components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
} from "./components/ui/message-scroller";
import {
  Message,
  MessageAvatar,
  MessageContent,
} from "./components/ui/message";
import { Bubble } from "./components/ui/bubble";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/ui/empty";
import { InputGroup, InputGroupButton } from "./components/ui/input-group";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";

const BASE_URL = window.location.origin;
const MAX_ATTEMPTS = 240;
const POLL_INTERVAL = 1000;

function ChatMessage({ message }) {
  const isUser = message.role === "user";
  return (
    <Message align={isUser ? "end" : "start"}>
      {!isUser && (
        <MessageAvatar>
          <BotIcon />
        </MessageAvatar>
      )}
      <MessageContent>
        <Bubble
          variant={isUser ? "default" : "outline"}
          align={isUser ? "end" : "start"}
        >
          {message.text}
        </Bubble>
      </MessageContent>
      {isUser && (
        <MessageAvatar>
          <UserIcon />
        </MessageAvatar>
      )}
    </Message>
  );
}

function LoadingIndicator() {
  return (
    <Message align="start">
      <MessageAvatar>
        <BotIcon />
      </MessageAvatar>
      <MessageContent>
        <Bubble variant="outline" align="start">
          <span className="shimmer">Generating response…</span>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export default function App() {
  const [messages, setMessages] = React.useState([]);
  const [input, setInput] = React.useState("");
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [statusText, setStatusText] = React.useState("");

  const loadHistory = React.useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/web-chat/history`);
      const data = await res.json();
      const history = Array.isArray(data.history) ? data.history : [];
      setMessages(
        history
          .map((msg) => ({
            role: msg.role,
            text:
              (msg.parts && msg.parts[0] && msg.parts[0].text) || "",
          }))
          .filter((m) => m.text)
      );
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const resetChat = React.useCallback(async () => {
    setIsProcessing(true);
    try {
      await fetch(`${BASE_URL}/api/web-chat/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
    setIsProcessing(false);
    setMessages([]);
  }, []);

  const pollResult = React.useCallback(async () => {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      const res = await fetch(`${BASE_URL}/api/web-chat/result`);
      if (!res.ok) {
        throw new Error(`Result fetch failed: ${res.status}`);
      }
      const data = await res.json();
      if (data.status === "ready") {
        return data;
      }
      if (data.status === "error" || data.error) {
        return { finalText: null, error: data.error || "Unknown error" };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      attempts++;
    }
    throw new Error(`Timeout after ${attempts}s`);
  }, []);

  const sendMessage = React.useCallback(
    async (event) => {
      event.preventDefault();
      const message = input.trim();
      if (!message || isProcessing) return;

      setMessages((prev) => [
        ...prev,
        { role: "user", text: message },
        { role: "assistant", text: "", loading: true },
      ]);
      setInput("");
      setIsProcessing(true);
      setStatusText("Processing…");

      try {
        const sendRes = await fetch(`${BASE_URL}/api/web-chat/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });

        if (!sendRes.ok) {
          const errData = await sendRes.json().catch(() => ({}));
          throw new Error(errData.error || "Failed to send message");
        }

        setStatusText("Generating response…");
        const result = await pollResult();

        setMessages((prev) => {
          const next = [...prev];
          const loadingIdx = next.findIndex(
            (m) => m.role === "assistant" && m.loading
          );
          const finalText =
            result.finalText ||
            (result.error ? `Error: ${result.error}` : "No response received");
          if (loadingIdx !== -1) {
            next[loadingIdx] = { role: "assistant", text: finalText };
          } else {
            next.push({ role: "assistant", text: finalText });
          }
          return next;
        });
      } catch (err) {
        setMessages((prev) => {
          const next = [...prev];
          const loadingIdx = next.findIndex(
            (m) => m.role === "assistant" && m.loading
          );
          if (loadingIdx !== -1) {
            next[loadingIdx] = {
              role: "assistant",
              text: `Error: ${err.message}`,
            };
          }
          return next;
        });
      } finally {
        setIsProcessing(false);
        setStatusText("");
      }
    },
    [input, isProcessing, pollResult]
  );

  const hasMessages = messages.length > 0;
  const showLoadingMessage =
    messages.some((m) => m.loading) || isLoading;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 p-4 dark:from-slate-900 dark:to-slate-950">
      <Card className="h-[85vh] w-full max-w-2xl gap-0 overflow-hidden">
        <CardHeader className="gap-1 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <BotIcon className="size-5" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-base">Cocoa</CardTitle>
              <CardDescription className="flex items-center gap-1.5 text-xs">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                AI Assistant
              </CardDescription>
            </div>
            <CardAction>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Reset conversation"
                onClick={resetChat}
                disabled={isProcessing}
              >
                <RotateCwIcon />
              </Button>
            </CardAction>
          </div>
        </CardHeader>

        <CardContent className="relative flex-1 overflow-hidden p-0">
          {!hasMessages && !showLoadingMessage ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageCircleDashedIcon />
                </EmptyMedia>
                <EmptyTitle>Halo, saya Cocoa!</EmptyTitle>
                <EmptyDescription>
                  Asisten coding dan analisis kamu. Tanya apa saja tentang
                  kode, repo GitHub, atau tugas teknis lainnya.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <MessageScroller>
              <MessageScrollerViewport>
                <MessageScrollerContent className="gap-4 p-4">
                  {messages
                    .filter((m) => !m.loading)
                    .map((m, i) => (
                      <ChatMessage key={i} message={m} />
                    ))}
                  {showLoadingMessage && <LoadingIndicator />}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          )}
        </CardContent>

        <CardFooter className="flex-col gap-1.5 border-t px-3 py-3">
          {statusText && (
            <div
              className={cn(
                "flex w-full items-center justify-center gap-2 text-xs text-muted-foreground"
              )}
            >
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
              {statusText}
            </div>
          )}
          <form onSubmit={sendMessage} className="w-full">
            <InputGroup>
              <Input
                id="message-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your message…"
                className="h-10 border-0 bg-transparent shadow-none focus-visible:ring-0"
                disabled={isProcessing}
                autoFocus
              />
              <InputGroupButton className="pl-0.5">
                <Button
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  aria-label="Send message"
                  disabled={!input.trim() || isProcessing}
                  className="rounded-xl"
                >
                  <ArrowUpIcon />
                  <span className="sr-only">Send</span>
                </Button>
              </InputGroupButton>
            </InputGroup>
          </form>
        </CardFooter>
      </Card>
    </div>
  );
}
