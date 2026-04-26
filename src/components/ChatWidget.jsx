'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@clerk/nextjs';
import { useSocket } from '../context/SocketProvider';

const GLOBAL_ROUTES = new Set(['/', '/casino', '/classement', '/rankings']);

function formatParts(text) {
  const tokens = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      tokens.push({ type: 'bold', value: token.slice(2, -2) });
    } else if (token.startsWith('*') && token.endsWith('*')) {
      tokens.push({ type: 'italic', value: token.slice(1, -1) });
    } else if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push({ type: 'code', value: token.slice(1, -1) });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return tokens;
}

function MessageText({ content }) {
  const lines = content.split('\n');

  return (
    <>
      {lines.map((line, idx) => (
        <span key={`${line}-${idx}`}>
          {formatParts(line).map((part, pIdx) => {
            if (part.type === 'bold') return <strong key={pIdx}>{part.value}</strong>;
            if (part.type === 'italic') return <em key={pIdx}>{part.value}</em>;
            if (part.type === 'code') return <code key={pIdx} className="rounded bg-slate-700 px-1">{part.value}</code>;
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
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isSending, setIsSending] = useState(false);
  const { socket } = useSocket();
  const messagesContainerRef = useRef(null);

  const room = useMemo(() => {
    if (!pathname) return null;

    if (GLOBAL_ROUTES.has(pathname)) {
      return { roomType: 'global', roomId: 'main-lobby', title: 'Global chat' };
    }

    if (pathname.startsWith('/casino/')) {
      return {
        roomType: 'game',
        roomId: pathname,
        title: `Game chat: ${pathname.replace('/casino/', '').replaceAll('/', ' › ')}`,
      };
    }

    return null;
  }, [pathname]);

  const isAdmin = useMemo(() => {
    if (!user?.id) return false;
    const admins = (process.env.NEXT_PUBLIC_CHAT_ADMIN_CLERK_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    return admins.includes(user.id);
  }, [user?.id]);

  async function loadMessages() {
    if (!room) return;
    const params = new URLSearchParams({ roomType: room.roomType, roomId: room.roomId, limit: '75' });
    const res = await fetch(`/api/chat/messages?${params.toString()}`, { cache: 'no-store' });

    if (!res.ok) {
      throw new Error('Unable to load chat messages.');
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
        setError(err.message || 'Failed to refresh chat.');
      }
    };

    refresh();
  }, [room?.roomType, room?.roomId, isOpen]);

  useEffect(() => {
    if (!socket || !room || !isOpen) return;
    const roomKey = `chat:${room.roomType}:${room.roomId}`;
    const handleChatUpdate = () => {
      loadMessages().catch(() => {});
    };

    socket.emit('join_room', { roomId: roomKey });
    socket.on('chat:updated', handleChatUpdate);

    return () => {
      socket.emit('leave_room', { roomId: roomKey });
      socket.off('chat:updated', handleChatUpdate);
    };
  }, [socket, room?.roomType, room?.roomId, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isOpen]);

  async function handleRefresh() {
    setError('');
    try {
      await loadMessages();
    } catch (err) {
      setError(err.message || 'Failed to refresh chat.');
    }
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!room || isSending) return;
    const clean = message.trim();
    if (!clean) return;

    setIsSending(true);
    setError('');

    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomType: room.roomType, roomId: room.roomId, content: clean }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send message.');

      if (Array.isArray(data.unlockedSpecialTitles) && data.unlockedSpecialTitles.length) {
        setError(`NEW SECRET TITLE UNLOCKED: ${data.unlockedSpecialTitles.join(', ')}`);
      }

      setMessage('');
      await loadMessages();
      socket?.emit('room_event', {
        roomId: `chat:${room.roomType}:${room.roomId}`,
        event: 'chat:updated',
        payload: { roomType: room.roomType, roomId: room.roomId },
      });
    } catch (err) {
      setError(err.message || 'Failed to send message.');
    } finally {
      setIsSending(false);
    }
  }

  async function handleModerationDelete(id) {
    try {
      const res = await fetch('/api/chat/moderate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: id, action: 'hide' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Moderation request failed.');
      await loadMessages();
      socket?.emit('room_event', {
        roomId: `chat:${room.roomType}:${room.roomId}`,
        event: 'chat:updated',
        payload: { roomType: room.roomType, roomId: room.roomId },
      });
    } catch (err) {
      setError(err.message || 'Could not moderate this message.');
    }
  }

  if (!room) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[70]">
      <button
  type="button"
  onClick={() => setIsOpen((v) => !v)}
  className="relative h-16 w-16 rounded-full bg-gradient-to-br from-cyan-400 via-fuchsia-500 to-purple-600 text-2xl text-black shadow-[0_0_25px_rgba(34,211,238,0.5)] transition-all hover:scale-110 hover:shadow-[0_0_40px_rgba(217,70,239,0.7)] active:scale-95 animate-neonButton"
  aria-label="Toggle chat"
>
  💬

  {/* pulsing ring */}
  <span className="absolute inset-0 rounded-full border border-cyan-300/40 animate-ping" />
</button>

      {isOpen ? (
       <div className="mt-2 w-[420px] rounded-xl border border-cyan-400/30 bg-black/70 p-4 text-sm text-cyan-50 shadow-[0_0_35px_rgba(34,211,238,0.25)] backdrop-blur-xl relative overflow-hidden animate-neonPulse">
          {/* scanline overlay */}
<div className="pointer-events-none absolute inset-0 z-0 opacity-[0.08] mix-blend-overlay bg-[repeating-linear-gradient(0deg,black,black_2px,transparent_2px,transparent_4px)] animate-scanlines" />
          <div className="mb-2 flex items-center justify-between gap-2 text-cyan-300">
            <p className="font-semibold">{room.title}</p>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleRefresh}
                className="rounded border border-cyan-400/30 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-400/20"
              >
                Refresh
              </button>
              <span className="text-[11px] text-slate-400">History enabled</span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="ml-1 rounded px-1.5 py-0.5 text-sm text-cyan-300 hover:bg-fuchsia-500/20 hover:text-fuchsia-200"
                aria-label="Close chat"
                title="Close chat"
              >
                ✕
              </button>
            </div>
          </div>

          <div ref={messagesContainerRef} className="mb-2 h-64 overflow-y-auto rounded border border-cyan-400/20 bg-black/60 p-2 shadow-inner shadow-cyan-500/10">
            {messages.length === 0 ? (
              <p className="text-cyan-400/40">No messages yet.</p>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className="mb-2 rounded border border-cyan-400/10 bg-gradient-to-r from-black/60 to-cyan-950/20 px-2 py-1 hover:border-cyan-400/30 transition">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-cyan-300/70">
                    <span className="flex items-center gap-1.5 font-medium text-fuchsia-300 drop-shadow-[0_0_6px_rgba(217,70,239,0.5)]">
                      {msg.profileImageUrl && /^https?:\/\//.test(msg.profileImageUrl) ? (
                        <img
                          src={msg.profileImageUrl}
                          alt={`${msg.displayName || 'Player'} profile`}
                          className="h-5 w-5 rounded-full border border-slate-600 object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 bg-slate-700 text-[10px] uppercase text-slate-200">
                          {(msg.displayName || 'P').charAt(0)}
                        </span>
                      )}
                      <span>{msg.displayName || 'Player'}</span>
                      {msg.equippedTitle ? (
                        <span className="rounded-full border border-fuchsia-400/60 bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fuchsia-200 shadow-[0_0_10px_rgba(217,70,239,0.35)]">
                          {msg.equippedTitle}
                        </span>
                      ) : null}
                    </span>
                    <span>{new Date(msg.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div className="break-words text-[13px]">
                    {msg.isDeleted ? (
                      <em className="text-slate-500">Message removed by moderator.</em>
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

          <p className="mb-2 text-[11px] text-slate-400">Live updates enabled with refresh fallback.</p>

          {!isSignedIn ? (
            <p className="text-xs text-slate-400">Sign in to join chat.</p>
          ) : (
            <form onSubmit={handleSend} className="space-y-2">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Say something... Emojis 😀 and formatting **bold** *italic* `code`"
                className="w-full resize-none rounded border border-cyan-400/20 bg-black/60 p-2 text-sm text-cyan-50 outline-none focus:border-fuchsia-400 focus:shadow-[0_0_12px_rgba(217,70,239,0.4)]"
              />
              <button
                type="submit"
                disabled={isSending}
                className="w-full rounded bg-gradient-to-r from-cyan-500 to-fuchsia-500 py-1 font-medium text-black hover:from-fuchsia-500 hover:to-cyan-500 shadow-[0_0_20px_rgba(34,211,238,0.4)] disabled:opacity-60"
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </form>
          )}

          {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
