"use client";

import Chat from "@/components/chat";
import Sidebar from "@/components/sidebar";
import { useState } from "react";

export default function Page() {
  const [selectedChat, setSelectedChat] = useState<any>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="relative flex h-[100dvh] overflow-hidden bg-gradient-to-br from-zinc-950 via-black to-zinc-900 text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="ambient-orb ambient-pulse absolute -top-20 left-8 h-56 w-56 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="ambient-orb-delay ambient-pulse absolute -bottom-24 right-8 h-72 w-72 rounded-full bg-indigo-500/20 blur-3xl" />
      </div>

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        activeChatId={selectedChat?.id}
        onSelectChat={(chat: any) => {
          setSelectedChat(chat);
          setSidebarOpen(false);
        }}
      />

      <Chat
        selectedChat={selectedChat}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
    </div>
  );
}
