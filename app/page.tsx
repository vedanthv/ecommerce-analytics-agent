"use client";

import Chat from "@/components/chat";
import Sidebar from "@/components/sidebar";
import { useState } from "react";

export default function Page() {
  const [selectedChat, setSelectedChat] = useState<any>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="relative flex h-[100dvh] overflow-hidden bg-gradient-to-br from-zinc-950 via-black to-zinc-900 text-white">
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
