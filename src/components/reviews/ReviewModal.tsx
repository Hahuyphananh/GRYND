"use client";

import { useState } from "react";
import { motion } from "framer-motion";

interface ReviewModalProps {
  open: boolean;
  onClose: () => void;
  /** Game the review is about (optional). */
  game?: string;
  /** Existing review (edit mode). */
  existing?: { rating: number; title: string | null; body: string | null } | null;
}

const STAR_LABELS = ["", "Poor", "Fair", "Good", "Very good", "Excellent"];

export default function ReviewModal({ open, onClose, game, existing }: ReviewModalProps) {
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [body, setBody] = useState(existing?.body ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  if (!open) return null;

  const submit = async () => {
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, title, body, game }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage({ ok: true, text: data.message });
      } else {
        setMessage({ ok: false, text: data.error || "Something went wrong." });
      }
    } catch {
      setMessage({ ok: false, text: "Network error. Please try again." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[#00e5ff]/20 bg-[#040d24] p-6 shadow-[0_0_40px_rgba(0,229,255,0.15)]"
      >
        <h2 className="mb-1 text-xl font-bold text-white">
          {existing ? "Update your review" : "Rate GRYND"}
        </h2>
        {game ? (
          <p className="mb-4 text-sm text-[#c9f7ff]/70">How was your {game} session?</p>
        ) : (
          <p className="mb-4 text-sm text-[#c9f7ff]/70">
            How has your overall experience been?
          </p>
        )}

        {message ? (
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              message.ok
                ? "border-green-500/40 bg-green-500/10 text-green-300"
                : "border-red-500/40 bg-red-500/10 text-red-300"
            }`}
          >
            {message.text}
            {message.ok && (
              <button
                onClick={onClose}
                className="mt-3 block rounded-lg bg-[#00e5ff]/20 px-4 py-2 text-[#00e5ff] hover:bg-[#00e5ff]/30"
              >
                Close
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Star picker */}
            <div className="mb-4 flex items-center justify-center gap-1" onMouseLeave={() => setHover(0)}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onMouseEnter={() => setHover(n)}
                  onClick={() => setRating(n)}
                  className="text-3xl transition-transform hover:scale-110"
                  aria-label={`${n} star${n > 1 ? "s" : ""}`}
                >
                  <span
                    className={
                      (hover || rating) >= n ? "text-[#f5ff3b]" : "text-white/20"
                    }
                  >
                    ★
                  </span>
                </button>
              ))}
            </div>
            <p className="mb-4 text-center text-sm text-[#c9f7ff]/70">
              {hover || rating ? STAR_LABELS[hover || rating] : "Tap a star"}
            </p>

            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Summary (optional)"
              className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-white placeholder:text-white/30 focus:border-[#00e5ff]/50 focus:outline-none"
            />
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="What do you love, and what could be better? (optional)"
              className="mb-4 w-full resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-white placeholder:text-white/30 focus:border-[#00e5ff]/50 focus:outline-none"
            />

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-white/15 px-4 py-2 text-white/70 hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting || rating === 0}
                className="flex-1 rounded-lg bg-gradient-to-r from-[#00e5ff] to-[#00a8cc] px-4 py-2 font-bold text-[#00131a] disabled:opacity-40"
              >
                {submitting ? "Submitting..." : existing ? "Update review" : "Submit review"}
              </button>
            </div>
            <p className="mt-3 text-center text-xs text-[#c9f7ff]/50">
              One review per account. It appears after moderation.
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}
