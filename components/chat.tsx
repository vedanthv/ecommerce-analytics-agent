"use client";

import { useEffect, useState } from "react";
import Message from "./message";

export default function Chat({ selectedChat, onOpenSidebar }: any) {
  const [messages, setMessages] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [followUps, setFollowUps] = useState<string[]>([]);
  const [activeContext, setActiveContext] = useState<Record<string, Array<string | number>> | null>(null);

  const [currentChatId, setCurrentChatId] = useState<number | null>(null);
  const [chatTitle, setChatTitle] = useState<string>("New Chat");

  const [sessionId, setSessionId] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;

    let id = localStorage.getItem("session_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("session_id", id);
    }
    setSessionId(id);
  }, []);

  const parseStreamEnvelope = (raw: string) => {
    const followMarker = "\n__FOLLOWUPS__";
    const metaMarker = "\n__META__";
    const followIdx = raw.indexOf(followMarker);

    if (followIdx === -1) {
      return {
        text: raw,
        followUps: null as string[] | null,
        meta: null as { mode?: string; reason?: string; context?: Record<string, Array<string | number>> | null } | null,
      };
    }

    const text = raw.slice(0, followIdx);
    const rest = raw.slice(followIdx + followMarker.length);
    const metaIdx = rest.indexOf(metaMarker);

    const followRaw = metaIdx === -1 ? rest : rest.slice(0, metaIdx);
    const metaRaw = metaIdx === -1 ? "" : rest.slice(metaIdx + metaMarker.length);

    let parsedFollowUps: string[] | null = null;
    let parsedMeta: { mode?: string; reason?: string; context?: Record<string, Array<string | number>> | null } | null = null;

    try {
      parsedFollowUps = JSON.parse(followRaw);
    } catch {}

    try {
      parsedMeta = JSON.parse(metaRaw);
    } catch {}

    return {
      text,
      followUps: parsedFollowUps,
      meta: parsedMeta,
    };
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
    const question = customInput || input;
    if (!question || !sessionId) return;

    if (messages.length === 0) {
      generateTitle(question);
    }

    const newMessages = [...messages, { role: "user", content: question }];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setLoadingStage("Understanding question");
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

      const contentType = res.headers.get("content-type");

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

      // ================= SQL =================
      if (contentType?.includes("application/json")) {
        setLoadingStage("Running SQL and summarizing");
        const data = await res.json();

        setMessages([
          ...newMessages,
          {
            role: "assistant",
            content: data.answer,
            table: data.table,
            mode: data.mode || "SQL",
            reason: data.reason || "",
          },
        ]);

        if (data.context) {
          setActiveContext(data.context);
        }

        if (Array.isArray(data.followUps) && data.followUps.length > 0) {
          setFollowUps(data.followUps);
        } else if (Array.isArray(data.table) && data.table.length === 0) {
          setFollowUps(["Try broader timeframe", "Remove strict filters", "Use retrieval summary"]);
        } else {
          setFollowUps(["Drill into this result", "Compare with previous period", "Show exceptions"]);
        }
      } else {
        // ================= STREAMING =================
        setLoadingStage("Retrieving context");
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) {
          throw new Error("No response stream available.");
        }

        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          setLoadingStage("Generating response");
          buffer += decoder.decode(value, { stream: true });

          const envelope = parseStreamEnvelope(buffer);

          setMessages((prev) => {
            const base = [...prev.slice(0, newMessages.length)];
            return [
              ...base,
              {
                role: "assistant",
                content: envelope.text,
                mode: envelope.meta?.mode || "RAG",
                reason: envelope.meta?.reason || "Used retrieval context for this response.",
              },
            ];
          });

          if (envelope.followUps) {
            setFollowUps(envelope.followUps);
          }

          if (envelope.meta?.context) {
            setActiveContext(envelope.meta.context);
          }
        }

        const finalEnvelope = parseStreamEnvelope(buffer);
        if (finalEnvelope.followUps && finalEnvelope.followUps.length > 0) {
          setFollowUps(finalEnvelope.followUps);
        } else {
          setFollowUps(["Drill deeper", "Compare alternatives", "List anomalies"]);
        }

        if (finalEnvelope.meta?.context) {
          setActiveContext(finalEnvelope.meta.context);
        }
      }
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
    } finally {
      setLoading(false);
      setLoadingStage("");
    }
  };

  // ================= UI =================
  return (
    <div className="flex-1 min-w-0 flex flex-col backdrop-blur-xl">
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

      <div className="flex-1 overflow-y-auto p-3 sm:p-5 md:p-6 space-y-4 sm:space-y-6">
        {messages.map((m, i) => (
          <Message
            key={i}
            content={m.content}
            role={m.role}
            table={m.table}
            mode={m.mode}
            reason={m.reason}
            onAction={(action: "regenerate" | "explain" | "continue") => handleMessageAction(action, i)}
          />
        ))}

        {loading && (
          <div className="flex gap-3 items-center px-1 sm:px-2 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 flex items-center justify-center text-xs sm:text-sm font-bold">
              AI
            </div>

            <div className="flex-1">
              <div className="text-xs sm:text-sm text-zinc-300 mb-2">{loadingStage || "Working"}</div>
              <div className="h-2 w-full overflow-hidden rounded bg-white/10">
                <div className="h-full w-1/3 animate-pulse rounded bg-indigo-400/80" />
              </div>
            </div>

            <div className="flex gap-2">
              <div className="w-2 h-2 bg-white rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-white rounded-full animate-bounce delay-150" />
              <div className="w-2 h-2 bg-white rounded-full animate-bounce delay-300" />
            </div>
          </div>
        )}

        {followUps.length > 0 && (
          <div className="px-1 sm:px-2 flex flex-wrap gap-2">
            {followUps.map((f, i) => (
              <button
                key={i}
                onClick={() => sendMessage(f)}
                className="text-xs sm:text-sm px-2.5 py-1 rounded-full bg-indigo-500/20 hover:bg-indigo-500/40 transition border border-indigo-500/30"
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 sm:p-4 border-t border-white/10 bg-black/30 backdrop-blur-xl">
        {activeContext && Object.keys(activeContext).length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(activeContext).map(([key, values]) => (
              <button
                key={key}
                type="button"
                onClick={() => removeContextKey(key)}
                className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
                title="Remove context chip"
              >
                {key}: {values.slice(0, 2).join(", ")}
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-2 items-center bg-white/10 border border-white/10 rounded-xl px-3 py-2 focus-within:ring-2 focus-within:ring-indigo-500 transition">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
          >
            Send
          </button>
        </div>

        <div className="mt-2 flex items-center justify-between text-xs text-zinc-400">
          <span>Session: {sessionId ? `${sessionId.slice(0, 8)}...` : "loading"}</span>
          <button
            type="button"
            onClick={resetSessionContext}
            className="rounded border border-white/20 px-2 py-1 hover:bg-white/10"
          >
            Reset Context
          </button>
        </div>
      </div>
    </div>
  );
}