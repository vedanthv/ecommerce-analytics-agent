"use client";

import { useEffect, useState } from "react";

export default function Sidebar({ onSelectChat, open, onClose, activeChatId }: any) {
  const [chats, setChats] = useState<any[]>([]);
  const [search, setSearch] = useState("");

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
      <div className="mb-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats"
          className="w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Search chats"
        />
      </div>

      <div className="space-y-2 mb-4 pt-12 md:pt-0">
        <button
          onClick={newChat}
          className="w-full bg-gradient-to-r from-indigo-500 to-purple-600 py-2 rounded-xl text-sm sm:text-base font-medium hover:opacity-90 transition"
        >
          + New Chat
        </button>

        <button
          onClick={clearHistory}
          className="w-full bg-red-500/20 border border-red-500/30 text-red-300 py-2 rounded-xl text-sm sm:text-base hover:bg-red-500/30 transition"
        >
          Clear History
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {filtered.length === 0 && (
          <div className="text-sm text-zinc-400 text-center mt-10">
            No matching chats
          </div>
        )}

        {filtered.map((chat, i) => (
          <div
            key={i}
            onClick={() => handleSelect(chat)}
            className={`p-3 rounded-xl cursor-pointer transition text-sm sm:text-base border ${
              activeChatId === chat.id
                ? "bg-white/15 border-indigo-400/40"
                : "border-transparent hover:bg-white/10"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="truncate">{chat.title || "Untitled Chat"}</div>
              <button
                type="button"
                className="rounded px-1 text-xs text-zinc-300 hover:bg-white/10"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(chat.id);
                }}
                aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
              >
                {chat.pinned ? "Pinned" : "Pin"}
              </button>
            </div>
            <div className="mt-1 text-[11px] text-zinc-400">{formatTime(chat.updatedAt)}</div>
          </div>
        ))}
      </div>
      </aside>
    </>
  );
}