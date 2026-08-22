"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import AdminBadge from "./AdminBadge";

/**
 * Shared user-facing message history: the signed-in user's contact form
 * messages and the admin team's replies. Used on both /contact and /profil.
 * Renders nothing until Clerk has loaded; shows a sign-in hint when the
 * visitor is signed out.
 */
export default function ContactMessageHistory({ title = "Your Messages" }) {
  const { isLoaded, isSignedIn } = useUser();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch("/api/contact/messages")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.success) {
          setMessages(data.messages || []);
        } else {
          setError(data.error || "Failed to load your messages.");
        }
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load your messages.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) return null;

  // Signed out: show a gentle hint so the section still has a purpose.
  if (!isSignedIn) {
    return (
      <section className="bg-[#0e1f4d]/90 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold text-white mb-1">{title}</h2>
        <p className="text-sm text-[#c9f7ff]/60 py-4">
          Sign in to view your message history and replies from the team.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-[#0e1f4d]/90 border border-white/10 rounded-xl p-6">
      <h2 className="text-xl font-semibold text-white mb-1">{title}</h2>
      <p className="text-sm text-[#c9f7ff]/60 mb-4">
        Messages you&apos;ve sent through the contact form, and replies from
        the team.
      </p>

      {error && <p className="text-sm text-red-300 mb-4">{error}</p>}

      {loading && messages.length === 0 && (
        <div className="flex justify-center py-10">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#f5ff3b] border-t-transparent" />
        </div>
      )}

      {!loading && messages.length === 0 && !error && (
        <p className="text-sm text-[#c9f7ff]/50 py-6 text-center">
          No messages yet. When you contact us, your messages and our replies
          will show up here.
        </p>
      )}

      <div className="space-y-4">
        {messages.map((m) => (
          <div
            key={m.id}
            className="border border-white/10 rounded-lg p-4 bg-[#0a0f1e]/80"
          >
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-xs text-[#c9f7ff]/50 font-mono">
                {new Date(m.created_at).toLocaleString()}
              </span>
              {m.status === "new" ? (
                <span className="rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                  AWAITING REPLY
                </span>
              ) : m.status === "replied" ? (
                <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                  REPLIED
                </span>
              ) : (
                <span className="rounded-full bg-gray-500/15 border border-gray-500/30 px-2 py-0.5 text-[10px] font-medium text-gray-400">
                  RESOLVED
                </span>
              )}
            </div>
            <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
              {m.message}
            </p>

            {m.replies && m.replies.length > 0 && (
              <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
                {m.replies.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-lg bg-[#0e1f4d]/60 border border-white/10 p-3"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-[#f5ff3b]">
                        {r.admin_name}
                      </span>
                      <AdminBadge />
                      <span className="text-[10px] text-[#c9f7ff]/40 font-mono">
                        {new Date(r.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-200 whitespace-pre-wrap break-words">
                      {r.reply}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
