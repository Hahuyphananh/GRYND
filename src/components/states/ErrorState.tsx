"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react";
import StateShell, { stateSecondaryAction } from "./StateShell";
import { useTranslation } from "../../hooks/useTranslation";

/**
 * Error state: something we asked for failed.
 *
 * Say what failed (name the thing, not "an error occurred") and give a retry.
 * A retry that spins while the request is in flight is important — otherwise
 * the second tap looks like it did nothing.
 */
export default function ErrorState({
  title,
  description,
  onRetry,
  retrying = false,
  retryLabel,
  homeHref,
  className,
}: {
  title?: string;
  description?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  /** Optional escape hatch so a hard failure is never a trap. */
  homeHref?: string;
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <StateShell
      className={className}
      tone="danger"
      live="assertive"
      icon={<IconAlertTriangle size={24} aria-hidden="true" />}
      title={title ?? t("states.errorTitle", "We couldn't load this")}
      description={
        description ??
        t(
          "states.errorDescription",
          "Something went wrong on our end. Check your connection and try again.",
        )
      }
    >
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
          className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-300/50 bg-red-500/20 px-5 py-2.5 text-sm font-semibold text-red-100 transition-colors hover:bg-red-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a0b16] active:scale-95 disabled:opacity-60"
        >
          <IconRefresh
            size={16}
            aria-hidden="true"
            className={retrying ? "animate-spin" : undefined}
          />
          {retryLabel ?? t("states.retry", "Try again")}
        </button>
      )}
      {homeHref && (
        <Link href={homeHref} className={stateSecondaryAction}>
          {t("states.backHome", "Back to home")}
        </Link>
      )}
    </StateShell>
  );
}
