"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { IconCloudOff, IconRefresh } from "@tabler/icons-react";
import EmptyState from "./EmptyState";
import ErrorState from "./ErrorState";
import OfflineNotice from "./OfflineNotice";
import { isOfflineError, useOnlineStatus } from "../../hooks/useOnlineStatus";
import { useTranslation } from "../../hooks/useTranslation";

type EmptyProps = {
  title?: string;
  description?: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
  icon?: ReactNode;
};

type Action = { label: string; href?: string; onClick?: () => void };

/**
 * Renders the right state for a data-driven screen:
 *
 *   1. First load (no cached data)        → `skeleton`
 *   2. Offline, no data                   → offline state
 *   3. Offline, cached data               → cached content + stale banner
 *   4. Request failed, no data            → error state with retry
 *   5. Request failed, cached data        → cached content + stale banner
 *   6. Loaded but empty                   → empty state with a create CTA
 *   7. Otherwise                          → children
 *
 * The key idea (shared with SWR's stale-while-revalidate) is that a *failed*
 * or *slow* refresh never blanks a screen that already has data — the player
 * keeps reading what we have while we retry underneath.
 *
 * Children are *only* rendered once `hasData` is true. A screen with no
 * payload must never render its data-bound children: a transient window with
 * no data, no error and nothing reported in-flight (e.g. the global
 * `mutate(() => true, undefined)` that OfflineBanner fires on reconnect
 * clears every cache entry before the refetch restarts) used to fall through
 * to `children`, so a page like /battlepass dereferenced a null model and
 * crashed the whole route into the error screen.
 *
 * Retry is automatic on reconnect; the manual button is a shortcut for when
 * the connection came back but the browser hasn't fired `online` (captive
 * portals, flaky Wi-Fi).
 */
export default function AsyncState({
  isLoading,
  error,
  hasData,
  isEmpty = false,
  onRetry,
  cachedAt,
  skeleton,
  empty,
  emptyTitle,
  emptyDescription,
  emptyAction,
  emptyIcon,
  className = "",
  children,
}: {
  isLoading: boolean;
  error?: unknown;
  hasData: boolean;
  isEmpty?: boolean;
  onRetry?: () => void | Promise<void>;
  cachedAt?: number | string | null;
  skeleton?: ReactNode;
  empty?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: Action;
  emptyIcon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { online, reconnectAt } = useOnlineStatus();
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(async () => {
    if (!onRetry) return;
    try {
      setRetrying(true);
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  // Auto-retry the moment connectivity returns.
  useEffect(() => {
    if (!reconnectAt || !onRetry) return;
    void retry();
  }, [reconnectAt, retry, onRetry]);

  const offline = !online || isOfflineError(error);

  // 1 — nothing cached yet: show the skeleton (or an offline notice if we
  // already know the device is offline).
  if (!hasData && isLoading) {
    if (!online) {
      return (
        <OfflineNotice
          className={className}
          onRetry={onRetry ? retry : undefined}
          retrying={retrying}
        />
      );
    }
    return (
      <div className={className}>
        {skeleton ?? <DefaultSkeleton />}
      </div>
    );
  }

  // 2 — no data at all. Never fall through to `children` from here: they
  // assume a payload and dereferencing a null model throws. Offline and
  // failed states get their own screen; the remaining window (no data, no
  // error, nothing reported in-flight — a cache cleared by a global
  // revalidate) shows the skeleton until the refetch lands.
  if (!hasData) {
    if (offline) {
      return (
        <OfflineNotice
          className={className}
          onRetry={onRetry ? retry : undefined}
          retrying={retrying}
        />
      );
    }
    if (error) {
      return (
        <ErrorState
          className={className}
          onRetry={onRetry ? retry : undefined}
          retrying={retrying}
        />
      );
    }
    return (
      <div className={className}>
        {skeleton ?? <DefaultSkeleton />}
      </div>
    );
  }

  // 6 — loaded, but there is nothing to show.
  if (hasData && isEmpty && !error) {
    if (empty) return <div className={className}>{empty}</div>;
    return (
      <EmptyState
        className={className}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
        icon={emptyIcon}
      />
    );
  }

  // 5 — we have data; keep showing it even if the refresh failed / went
  // offline, with a thin notice pinned above.
  return (
    <div className={className}>
      {hasData && (offline || error) && (
        <StaleBanner
          offline={offline}
          cachedAt={cachedAt}
          onRetry={onRetry ? retry : undefined}
          retrying={retrying}
          label={t("states.showingSaved", "Showing saved data")}
        />
      )}
      {children}
    </div>
  );
}

/**
 * Compact banner shown above content that is being served from cache while a
 * refresh is failing. Deliberately not a full state — the content stays.
 */
export function StaleBanner({
  offline,
  cachedAt,
  onRetry,
  retrying = false,
  label,
}: {
  offline: boolean;
  cachedAt?: number | string | null;
  onRetry?: () => void;
  retrying?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const when = formatWhen(cachedAt);

  return (
    <div
      role="status"
      className={`mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
        offline
          ? "border-[#f5ff3b]/40 bg-[#f5ff3b]/10 text-[#f5ff3b]"
          : "border-red-400/40 bg-red-950/40 text-red-200"
      }`}
    >
      <span className="inline-flex items-center gap-2">
        <IconCloudOff size={14} aria-hidden="true" />
        {label ?? t("states.showingSaved", "Showing saved data")}
        {when && <span className="opacity-75">· {when}</span>}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1 rounded-md border border-current/40 px-2 py-1 font-semibold transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          <IconRefresh size={12} aria-hidden="true" className={retrying ? "animate-spin" : undefined} />
          {retrying ? t("states.retrying", "Retrying…") : t("states.retry", "Try again")}
        </button>
      )}
    </div>
  );
}

function formatWhen(value: unknown): string | null {
  if (!value) return null;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString();
}

function DefaultSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-busy="true" aria-label="Loading" className={`space-y-2 py-2 ${className}`}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex animate-pulse items-center gap-3 rounded-md px-2 py-3">
          <div className="h-8 w-8 shrink-0 rounded-full bg-white/10" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-2/5 rounded bg-white/10" />
            <div className="h-2.5 w-1/3 rounded bg-white/5" />
          </div>
          <div className="h-4 w-12 shrink-0 rounded bg-white/10" />
        </div>
      ))}
    </div>
  );
}
