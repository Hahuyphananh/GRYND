'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUser } from '@clerk/nextjs';

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

    let cancelled = false;

    const refresh = async () => {
      try {
        await loadMessages();
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to refresh chat.');
      }
    };

    refresh();
    const timer = setInterval(refresh, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [room?.roomType, room?.roomId, isOpen]);

  async function handleSend(e) {
    e.preventDefault();
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

      setMessage('');
      await loadMessages();
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
        className="h-12 w-12 rounded-full bg-emerald-500 text-2xl shadow-lg transition hover:bg-emerald-400"
        aria-label="Toggle chat"
      >
        💬
      </button>

      {isOpen ? (
        <div className="mt-2 w-[320px] rounded-xl border border-slate-700 bg-slate-900/95 p-3 text-sm text-slate-100 shadow-2xl backdrop-blur">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-semibold">{room.title}</p>
            <span className="text-[11px] text-slate-400">History enabled</span>
          </div>

          <div className="mb-2 h-64 overflow-y-auto rounded border border-slate-700 bg-slate-950 p-2">
            {messages.length === 0 ? (
              <p className="text-slate-500">No messages yet.</p>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className="mb-2 rounded bg-slate-800 px-2 py-1">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
                    <span className="font-medium text-emerald-300">{msg.displayName || 'Player'}</span>
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
                className="w-full resize-none rounded border border-slate-700 bg-slate-950 p-2 text-sm outline-none focus:border-emerald-500"
              />
              <button
                type="submit"
                disabled={isSending}
                className="w-full rounded bg-emerald-600 py-1 font-medium text-white hover:bg-emerald-500 disabled:opacity-60"
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
