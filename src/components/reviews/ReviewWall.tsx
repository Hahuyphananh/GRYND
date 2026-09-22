"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useRouter, usePathname } from "next/navigation";
import ReviewModal from "./ReviewModal";
import IconAvatar from "../IconAvatar";
import ErrorState from "../states/ErrorState";
import { useApiResource } from "../../hooks/useApiResource";

interface Review {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  game: string | null;
  createdAt: string;
  username: string;
  iconKey: string | null;
}

interface ReviewStats {
  average: string;
  count: number;
  distribution: Record<number, number>;
}

/**
 * Review dates must render identically on the server and in the browser.
 *
 * `new Date(iso).toLocaleDateString()` uses whatever locale the runtime
 * happens to have — Node's ICU default gave "2026-08-23" while the browser gave
 * "23/08/2026" — and React treats that differing text as a hydration mismatch
 * and re-renders the tree on the client. Pinning both the locale and the
 * timezone makes the string deterministic, so the card a crawler receives is
 * the card a visitor sees.
 */
const REVIEW_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const formatReviewDate = (iso: string) => REVIEW_DATE_FORMAT.format(new Date(iso));

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

/**
 * The public review wall.
 *
 * `initialReviews` / `initialStats` come from the server render of
 * /reviews, so the reviews and the rating totals are in the HTML a crawler
 * receives without executing any JavaScript. When they are present the wall
 * renders immediately instead of showing a loading state, and the mount fetch
 * only refreshes what it can (the caller's own review status). When they are
 * absent — the client-only call sites, or a failed server-side load — the wall
 * behaves exactly as it always has.
 */
export default function ReviewWall({
  limit = 9,
  initialReviews = null,
  initialStats = null,
}: {
  limit?: number;
  initialReviews?: Review[] | null;
  initialStats?: ReviewStats | null;
}) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [reviews, setReviews] = useState<Review[]>(initialReviews ?? []);
  const [stats, setStats] = useState<ReviewStats | null>(initialStats);
  const [mine, setMine] = useState<{ submitted: boolean; status: string | null; rating: number | null } | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Cache-first load; the server-rendered reviews (initialReviews) stay on
  // screen while this refreshes in the background, so a slow or offline
  // network never blanks the wall.
  const resource = useApiResource<{
    success: boolean;
    reviews: Review[];
    stats: ReviewStats;
    mine: { submitted: boolean; status: string | null; rating: number | null };
  }>(`/api/reviews?limit=${limit}&mine=1`);

  const loading = initialReviews === null && resource.isLoading;

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
    const data = resource.data;
    if (!data?.success) return;
    if (Array.isArray(data.reviews)) setReviews(data.reviews);
    if (data.stats) setStats(data.stats);
    setMine(data.mine ?? null);
  }, [resource.data]);

  // The server already rendered the wall's content (see initialReviews), so
  // never replace it with a loading placeholder.

  if (loading) {
    return <div className="py-10 text-center text-[#c9f7ff]/50">Loading reviews…</div>;
  }

  // The wall has nothing to show and the request failed — offer a retry
  // instead of silently rendering the empty state (which would read as
  // "nobody has reviewed us yet").
  if (resource.error && reviews.length === 0) {
    return (
      <ErrorState
        title="Reviews couldn't load"
        description="We couldn't fetch the reviews just now. Give it another try."
        onRetry={resource.refresh}
      />
    );
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
                {/* <time> keeps the exact instant machine-readable (and
                    stable) while the visible label stays deterministic. */}
                <time
                  dateTime={r.createdAt}
                  className="text-[11px] text-[#c9f7ff]/40"
                >
                  {formatReviewDate(r.createdAt)}
                </time>
              </div>
              {r.title && <h3 className="mb-1 font-bold text-white">{r.title}</h3>}
              {r.body && <p className="text-sm leading-relaxed text-[#c9f7ff]/80">{r.body}</p>}
              <div className="mt-3 flex items-center gap-2 text-xs text-[#c9f7ff]/60">
                <IconAvatar
                  iconKey={r.iconKey}
                  name={r.username}
                  size="h-6 w-6"
                />
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
