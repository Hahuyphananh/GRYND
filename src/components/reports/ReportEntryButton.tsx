"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { IconFlag } from "@tabler/icons-react";
import ReportModal, { type ReportReason } from "../ReportModal";

/**
 * A flag button for a single public entry (a leaderboard row or a review card).
 *
 * WHY THIS EXISTS: the username filter and the review queue stop most abuse
 * before publication, but they are first-line only — the leaderboard renders
 * whatever is in the users table, and an approved review is approved forever.
 * This is the backstop: any visitor can flag an entry, and the report lands in
 * the same player_reports queue the in-game report buttons already feed (see
 * /api/reports/submit), so moderation has one place to work from.
 *
 * It is deliberately a shared component rather than three copies of the same
 * modal plumbing — the leaderboard, the full ranking page and the review wall
 * must not drift apart on what a report sends.
 */
interface ReportEntryButtonProps {
  /** Clerk id of the player the report is about. Required — a report with no target is not a report. */
  reportedClerkId: string | null | undefined;
  /** Display name shown in the modal. */
  reportedPlayerName: string;
  /** Where the entry came from, e.g. "Leaderboard" or "Review". Becomes the report's game_type. */
  gameType: string;
  /** Human label for the modal copy, e.g. "Leaderboard entry". */
  contextLabel: string;
  /** Optional content id (e.g. the review id) so duplicate reports are scoped to this entry. */
  gameId?: string | number | null;
  className?: string;
  /** Show a "Report" label next to the icon (defaults to icon-only). */
  showLabel?: boolean;
}

export default function ReportEntryButton({
  reportedClerkId,
  reportedPlayerName,
  gameType,
  contextLabel,
  gameId = null,
  className = "",
  showLabel = false,
}: ReportEntryButtonProps) {
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Nothing to report against — render nothing rather than a button that would
  // fail server-side validation.
  if (!reportedClerkId) return null;

  const handleOpen = () => {
    // Reporting requires an account (the API rejects anonymous reports), so
    // send signed-out visitors to sign-in first and bring them back here.
    if (authLoaded && !isSignedIn) {
      router.push(`/sign-in?redirect_url=${encodeURIComponent(pathname || "/")}`);
      return;
    }
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        title={`Report this ${contextLabel.toLowerCase()}`}
        aria-label={`Report ${reportedPlayerName} from ${contextLabel}`}
        className={`inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-semibold text-slate-300 transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 ${className}`}
      >
        <IconFlag size={13} aria-hidden />
        {showLabel && <span>Report</span>}
      </button>

      <ReportModal
        isOpen={open}
        onClose={() => setOpen(false)}
        onSubmit={async (reason: ReportReason, details: string) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId,
              gameType,
              gameId,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json().catch(() => null);
          if (!data?.success) {
            throw new Error(data?.error || "Failed to submit report");
          }
        }}
        reportedPlayerName={reportedPlayerName}
        gameType={contextLabel}
      />
    </>
  );
}
