"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, usePathname } from "next/navigation";
import ReviewModal from "./ReviewModal";

interface Review {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  game: string | null;
  createdAt: string;
  username: string;
}

interface ReviewStats {
  average: string;
  count: number;
  distribution: Record<number, number>;
}

function Stars({ value, size = "text-sm" }: { value: number; size?: string }) {
  return (
    <span className={`${size} tracking-tight`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? "text-[#f5ff3b]" : "text-white/20"}>
          ★
        </span>
      ))}
    </span>
  );
}

export default function ReviewWall({ limit = 9 }: { limit?: number }) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [mine, setMine] = useState<{ submitted: boolean; status: string | null; rating: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const openReviewFlow = () => {
    // Signed-out visitors get sent to sign-in first and return to the
    // same page afterward; only signed-in users get the modal.
    if (authLoaded && !isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(pathname || "/reviews")}`);
      return;
    }
    setModalOpen(true);
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reviews?limit=${limit}&mine=1`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data.success) return;
        setReviews(data.reviews);
        setStats(data.stats);
        setMine(data.mine);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [limit]);

  if (loading) {
    return <div className="py-10 text-center text-[#c9f7ff]/50">Loading reviews…</div>;
  }

  return (
    <div>
      <div className="mb-8 flex flex-col items-center justify-between gap-6 sm:flex-row">
        {/* Aggregate */}
        <div className="flex items-center gap-6">
          <div className="text-center">
            <div className="text-5xl font-extrabold text-white">{stats?.average ?? "–"}</div>
            <Stars value={Math.round(Number(stats?.average ?? 0))} size="text-lg" />
            <div className="mt-1 text-xs text-[#c9f7ff]/50">
              {stats?.count ?? 0} review{(stats?.count ?? 0) === 1 ? "" : "s"}
            </div>
          </div>
          {/* Distribution bars */}
          <div className="w-56 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => {
              const count = stats?.distribution?.[n] ?? 0;
              const pct = stats?.count ? Math.round((count / stats.count) * 100) : 0;
              return (
                <div key={n} className="flex items-center gap-2 text-xs text-[#c9f7ff]/60">
                  <span className="w-3">{n}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-[#f5ff3b]/80" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        <button
          onClick={openReviewFlow}
          className="rounded-lg bg-gradient-to-r from-[#00e5ff] to-[#00a8cc] px-5 py-2.5 font-bold text-[#00131a] transition-transform hover:scale-[1.02]"
        >
          {mine?.submitted
            ? mine.status === "approved"
              ? "Update your review"
              : "Review pending approval"
            : "Leave a review"}
        </button>
      </div>

      {/* Review cards */}
      {reviews.length === 0 ? (
        <p className="py-8 text-center text-[#c9f7ff]/50">
          No reviews yet — be the first to share your experience.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {reviews.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-[#00e5ff]/15 bg-[#040d24]/70 p-5 backdrop-blur-sm"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <Stars value={r.rating} />
                <span className="text-[11px] text-[#c9f7ff]/40">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
              {r.title && <h3 className="mb-1 font-bold text-white">{r.title}</h3>}
              {r.body && <p className="text-sm leading-relaxed text-[#c9f7ff]/80">{r.body}</p>}
              <div className="mt-3 flex items-center gap-2 text-xs text-[#c9f7ff]/60">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#00e5ff]/20 text-[10px] font-bold text-[#00e5ff]">
                  {(r.username || "P").charAt(0).toUpperCase()}
                </span>
                <span className="font-semibold text-[#c9f7ff]/80">{r.username || "Player"}</span>
                <span className="ml-auto rounded bg-green-500/15 px-1.5 py-0.5 text-[10px] text-green-400">
                  Verified player
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <ReviewModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
