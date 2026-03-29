"use client";

import { useEffect, useState } from "react";

export default function Sidebar({ onSelectChat, open, onClose, activeChatId }: any) {
  const [chats, setChats] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const readChats = () => {
    const saved = localStorage.getItem("chat_history");
    if (!saved) return [];

    const parsed = JSON.parse(saved);
    return parsed.map((c: any) => ({
      ...c,
      pinned: Boolean(c.pinned),
      updatedAt: c.updatedAt || 0,
    }));
  };

  const writeChats = (next: any[]) => {
    localStorage.setItem("chat_history", JSON.stringify(next));
    setChats(next);
    window.dispatchEvent(new Event("chat_updated"));
  };

  useEffect(() => {
    const load = () => {
      setChats(readChats());
    };

    load();

    window.addEventListener("storage", load);
    window.addEventListener("chat_updated", load);

    return () => {
      window.removeEventListener("storage", load);
      window.removeEventListener("chat_updated", load);
    };
  }, []);

  const handleSelect = (chat: any) => {
    onSelectChat(chat);
    onClose?.();
  };

  const newChat = () => {
    onSelectChat(null);
    onClose?.();
    window.dispatchEvent(new Event("chat_updated"));
  };

  const clearHistory = () => {
    const confirmClear = confirm("Are you sure you want to clear all chats?");
    if (!confirmClear) return;

    localStorage.removeItem("chat_history");
    setChats([]);
    onSelectChat(null);
    onClose?.();

    window.dispatchEvent(new Event("chat_updated")); 
  };

  const togglePin = (chatId: number) => {
    const next = readChats().map((chat: any) =>
      chat.id === chatId ? { ...chat, pinned: !chat.pinned, updatedAt: Date.now() } : chat
    );
    writeChats(next);
  };

  const deleteChat = (chatId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = readChats().filter((c: any) => c.id !== chatId);
    writeChats(next);
    if (activeChatId === chatId) {
      onSelectChat(null);
    }
  };

  const startRename = (chat: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(chat.id);
    setRenameValue(chat.title || "Untitled Chat");
  };

  const commitRename = () => {
    if (!renamingId) return;
    const next = readChats().map((c: any) =>
      c.id === renamingId ? { ...c, title: renameValue.trim() || "Untitled Chat" } : c
    );
    writeChats(next);
    setRenamingId(null);
  };

  const filtered = chats
    .filter((chat) => (chat.title || "Untitled Chat").toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

  const formatTime = (ts: number) => {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  return (
    <>
      {open && (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={onClose}
          aria-label="Close sidebar"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[82vw] max-w-80 border-r border-white/10 bg-black/70 p-4 backdrop-blur-xl transition-transform md:static md:z-0 md:w-72 md:max-w-none md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
      <div className="mb-4 flex flex-col gap-3">
        <h2 className="text-base font-bold text-white">Chat History</h2>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats…"
          className="w-full rounded-lg border border-white/15 bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 transition text-white placeholder:text-zinc-400"
          aria-label="Search chats"
        />
      </div>

      <div className="space-y-2 mb-4 pt-8 md:pt-0">
        <button
          onClick={newChat}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 py-2.5 rounded-lg text-sm font-semibold hover:shadow-lg hover:shadow-indigo-500/20 transition hover:-translate-y-0.5 duration-150"
          aria-label="Start new chat"
        >
          ➕ New Chat
        </button>

        <button
          onClick={clearHistory}
          className="w-full bg-red-500/15 border border-red-500/40 text-red-300 py-2 rounded-lg text-sm font-medium hover:bg-red-500/25 transition hover:border-red-500/60"
          aria-label="Clear all chats"
        >
          🗑️ Clear History
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1">
        {filtered.length === 0 && (
          <div className="text-sm text-zinc-400 text-center mt-10">
            No matching chats
          </div>
        )}

        {filtered.map((chat, i) => {
          const showPinnedHeader = i === 0 && chat.pinned;
          const showRecentDivider = i > 0 && !chat.pinned && filtered[i - 1]?.pinned;
          return (
            <div key={chat.id ?? i}>
              {showPinnedHeader && (
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 px-2 mb-1 mt-1">
                  Pinned
                </div>
              )}
              {showRecentDivider && (
                <div className="flex items-center gap-2 my-2 px-1">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">Recent</span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
              )}
              <div
                onClick={() => handleSelect(chat)}
                className={`p-3 rounded-lg cursor-pointer transition duration-150 text-sm border group ${
                  activeChatId === chat.id
                    ? "bg-indigo-500/20 border-indigo-400/40 shadow-md shadow-indigo-500/10"
                    : "border-white/10 hover:bg-white/10 hover:border-white/20"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  {renamingId === chat.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 min-w-0 bg-white/10 border-b border-indigo-400 outline-none text-sm text-white px-2 py-1 rounded"
                    />
                  ) : (
                    <div
                      className="truncate font-medium text-white group-hover:text-indigo-200 transition"
                      onDoubleClick={(e) => startRename(chat, e)}
                      title="Double-click to rename"
                    >
                      {chat.title || "Untitled Chat"}
                    </div>
                  )}

                  <div className="flex items-center gap-1 shrink-0 opacity-70 hover:opacity-100 transition">
                    <button
                      type="button"
                      className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-zinc-200 transition"
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(chat.id);
                      }}
                      aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
                    >
                      {chat.pinned ? "📌" : "📍"}
                    </button>
                    <button
                      type="button"
                      className="rounded px-1.5 py-1 text-xs text-zinc-500 hover:text-red-300 hover:bg-red-500/15 transition"
                      onClick={(e) => deleteChat(chat.id, e)}
                      aria-label="Delete chat"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500">{formatTime(chat.updatedAt)}</div>
              </div>
            </div>
          );
        })}
      </div>
      </aside>
    </>
  );
}