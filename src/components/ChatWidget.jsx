"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../context/SocketProvider";
import FrameAvatar from "./FrameAvatar";
import {
  subscribeToBigWins,
  subscribeToChatMessages,
} from "../lib/realtime";
import { upsertChatMessage } from "../lib/chatMessageList";
import { IconCoin, IconConfetti, IconFlame, IconX } from "@tabler/icons-react";

const MINIMUM_BIG_WIN = 1000000; // 1 million tokens maximum

const GLOBAL_ROUTES = new Set(["/", "/casino", "/games", "/classement", "/rankings"]);

function formatParts(text) {
  const tokens = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push({ type: "bold", value: token.slice(2, -2) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push({ type: "italic", value: token.slice(1, -1) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push({ type: "code", value: token.slice(1, -1) });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }

  return tokens;
}

function MessageText({ content }) {
  const lines = content.split("\n");

  return (
    <>
      {lines.map((line, idx) => (
        <span key={`${line}-${idx}`}>
          {formatParts(line).map((part, pIdx) => {
            if (part.type === "bold")
              return <strong key={pIdx}>{part.value}</strong>;
            if (part.type === "italic") return <em key={pIdx}>{part.value}</em>;
            if (part.type === "code")
              return (
                <code key={pIdx} className="rounded bg-slate-700 px-1">
                  {part.value}
                </code>
              );
            return <span key={pIdx}>{part.value}</span>;
          })}
          {idx < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

function formatNumber(num) {
  if (num >= 1000000000) {
    return (num / 1000000000).toFixed(1) + "B";
  }
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + "M";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + "K";
  }
  return num.toLocaleString();
}

export default function ChatWidget() {
  const pathname = usePathname();
  const { user, isSignedIn } = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const [bigWins, setBigWins] = useState([]);
  const [isLoadingBigWins, setIsLoadingBigWins] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Fetch admin status from DB-backed API on mount
  // Uses sessionStorage to cache across page navigations within a session
  useEffect(() => {
    if (!user?.id) return;

    const cacheKey = `admin:${user.id}`;

    // Check sessionStorage cache first
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached !== null) {
        setIsAdmin(cached === "true");
        return;
      }
    } catch {
      // sessionStorage unavailable (e.g. SSR)
    }

    fetch("/api/user/is-admin")
      .then((res) => res.json())
      .then((data) => {
        const isAdminVal = data.isAdmin === true;
        setIsAdmin(isAdminVal);
        try {
          sessionStorage.setItem(cacheKey, String(isAdminVal));
        } catch {
          // ignore
        }
      })
      .catch(() => setIsAdmin(false));
  }, [user?.id]);

  const { socket } = useSocket();
  const messagesContainerRef = useRef(null);

  const room = useMemo(() => {
    if (!pathname) return null;

    if (GLOBAL_ROUTES.has(pathname)) {
      return { roomType: "global", roomId: "main-lobby", title: "Global chat" };
    }

    if (pathname.startsWith("/casino/") || pathname.startsWith("/games/")) {
      return {
        roomType: "game",
        roomId: pathname,
        title: `Game chat: ${pathname
          .replace(/^\/(casino|games)\//, "")
          .replaceAll("/", " › ")}`,
      };
    }

    return null;
  }, [pathname]);

  async function loadMessages() {
    if (!room) return;
    const params = new URLSearchParams({
      roomType: room.roomType,
      roomId: room.roomId,
      limit: "75",
    });
    const res = await fetch(`/api/chat/messages?${params.toString()}`, {
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error("Unable to load chat messages.");
    }

    const data = await res.json();
    setMessages(data.messages || []);
  }

  useEffect(() => {
    if (!room || !isOpen) return;

    const refresh = async () => {
      try {
        await loadMessages();
      } catch (err) {
        setError(err.message || "Failed to refresh chat.");
      }
    };

    refresh();
  }, [room?.roomType, room?.roomId, isOpen]);

  // Socket.IO fast path: senders broadcast their own POST response (the full
  // enriched row) via room_event, so listeners append it in place instead of
  // re-fetching the whole history. Events without a message payload (legacy
  // tabs still on the old protocol) fall back to a full reload.
  useEffect(() => {
    if (!socket || !room || !isOpen) return;
    const roomKey = `chat:${room.roomType}:${room.roomId}`;
    const handleChatUpdate = (payload) => {
      if (payload?.message?.id != null) {
        setMessages((prev) => upsertChatMessage(prev, payload.message));
        return;
      }
      loadMessages().catch(() => {});
    };

    socket.emit("join_room", { roomId: roomKey });
    socket.on("chat:updated", handleChatUpdate);

    return () => {
      socket.emit("leave_room", { roomId: roomKey });
      socket.off("chat:updated", handleChatUpdate);
    };
  }, [socket, room?.roomType, room?.roomId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isOpen]);

  async function loadBigWins() {
    if (!isOpen) return;
    setIsLoadingBigWins(true);
    try {
      const res = await fetch("/api/chat/big-wins", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Unable to load top wins.");
      const data = await res.json();
      setBigWins(data.wins || []);
    } catch (err) {
      setError(err.message || "Failed to load top wins.");
    } finally {
      setIsLoadingBigWins(false);
    }
  }

  useEffect(() => {
    if (activeTab === "bigwins" && isOpen) {
      loadBigWins();
    }
  }, [activeTab, isOpen]);

  // Supabase Realtime: live-append new big wins as the backend inserts them
  // into big_wins — no polling. The DB write itself is the event. This runs
  // whenever the Big Wins tab is open, so the feed updates while it's on
  // screen; opening the tab still fetches the latest snapshot first.
  useEffect(() => {
    if (!isOpen || activeTab !== "bigwins") return;
    const unsubscribe = subscribeToBigWins((win) => {
      setBigWins((prev) => {
        const next = [win, ...prev.filter((w) => w.id !== win.id)];
        return next.slice(0, 50);
      });
    });
    return unsubscribe;
  }, [isOpen, activeTab]);

  // Supabase Realtime safety net: append messages written outside this
  // client's socket path. The WAL row is partial (no join-computed fields),
  // so it merges under — never over — richer rows already in the list; the
  // socket `chat:updated` broadcast above carries the full row. The
  // subscription is server-side filtered to room_type=global, so it only
  // fires for the global chat — game-room chat stays on the socket path.
  useEffect(() => {
    if (!isOpen || activeTab !== "chat" || !room || room.roomType !== "global") return;
    const unsubscribe = subscribeToChatMessages((row) => {
      if (row.roomType !== room.roomType || row.roomId !== room.roomId) return;
      setMessages((prev) => upsertChatMessage(prev, row));
    });
    return unsubscribe;
  }, [isOpen, activeTab, room?.roomType, room?.roomId]);

  async function handleRefresh() {
    setError("");
    try {
      await loadMessages();
    } catch (err) {
      setError(err.message || "Failed to refresh chat.");
    }
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!room || isSending) return;
    const clean = message.trim();
    if (!clean) return;

    setIsSending(true);
    setError("");

    try {
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomType: room.roomType,
          roomId: room.roomId,
          content: clean,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to send message.");

      if (
        Array.isArray(data.unlockedSpecialTitles) &&
        data.unlockedSpecialTitles.length
      ) {
        setError(
          `NEW SECRET TITLE UNLOCKED: ${data.unlockedSpecialTitles.join(", ")}`,
        );
      }

      setMessage("");
      // Append the POST response in place (full enriched row) — no re-fetch
      // of the history — and broadcast it so every client in the room
      // appends instead of re-fetching too.
      setMessages((prev) => upsertChatMessage(prev, data.message));
      socket?.emit("room_event", {
        roomId: `chat:${room.roomType}:${room.roomId}`,
        event: "chat:updated",
        payload: {
          roomType: room.roomType,
          roomId: room.roomId,
          message: data.message,
        },
      });
    } catch (err) {
      setError(err.message || "Failed to send message.");
    } finally {
      setIsSending(false);
    }
  }

  async function handleModerationDelete(id) {
    try {
      const res = await fetch("/api/chat/moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: id, action: "hide" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Moderation request failed.");
      // Soft-delete locally and broadcast a patch so every client marks the
      // message removed in place — no re-fetch of the history.
      const patch = { id, isDeleted: true };
      setMessages((prev) => upsertChatMessage(prev, patch));
      socket?.emit("room_event", {
        roomId: `chat:${room.roomType}:${room.roomId}`,
        event: "chat:updated",
        payload: {
          roomType: room.roomType,
          roomId: room.roomId,
          message: patch,
        },
      });
    } catch (err) {
      setError(err.message || "Could not moderate this message.");
    }
  }

  function openSupportChat() {
    setActiveTab("support");

    const openTawk = () => {
      if (typeof window === "undefined") return;
      if (window.Tawk_API && window.Tawk_API.maximize) {
        window.Tawk_API.showWidget?.();
        window.Tawk_API.maximize();
      } else {
        setTimeout(openTawk, 200);
      }
    };

    openTawk();
  }

  if (!room) return null;

  return (
    <div className="fixed bottom-20 left-3 z-[70] sm:bottom-4 sm:left-4">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="relative h-14 w-14 touch-manipulation rounded-full bg-gradient-to-br from-cyan-400 via-fuchsia-500 to-purple-600 text-2xl text-black shadow-[0_0_25px_rgba(34,211,238,0.5)] transition-all hover:scale-110 hover:shadow-[0_0_40px_rgba(217,70,239,0.7)] active:scale-95 animate-neonButton sm:h-16 sm:w-16 sm:text-3xl"
        aria-label="Toggle chat"
      >
        💬
        {/* pulsing ring */}
        <span className="absolute inset-0 rounded-full border border-cyan-300/40 animate-ping" />
      </button>

      {isOpen ? (
        <div className="mt-2 w-[calc(100vw-1.5rem)] max-w-[420px] rounded-xl border border-cyan-400/30 bg-black/70 p-3 text-sm text-cyan-50 shadow-[0_0_35px_rgba(34,211,238,0.25)] backdrop-blur-xl relative overflow-hidden animate-neonPulse sm:p-4">
          {/* scanline overlay */}
          <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.08] mix-blend-overlay bg-[repeating-linear-gradient(0deg,black,black_2px,transparent_2px,transparent_4px)] animate-scanlines" />
          <div className="mb-2 flex items-center justify-between gap-2 text-cyan-300">
            <div className="flex items-center gap-1 rounded-lg border border-cyan-400/25 bg-black/40 p-1">
              <button
                type="button"
                onClick={() => setActiveTab("chat")}
                className={`rounded px-2 py-1 text-[12px] font-medium transition ${
                  activeTab === "chat"
                    ? "bg-cyan-400/20 text-cyan-100"
                    : "text-cyan-300/70 hover:bg-cyan-500/10 hover:text-cyan-200"
                }`}
              >
                {room.title}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("bigwins")}
                className={`rounded px-2 py-1 text-[12px] font-medium transition ${
                  activeTab === "bigwins"
                    ? "bg-yellow-400/20 text-yellow-100"
                    : "text-yellow-300/70 hover:bg-yellow-500/10 hover:text-yellow-200"
                }`}
              >
                <IconConfetti size={14} className="mb-0.5 mr-1 inline" /> Top Wins
              </button>
              <button
                type="button"
                onClick={openSupportChat}
                className={`rounded px-2 py-1 text-[12px] font-medium transition ${
                  activeTab === "support"
                    ? "bg-cyan-400/20 text-cyan-100"
                    : "text-cyan-300/70 hover:bg-cyan-500/10 hover:text-cyan-200"
                }`}
              >
                Support
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleRefresh}
                className="rounded border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-400/20"
              >
                Refresh
              </button>
              <span className="text-[11px] text-slate-400">
                History enabled
              </span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="ml-1 rounded px-1.5 py-0.5 text-sm text-cyan-300 hover:bg-fuchsia-500/20 hover:text-fuchsia-200"
                aria-label="Close chat"
                title="Close chat"
              >
                <IconX size={16} />
              </button>
            </div>
          </div>

          {activeTab === "chat" ? (
            <>
              <div
                ref={messagesContainerRef}
                role="region"
                aria-label="Chat messages"
                tabIndex={0}
                className="mb-2 h-[45vh] max-h-72 overflow-y-auto rounded border border-cyan-400/20 bg-black/60 p-2 shadow-inner shadow-cyan-500/10"
              >
                {messages.length === 0 ? (
                  <p className="text-cyan-400/40">No messages yet.</p>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className="mb-2 rounded border border-cyan-400/10 bg-gradient-to-r from-black/60 to-cyan-950/20 px-2 py-1 hover:border-cyan-400/30 transition"
                    >
                      <div className="mb-1 flex items-center justify-between text-[11px] text-cyan-300/70">
                        <span className="flex items-center gap-3 font-medium text-fuchsia-300 drop-shadow-[0_0_6px_rgba(217,70,239,0.5)]">
                          {(() => {
                            // Official Grynd icon only — the legacy
                            // profile_image_url snapshot is never rendered
                            // as a live avatar (falls back to default).
                            return (
                              <FrameAvatar
                                frame={msg.profileFrame}
                                iconKey={msg.iconKey}
                                name={msg.displayName}
                                size="h-9 w-9"
                                className="border-2 border-cyan-400/60 shadow-[0_0_12px_rgba(34,211,238,0.45)]"
                              />
                            );
                          })()}
                          <span style={msg.chatColor ? { color: msg.chatColor } : undefined}>
                            {msg.displayName || "Player"}
                          </span>
                          {msg.premium ? (
                            <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.35)]">
                              {msg.tier === "high_roller"
                                ? "HIGH ROLLER"
                                : msg.tier === "pro"
                                  ? "GRYND PRO"
                                  : "GRYND+"}
                            </span>
                          ) : null}
                          {msg.equippedTitle ? (
                            <span className="rounded-full border border-fuchsia-400/60 bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fuchsia-200 shadow-[0_0_10px_rgba(217,70,239,0.35)]">
                              {msg.equippedTitle}
                            </span>
                          ) : null}
                          {msg.streakTitle ? (
                            <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-200 shadow-[0_0_10px_rgba(251,191,36,0.35)]">
                              <IconFlame size={12} className="mb-0.5 mr-0.5 inline" /> {msg.streakTitle}
                            </span>
                          ) : null}
                        </span>
                        <span>
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="break-words text-[13px]">
                        {msg.isDeleted ? (
                          <em className="text-slate-500">
                            Message removed by moderator.
                          </em>
                        ) : (
                          <MessageText content={msg.content} />
                        )}
                      </div>
                      {isAdmin && !msg.isDeleted ? (
                        <button
                          type="button"
                          onClick={() => handleModerationDelete(msg.id)}
                          className="mt-1 text-[11px] text-rose-300 hover:text-rose-200"
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  ))
                )}
              </div>

              <p className="mb-2 text-[11px] text-slate-400">
                Live updates enabled with refresh fallback.
              </p>

              {!isSignedIn ? (
                <p className="text-xs text-slate-400">Sign in to join chat.</p>
              ) : (
                <form onSubmit={handleSend} className="space-y-2">
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder="Say something... Emojis and formatting **bold** *italic* `code`"
                    className="w-full resize-none rounded border border-cyan-400/20 bg-black/60 p-2 text-sm text-cyan-50 outline-none focus:border-fuchsia-400 focus:shadow-[0_0_12px_rgba(217,70,239,0.4)]"
                  />
                  <button
                    type="submit"
                    disabled={isSending}
                    className="w-full rounded bg-gradient-to-r from-cyan-500 to-fuchsia-500 py-1 font-medium text-black hover:from-fuchsia-500 hover:to-cyan-500 shadow-[0_0_20px_rgba(34,211,238,0.4)] disabled:opacity-60"
                  >
                    {isSending ? "Sending..." : "Send"}
                  </button>
                </form>
              )}
            </>
          ) : activeTab === "bigwins" ? (
            <>
              <div
                role="region"
                aria-label="Top wins feed"
                tabIndex={0}
                className="mb-2 h-[45vh] max-h-72 overflow-y-auto rounded border border-yellow-400/20 bg-black/60 p-2 shadow-inner shadow-yellow-500/10"
              >
                {isLoadingBigWins ? (
                  <p className="text-yellow-400/40 text-center py-4">Loading top wins...</p>
                ) : bigWins.length === 0 ? (
                  <p className="text-yellow-400/40 text-center py-4">No top wins yet (≥{formatNumber(MINIMUM_BIG_WIN)} tokens).</p>
                ) : (
                  bigWins.map((win) => (
                    <div
                      key={win.id}
                      className="mb-2 rounded border border-yellow-400/20 bg-gradient-to-r from-black/60 to-yellow-950/20 px-2 py-2 hover:border-yellow-400/40 transition"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <IconConfetti size={20} className="text-yellow-300" />
                          <span className="font-bold text-yellow-300 text-sm">{win.username}</span>
                        </div>
                        <span className="text-[10px] text-slate-400">
                          {new Date(win.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-[11px]">
                          <span className="text-slate-400">{win.game}</span>
                          <span className="text-yellow-400/60">|</span>
                          <span className="text-slate-400">Stake: {formatNumber(win.betAmount)}</span>
                        </div>
                        <div className="text-right">
                          <div className="text-lg font-bold text-yellow-400">
                            <span className="inline-flex items-center gap-1">
                              +{formatNumber(win.winAmount)}
                              <IconCoin size={16} className="text-yellow-400" />
                            </span>
                          </div>
                          <div className="text-[10px] text-yellow-300/60">
                            {parseFloat(win.multiplier).toFixed(2)}x multiplier
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <p className="mb-2 text-[11px] text-yellow-400/60">
                <IconConfetti size={14} className="mb-0.5 mr-1 inline" /> Top Wins feed shows wins of {formatNumber(MINIMUM_BIG_WIN)}+ tokens.
              </p>
              <button
                type="button"
                onClick={loadBigWins}
                className="w-full rounded border border-yellow-400/30 bg-yellow-500/10 py-1 text-sm text-yellow-200 hover:bg-yellow-400/20"
              >
                Refresh
              </button>
            </>
          ) : (
            <div className="rounded border border-cyan-400/20 bg-black/60 p-3 text-xs text-cyan-200">
              <p className="mb-2">Support chat is opening…</p>
              <p className="text-slate-400">
                If it did not open yet, click Support again in a second.
              </p>
            </div>
          )}

          {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
