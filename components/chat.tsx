"use client";

import { useEffect, useRef, useState } from "react";
import Message from "./message";

const MAX_INPUT_CHARS = 500;

const QUICK_PROMPTS = [
  "How many orders were placed in total",
  "Which city placed all orders",
  "Give me concise analytics of all orders",
];

type LoadingStep = {
  id: string;
  label: string;
  status: "active" | "completed" | "error";
};

type StreamEvent =
  | { type: "step"; id: string; label: string; status: "active" | "completed" | "error" }
  | { type: "step_note"; id: string; label: string }
  | { type: "answer_chunk"; chunk: string }
  | {
      type: "final";
      payload: {
        answer: string;
        table?: Array<Record<string, unknown>>;
        followUps?: string[];
        mode?: string;
        reason?: string;
        context?: Record<string, Array<string | number>> | null;
      };
    }
  | { type: "error"; message: string };

type FinalPayload = Extract<StreamEvent, { type: "final" }>["payload"];

export default function Chat({ selectedChat, onOpenSidebar }: any) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [loadingSteps, setLoadingSteps] = useState<LoadingStep[]>([]);
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [activeContext, setActiveContext] = useState<Record<string, Array<string | number>> | null>(null);

  const [currentChatId, setCurrentChatId] = useState<number | null>(null);
  const [chatTitle, setChatTitle] = useState<string>("New Chat");

  const [sessionId, setSessionId] = useState<string>("");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  };

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let id = localStorage.getItem("session_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("session_id", id);
    }
    setSessionId(id);
  }, []);

  const upsertStep = (step: LoadingStep) => {
    setLoadingSteps((prev) => {
      const index = prev.findIndex((s) => s.id === step.id);
      if (index === -1) return [...prev, step];
      const next = [...prev];
      next[index] = { ...next[index], ...step };
      return next;
    });
  };

  const parseStreamLines = (buffer: string) => {
    const lines = buffer.split("\n");
    const pending = lines.pop() || "";
    const events: StreamEvent[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // ignore malformed chunks
      }
    }

    return { events, pending };
  };

  const resetSessionContext = () => {
    const id = crypto.randomUUID();
    localStorage.setItem("session_id", id);
    setSessionId(id);
    setActiveContext(null);
    setFollowUps([]);
  };

  const removeContextKey = (key: string) => {
    if (!activeContext) return;

    const next = { ...activeContext };
    delete next[key];
    setActiveContext(Object.keys(next).length ? next : null);
  };

  const handleMessageAction = (action: "regenerate" | "explain" | "continue", index: number) => {
    if (action === "regenerate") {
      for (let i = index - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === "user") {
          sendMessage(messages[i].content);
          return;
        }
      }
      return;
    }

    if (action === "explain") {
      sendMessage("Explain the previous answer in simple steps and include any key assumptions.");
      return;
    }

    sendMessage("Continue with deeper detail from the latest result.");
  };

  // ================= LOAD SELECTED CHAT =================
  useEffect(() => {
    if (selectedChat) {
      setMessages(selectedChat.messages);
      setCurrentChatId(selectedChat.id);
      setChatTitle(selectedChat.title || "New Chat");
      setActiveContext(selectedChat.context || null);
    } else {
      setMessages([]);
      setCurrentChatId(null);
      setChatTitle("New Chat");
      setActiveContext(null);
    }
  }, [selectedChat]);

  // ================= SAVE CHAT HISTORY =================
  useEffect(() => {
    if (messages.length === 0) return;

    const saved = localStorage.getItem("chat_history");
    let chats = saved ? JSON.parse(saved) : [];

    let chatId = currentChatId;

    if (!chatId) {
      chatId = Date.now();
      setCurrentChatId(chatId);

      chats.unshift({
        id: chatId,
        title: chatTitle,
        messages,
        context: activeContext,
        updatedAt: Date.now(),
        pinned: false,
      });
    } else {
      chats = chats.map((c: any) =>
        c.id === chatId
          ? { ...c, messages, title: chatTitle, context: activeContext, updatedAt: Date.now() }
          : c
      );
    }

    localStorage.setItem("chat_history", JSON.stringify(chats));
    window.dispatchEvent(new Event("chat_updated"));
  }, [messages, chatTitle, activeContext]);

  // ================= GENERATE TITLE =================
  const generateTitle = async (firstMessage: string) => {
    try {
      const res = await fetch("/api/generate-title", {
        method: "POST",
        body: JSON.stringify({ message: firstMessage }),
      });

      const title = await res.text();
      setChatTitle(title);
    } catch {
      setChatTitle("New Chat");
    }
  };

  // ================= SEND MESSAGE =================
  const sendMessage = async (customInput?: string) => {
    const question = (customInput || input).trim();
    if (!question || !sessionId) return;

    if (messages.length === 0) {
      generateTitle(question);
    }

    const newMessages = [...messages, { role: "user", content: question, timestamp: Date.now() }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setLoadingStage("Understanding question");
    setLoadingSteps([{ id: "queued", label: "Queued request", status: "completed" }]);
    setFollowUps([]);

    try {
      setLoadingStage("Choosing response mode");
      const res = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          question,
          history: messages.slice(-6),
          sessionId,
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        setMessages([
          ...newMessages,
          {
            role: "assistant",
            content: "I could not complete that request. Try broadening filters or rephrasing with explicit order_id/customer details.",
            mode: "SYSTEM",
            reason: errorText || "Server error",
          },
        ]);
        setFollowUps(["Try with date range", "Use specific order_id", "Show high-level summary"]);
        return;
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response stream available.");
      }

      let pending = "";
      let streamingAnswer = "";
      let finalPayload: FinalPayload | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        pending += decoder.decode(value, { stream: true });
        const parsed = parseStreamLines(pending);
        pending = parsed.pending;

        for (const event of parsed.events) {
          if (event.type === "step") {
            setLoadingStage(event.label);
            upsertStep({ id: event.id, label: event.label, status: event.status });
            continue;
          }

          if (event.type === "step_note") {
            setLoadingStage(event.label);
            continue;
          }

          if (event.type === "answer_chunk") {
            streamingAnswer += event.chunk;
            setLoadingStage("Drafting response");
            setMessages([
              ...newMessages,
              {
                role: "assistant",
                content: streamingAnswer,
                mode: "RAG",
                reason: "Generating response",
                timestamp: Date.now(),
              },
            ]);
            continue;
          }

          if (event.type === "final") {
            finalPayload = event.payload;
            continue;
          }

          if (event.type === "error") {
            throw new Error(event.message || "Server error");
          }
        }
      }

      if (pending.trim()) {
        const parsed = parseStreamLines(`${pending}\n`);
        for (const event of parsed.events) {
          if (event.type === "final") {
            finalPayload = event.payload;
          }
        }
      }

      if (!finalPayload) {
        throw new Error("No final response payload received.");
      }

      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: finalPayload.answer,
          table: finalPayload.table,
          mode: finalPayload.mode || "RAG",
          reason: finalPayload.reason || "",
          timestamp: Date.now(),
        },
      ]);

      if (finalPayload.context) {
        setActiveContext(finalPayload.context);
      }

      if (Array.isArray(finalPayload.followUps) && finalPayload.followUps.length > 0) {
        setFollowUps(finalPayload.followUps);
      } else if (Array.isArray(finalPayload.table) && finalPayload.table.length === 0) {
        setFollowUps(["Try broader timeframe", "Remove strict filters", "Use retrieval summary"]);
      } else {
        setFollowUps(["Drill into this result", "Compare with previous period", "Show exceptions"]);
      }

      setLoadingStage("Completed");
      setLoadingSteps((prev) =>
        prev.map((s) => (s.status === "active" ? { ...s, status: "completed" } : s))
      );
    } catch {
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: "Something went wrong while processing your request. Please try again.",
          mode: "SYSTEM",
          reason: "Network or server failure",
        },
      ]);
      setFollowUps(["Retry request", "Ask simpler question", "Use explicit IDs"]);
      setLoadingSteps((prev) => {
        if (prev.length === 0) {
          return [{ id: "error", label: "Request failed", status: "error" }];
        }
        return prev.map((s) => (s.status === "active" ? { ...s, status: "error" } : s));
      });
    } finally {
      setLoading(false);
      setLoadingStage("");
      setLoadingSteps([]);
    }
  };

  // ================= UI =================
  return (
    <div className="flex-1 min-w-0 flex flex-col backdrop-blur-xl relative">
      <div className="flex items-center justify-between border-b border-white/10 bg-black/30 px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={onOpenSidebar}
          className="rounded-lg border border-white/20 px-2 py-1 text-sm"
          aria-label="Open sidebar"
        >
          Menu
        </button>
        <div className="truncate text-sm text-zinc-300">{chatTitle}</div>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-3 sm:p-5 md:p-6 space-y-4 sm:space-y-6"
      >
        {/* ── Welcome screen ── */}
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full min-h-[70vh] gap-8 text-center px-4">
            <div className="space-y-4">
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-4xl font-bold shadow-2xl shadow-indigo-500/40 text-white select-none mx-auto">
                ⚡
              </div>
              <div>
                <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-200 via-purple-200 to-pink-200 bg-clip-text text-transparent mb-3">
                  AI E-Commerce Analytics
                </h1>
                <p className="text-zinc-300 text-base max-w-lg mx-auto leading-relaxed">
                  Intelligent SQL + RAG powered agent for analyzing orders, customer behavior, and trends in real-time.
                </p>
              </div>
            </div>
            
            <div className="space-y-4 w-full max-w-2xl">
              <p className="text-xs uppercase tracking-widest text-zinc-500 font-semibold">Try these questions</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => sendMessage(p)}
                    className="rounded-2xl border border-indigo-400/20 bg-indigo-500/10 hover:bg-indigo-500/20 hover:border-indigo-400/40 p-4 text-sm text-indigo-100 text-left transition-all duration-200 hover:-translate-y-1 hover:shadow-lg hover:shadow-indigo-500/10 group"
                  >
                    <span className="text-indigo-300 group-hover:text-indigo-200 transition">→</span> {p}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 pt-8 border-t border-white/5 w-full max-w-lg">
              <p className="text-xs text-zinc-500">
                Session context automatically persists for 24 hours. All queries are cached and available for follow-ups.
              </p>
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <Message
            key={i}
            content={m.content}
            role={m.role}
            table={m.table}
            mode={m.mode}
            reason={m.reason}
            timestamp={m.timestamp}
            messageId={m.messageId ?? `${currentChatId ?? "new"}-${i}`}
            sessionId={sessionId}
            userMessage={
              m.role === "assistant"
                ? messages.slice(0, i).findLast((x: any) => x.role === "user")?.content ?? ""
                : undefined
            }
            onAction={(action: "regenerate" | "explain" | "continue") => handleMessageAction(action, i)}
          />
        ))}

        {loading && (
          <div className="flex gap-3 items-start px-1 sm:px-2 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-4 shadow-[0_0_35px_rgba(99,102,241,0.15)]">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 flex items-center justify-center text-xs sm:text-sm font-bold flex-shrink-0">
              AI
            </div>

            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs sm:text-sm text-indigo-200 font-semibold">{loadingStage || "Processing..."}</div>
                <div className="flex gap-1.5">
                  <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <div className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
              
              <div className="h-2 w-full overflow-hidden rounded-full bg-white/15">
                <div className="h-full shimmer-bar rounded-full" />
              </div>
              
              {loadingSteps.length > 0 && (
                <div className="mt-2 space-y-1.5 pl-0.5">
                  {loadingSteps.map((step) => (
                    <div key={step.id} className="flex items-center gap-2 text-xs sm:text-sm">
                      <span
                        className={`inline-flex h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                          step.status === "completed"
                            ? "bg-emerald-400"
                            : step.status === "error"
                              ? "bg-red-400"
                              : "bg-amber-300 animate-pulse"
                        }`}
                      />
                      <span className={`${step.status === "completed" ? "text-zinc-300" : "text-indigo-200"}`}>
                        {step.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {followUps.length > 0 && (
          <div className="px-1 sm:px-2 space-y-2">
            <p className="text-xs text-zinc-500 uppercase tracking-widest font-semibold">Suggested follow-ups</p>
            <div className="flex flex-wrap gap-2">
              {followUps.map((f, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(f)}
                  className="text-xs sm:text-sm px-3 py-2 rounded-full bg-gradient-to-r from-indigo-500/20 to-purple-500/20 hover:from-indigo-500/40 hover:to-purple-500/40 transition-all border border-indigo-400/30 hover:border-indigo-400/60 group hover:shadow-md hover:shadow-indigo-500/20 hover:-translate-y-0.5 duration-150"
                >
                  <span className="text-indigo-300 group-hover:text-indigo-200 transition">→</span> {f}
                </button>
              ))}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Scroll-to-bottom FAB ── */}
      {showScrollDown && (
        <button
          onClick={() => scrollToBottom()}
          className="absolute bottom-24 right-4 z-10 rounded-full bg-indigo-500/90 p-2.5 shadow-lg hover:bg-indigo-600 transition-all backdrop-blur-sm border border-white/10 text-white text-sm leading-none"
          aria-label="Scroll to bottom"
        >
          ↓
        </button>
      )}

      <div className="p-3 sm:p-4 border-t border-white/10 bg-black/30 backdrop-blur-xl space-y-3">
        {/* Context Display */}
        {activeContext && Object.keys(activeContext).length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-emerald-300 uppercase tracking-widest">
                Session Context ({Object.keys(activeContext).length})
              </label>
              <button
                type="button"
                onClick={resetSessionContext}
                className="rounded text-xs border border-white/20 px-2 py-1 hover:bg-white/10 transition text-zinc-400 hover:text-zinc-200"
                aria-label="Reset session context"
              >
                Clear All
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(activeContext).map(([key, values]) => (
                <div
                  key={key}
                  className="rounded-full border border-emerald-400/40 bg-emerald-500/15 px-3 py-1.5 text-xs text-emerald-200 group inline-flex items-center gap-2 hover:bg-emerald-500/25 transition shadow-sm shadow-emerald-500/10"
                >
                  <span className="font-semibold">{key}:</span>
                  <span className="max-w-[120px] truncate text-emerald-100">
                    {values.slice(0, 2).join(", ")}
                    {values.length > 2 && ` +${values.length - 2}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeContextKey(key)}
                    className="opacity-0 group-hover:opacity-100 transition text-emerald-300 hover:text-emerald-100 ml-1"
                    aria-label={`Remove ${key} from context`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Input Area */}
        <div className="flex gap-2 items-center bg-white/10 border border-white/10 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500 transition shadow-[0_0_25px_rgba(30,41,59,0.25)]">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_INPUT_CHARS))}
            placeholder="Ask something..."
            className="flex-1 min-w-0 bg-transparent outline-none text-sm sm:text-base text-white placeholder:text-zinc-400"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !loading) sendMessage();
            }}
            aria-label="Ask a question"
          />

          <button
            onClick={() => sendMessage()}
            className="shrink-0 px-3 sm:px-4 py-1.5 rounded-lg bg-gradient-to-r from-indigo-500 to-purple-600 hover:opacity-90 transition text-xs sm:text-sm font-medium disabled:opacity-60"
            disabled={loading || !input.trim()}
            aria-label="Send message"
          >
            Send
          </button>
        </div>

        {/* Footer Info */}
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>
            Session: <span className="text-zinc-300 font-mono text-[11px]">{sessionId ? `${sessionId.slice(0, 8)}…` : "loading"}</span> • 
            <span
              className={`ml-2 font-mono ${
                input.length >= MAX_INPUT_CHARS * 0.95
                  ? "text-red-400 font-medium"
                  : input.length >= MAX_INPUT_CHARS * 0.8
                    ? "text-yellow-400"
                    : "text-zinc-400"
              }`}
              aria-label={`${input.length} of ${MAX_INPUT_CHARS} characters`}
            >
              {input.length}/{MAX_INPUT_CHARS}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}