"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../context/SocketProvider";
import FrameAvatar from "./FrameAvatar";
import { cosmeticEffectClass } from "../lib/profileCosmetics";
import { subscribeToChatMessages } from "../lib/realtime";
import { upsertChatMessage } from "../lib/chatMessageList";
import { IconFlame, IconX } from "@tabler/icons-react";
import ChatEmoteTray from "./game/emotes/ChatEmoteTray";
import { useActiveEmoteChannel } from "./game/emotes/emoteChannel";

const GLOBAL_ROUTES = new Set(["/", "/casino", "/games", "/classement", "/rankings"]);

// The launcher belongs to the player: how close to an edge it may sit, how far
// a press has to travel before it is a drag rather than a tap, and where that
// spot is remembered between visits.
const LAUNCHER_EDGE_GAP = 8;
const LAUNCHER_DRAG_SLOP = 4;
const LAUNCHER_POSITION_KEY = "grynd:chat-launcher-position";

function clampToRange(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

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

export default function ChatWidget() {
  const pathname = usePathname();
  const { user, isSignedIn } = useUser();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Unread messages, social-app style: raised by anything arriving while the
  // panel is closed, cleared the moment it opens.
  const [unread, setUnread] = useState(0);
  // True while the emote grid is expanded: the message list then gives up its
  // minimum height so the grid and the composer both stay inside the panel.
  const [emotesOpen, setEmotesOpen] = useState(false);

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

  // The emote picker lives in this panel; it sends through whichever match page
  // is mounted (see game/emotes/emoteChannel).
  const emoteChannel = useActiveEmoteChannel();

  // What the socket handlers should do about the panel being open, read at the
  // moment a message lands. A ref keeps the room subscription stable across
  // open/close, so a message arriving just after closing still counts.
  const openRef = useRef(false);
  // Ids already counted: the socket broadcast and the Supabase safety net can
  // both deliver the same row, and it must only count once.
  const countedIdsRef = useRef([]);

  useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  // ── Draggable launcher ────────────────────────────────────────────────────
  // On game pages the icon sat on top of the play area (the Dominoes board,
  // for one) and could not be moved. It now follows the pointer and keeps the
  // spot it was left in, so every player parks it out of their own way.
  const launcherRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  // {x, y} from the viewport's top-left. Null until the player moves it, which
  // leaves the default CSS corner in charge.
  const [launcherPos, setLauncherPos] = useState(null);
  const [viewport, setViewport] = useState(null); // {w, h}, measured on the client
  const [panelAnchor, setPanelAnchor] = useState(null); // launcher box while the panel is open
  const [isDragging, setIsDragging] = useState(false);

  const measureLauncher = useCallback(() => {
    const rect = launcherRef.current?.getBoundingClientRect();
    return rect
      ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
      : null;
  }, []);

  // Wherever the player parks it, the icon stays fully on screen.
  const clampLauncher = useCallback((x, y) => {
    const rect = launcherRef.current?.getBoundingClientRect();
    const w = rect?.width || 56;
    const h = rect?.height || 56;
    return {
      x: clampToRange(x, LAUNCHER_EDGE_GAP, window.innerWidth - w - LAUNCHER_EDGE_GAP),
      y: clampToRange(y, LAUNCHER_EDGE_GAP, window.innerHeight - h - LAUNCHER_EDGE_GAP),
    };
  }, []);

  // Restore a previously parked spot, re-clamped in case the screen shrank
  // since it was stored.
  useEffect(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    let stored = null;
    try {
      stored = JSON.parse(
        window.localStorage.getItem(LAUNCHER_POSITION_KEY) || "null",
      );
    } catch {
      stored = null;
    }
    if (Number.isFinite(stored?.x) && Number.isFinite(stored?.y)) {
      setLauncherPos(clampLauncher(stored.x, stored.y));
    }
  }, [clampLauncher]);

  // A rotation, a resized window or a mobile URL bar appearing moves the de-
  // line of the viewport: the icon and its open panel follow it back on screen.
  useEffect(() => {
    const handleViewportChange = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setLauncherPos((prev) => (prev ? clampLauncher(prev.x, prev.y) : prev));
      setPanelAnchor((prev) => (prev ? measureLauncher() || prev : prev));
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("orientationchange", handleViewportChange);
    };
  }, [clampLauncher, measureLauncher]);

  // Measured before the panel opens so its first painted frame is already in
  // the right place, instead of jumping once after mount.
  const capturePanelAnchor = useCallback(() => {
    setPanelAnchor(measureLauncher());
  }, [measureLauncher]);

  function handleLauncherPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = measureLauncher();
    if (!rect) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.x,
      originY: rect.y,
      width: rect.w,
      height: rect.h,
      moved: false,
      settled: null,
    };
    suppressClickRef.current = false;
    // Capture the pointer so the drag keeps tracking when it outruns the icon.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleLauncherPointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // A tap wobbles by a pixel or two; only real travel starts a drag.
    if (
      !drag.moved &&
      Math.abs(dx) < LAUNCHER_DRAG_SLOP &&
      Math.abs(dy) < LAUNCHER_DRAG_SLOP
    ) {
      return;
    }
    if (!drag.moved) {
      drag.moved = true;
      setIsDragging(true);
    }
    const settled = clampLauncher(drag.originX + dx, drag.originY + dy);
    drag.settled = settled;
    setLauncherPos(settled);
    // An open panel travels with its launcher instead of staying behind.
    if (openRef.current) {
      setPanelAnchor({
        x: settled.x,
        y: settled.y,
        w: drag.width,
        h: drag.height,
      });
    }
  }

  function handleLauncherPointerEnd(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
    if (!drag.moved || !drag.settled) return;
    // The pointer sequence still ends with a click on this button: that was a
    // move, not a request to open the panel.
    suppressClickRef.current = true;
    try {
      window.localStorage.setItem(
        LAUNCHER_POSITION_KEY,
        JSON.stringify(drag.settled),
      );
    } catch {
      // No storage (private mode): the spot simply is not remembered.
    }
  }

  const bumpUnread = useCallback((id) => {
    if (id != null) {
      const counted = countedIdsRef.current;
      if (counted.includes(id)) return;
      counted.push(id);
      if (counted.length > 120) counted.shift();
    }
    if (!openRef.current) setUnread((n) => n + 1);
  }, []);

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

  // A different room is a different conversation: no badge carries over.
  useEffect(() => {
    countedIdsRef.current = [];
    setUnread(0);
  }, [room?.roomType, room?.roomId]);

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
    if (!socket || !room) return;
    const roomKey = `chat:${room.roomType}:${room.roomId}`;
    const handleChatUpdate = (payload) => {
      if (payload?.message?.id != null) {
        setMessages((prev) => upsertChatMessage(prev, payload.message));
        // This is what raises the badge while the panel is closed.
        bumpUnread(payload.message.id);
        return;
      }
      // Legacy payload with no row to merge: flag it, and refresh only when the
      // panel is open (opening refetches the history anyway).
      bumpUnread(null);
      if (openRef.current) loadMessages().catch(() => {});
    };

    socket.emit("join_room", { roomId: roomKey });
    socket.on("chat:updated", handleChatUpdate);

    return () => {
      socket.emit("leave_room", { roomId: roomKey });
      socket.off("chat:updated", handleChatUpdate);
    };
  }, [socket, room?.roomType, room?.roomId, bumpUnread]);

  useEffect(() => {
    if (!isOpen) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isOpen]);

  // Supabase Realtime safety net: append messages written outside this
  // client's socket path. The WAL row is partial (no join-computed fields),
  // so it merges under — never over — richer rows already in the list; the
  // socket `chat:updated` broadcast above carries the full row. The
  // subscription is server-side filtered to room_type=global, so it only
  // fires for the global chat — game-room chat stays on the socket path.
  useEffect(() => {
    if (!room || room.roomType !== "global") return;
    const unsubscribe = subscribeToChatMessages((row) => {
      if (row.roomType !== room.roomType || row.roomId !== room.roomId) return;
      setMessages((prev) => upsertChatMessage(prev, row));
      bumpUnread(row.id);
    });
    return unsubscribe;
  }, [room?.roomType, room?.roomId, bumpUnread]);

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

    const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const optimisticRow = {
      id: tempId,
      roomType: room.roomType,
      roomId: room.roomId,
      content: clean,
      displayName: user?.fullName || user?.username || "You",
      createdAt: new Date().toISOString(),
      pending: true,
    };

    setIsSending(true);
    setError("");
    // Echo the message locally the moment the user hits send, then swap in
    // the server row (which carries the id, colour and cosmetics) when it
    // arrives. On failure the echo is removed and the text is restored — so
    // the composer never looks frozen waiting on the round trip.
    setMessages((prev) => [...prev, optimisticRow]);
    setMessage("");

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

      // Drop the placeholder and append the POST response in place (full
      // enriched row) — no re-fetch of the history — and broadcast it so
      // every client in the room appends instead of re-fetching too.
      setMessages((prev) =>
        upsertChatMessage(
          prev.filter((m) => m.id !== tempId),
          data.message,
        ),
      );
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
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setMessage(clean);
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

  function toggleChat() {
    // A drag ends with a click on the same button — that was a move, not a tap.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    // Opening clears the badge; closing it leaves zero (nothing was unread
    // while you were looking at the room). Also fold the emote grid away.
    const opening = !isOpen;
    setUnread(0);
    setEmotesOpen(false);
    // Measure before opening so the panel's first frame is already placed.
    if (opening) capturePanelAnchor();
    setIsOpen(opening);
  }

  // The panel is placed from the launcher's measured box, so an icon parked in
  // any corner still opens a panel that is fully on screen: it clamps
  // horizontally and flips above the icon when there is no room below.
  const panelBox = (() => {
    if (!isOpen || !panelAnchor || !viewport) return null;
    const gap = 8;
    const width = Math.min(
      420,
      Math.max(240, viewport.w - LAUNCHER_EDGE_GAP * 2),
    );
    const left = clampToRange(
      panelAnchor.x,
      LAUNCHER_EDGE_GAP,
      viewport.w - width - LAUNCHER_EDGE_GAP,
    );
    const spaceBelow =
      viewport.h - (panelAnchor.y + panelAnchor.h) - gap - LAUNCHER_EDGE_GAP;
    const spaceAbove = panelAnchor.y - gap - LAUNCHER_EDGE_GAP;
    const opensUp = spaceBelow < 280 && spaceAbove > spaceBelow;
    const available = Math.max(160, opensUp ? spaceAbove : spaceBelow);
    return {
      left: `${left}px`,
      width: `${width}px`,
      maxHeight: `${Math.min(608, available)}px`,
      ...(opensUp
        ? { bottom: `${viewport.h - panelAnchor.y + gap}px` }
        : { top: `${panelAnchor.y + panelAnchor.h + gap}px` }),
    };
  })();

  if (!room) return null;

  return (
    <div
      ref={launcherRef}
      className={`fixed z-[70] ${
        launcherPos ? "" : "bottom-20 left-3 sm:bottom-4 sm:left-4"
      }`}
      style={
        launcherPos
          ? {
              left: `${launcherPos.x}px`,
              top: `${launcherPos.y}px`,
              right: "auto",
              bottom: "auto",
            }
          : undefined
      }
    >
      <button
        type="button"
        onClick={toggleChat}
        onKeyDown={() => {
          // Keyboard activation is never the tail of a drag.
          suppressClickRef.current = false;
        }}
        onPointerDown={handleLauncherPointerDown}
        onPointerMove={handleLauncherPointerMove}
        onPointerUp={handleLauncherPointerEnd}
        onPointerCancel={handleLauncherPointerEnd}
        data-chat-toggle=""
        data-chat-dragging={isDragging ? "" : undefined}
        data-chat-unread-count={unread}
        className={`relative h-14 w-14 touch-none rounded-full bg-gradient-to-br from-cyan-400 via-fuchsia-500 to-purple-600 text-2xl text-black shadow-[0_0_25px_rgba(34,211,238,0.5)] transition-all hover:scale-110 hover:shadow-[0_0_40px_rgba(217,70,239,0.7)] active:scale-95 animate-neonButton sm:h-16 sm:w-16 sm:text-3xl ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        aria-label={
          unread > 0
            ? `Open chat, ${unread} unread message${unread === 1 ? "" : "s"}`
            : "Toggle chat"
        }
      >
        💬
        {/* pulsing ring */}
        <span className="absolute inset-0 rounded-full border border-cyan-300/40 animate-ping" />
        {/* Notification dot, top-right, like a social app: it stays until the
            panel is opened. */}
        {unread > 0 ? (
          <span
            data-chat-unread=""
            role="status"
            className="absolute -right-1 -top-1 z-10 flex h-5 min-w-5 items-center justify-center rounded-full border border-black/60 bg-gradient-to-br from-rose-500 to-fuchsia-500 px-1 text-[11px] font-black leading-none text-white shadow-[0_0_10px_rgba(244,63,94,0.85)]"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div
          data-chat-panel=""
          style={{
            // Fixed to the viewport even while it lives inside the launcher:
            // an icon dragged into a corner must not push its panel off screen.
            // Inline values win over the position/size utility classes below.
            position: "fixed",
            zIndex: 70,
            margin: 0,
            ...panelBox,
            ...(emotesOpen && panelBox ? { height: panelBox.maxHeight } : null),
          }}
          className={`relative mt-2 flex w-[calc(100vw-1.5rem)] max-w-[420px] flex-col overflow-hidden rounded-xl border border-cyan-400/30 bg-black/70 p-3 text-sm text-cyan-50 shadow-[0_0_35px_rgba(34,211,238,0.25)] backdrop-blur-xl animate-neonPulse sm:p-4 ${
            emotesOpen ? "h-[min(78dvh,38rem)]" : "max-h-[min(78dvh,38rem)]"
          }`}
        >
          {/* scanline overlay */}
          <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.08] mix-blend-overlay bg-[repeating-linear-gradient(0deg,black,black_2px,transparent_2px,transparent_4px)] animate-scanlines" />
          <div className="mb-2 flex items-center justify-between gap-2 text-cyan-300">
            <div className="flex items-center gap-1 rounded-lg border border-cyan-400/25 bg-black/40 p-1">
              <span className="rounded bg-cyan-400/20 px-2 py-1 text-[12px] font-medium text-cyan-100">
                {room.title}
              </span>
              <Link
                href="/contact"
                onClick={() => setIsOpen(false)}
                className="rounded px-2 py-1 text-[12px] font-medium text-cyan-300/70 transition hover:bg-cyan-500/10 hover:text-cyan-200"
              >
                Support
              </Link>
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

          <>
              <div
                ref={messagesContainerRef}
                role="region"
                aria-label="Chat messages"
                tabIndex={0}
                className="mb-2 min-h-40 flex-1 basis-0 overflow-y-auto rounded border border-cyan-400/20 bg-black/60 p-2 shadow-inner shadow-cyan-500/10"
              >
                {messages.length === 0 ? (
                  <p className="text-cyan-400/40">No messages yet.</p>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`mb-2 rounded border border-cyan-400/10 bg-gradient-to-r from-black/60 to-cyan-950/20 px-2 py-1 hover:border-cyan-400/30 transition ${
                        msg.pending ? "opacity-60" : ""
                      }`}
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
                          <span
                            className={cosmeticEffectClass(msg.chatEffect?.visual) || undefined}
                            style={msg.chatColor ? { color: msg.chatColor } : undefined}
                          >
                            {msg.displayName || "Player"}
                          </span>
                          {msg.premium ? (
                            <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-emerald-300 shadow-[0_0_10px_rgba(52,211,153,0.35)]">
                              {msg.premiumTitle || "GRYND PRO"}
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
                          {msg.pending
                            ? "Sending…"
                            : new Date(msg.createdAt).toLocaleTimeString()}
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

              {/* The emote picker, only inside a match (it sends to the game). */}
              {emoteChannel ? <ChatEmoteTray onOpenChange={setEmotesOpen} /> : null}

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

          {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
