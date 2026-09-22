"use client";

import { IconCloudOff, IconRefresh } from "@tabler/icons-react";
import StateShell, { stateSecondaryAction } from "./StateShell";
import { useTranslation } from "../../hooks/useTranslation";

function formatCachedAt(value: unknown): string | null {
  if (!value) return null;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Inline offline state for a screen whose data can't be fetched because the
 * device is offline.
 *
 * When the screen still has a cached payload, pass `cachedAt` and keep
 * rendering it — this notice becomes a banner above the content instead of a
 * full replacement (see `<AsyncState>`). Retrying happens automatically when
 * the connection returns, so the manual retry is only a shortcut.
 */
export default function OfflineNotice({
  onRetry,
  retrying = false,
  cachedAt,
  className,
}: {
  onRetry?: () => void;
  retrying?: boolean;
  cachedAt?: number | string | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const cachedLabel = formatCachedAt(cachedAt);

  return (
    <StateShell
      className={className}
      tone="warning"
      icon={<IconCloudOff size={24} aria-hidden="true" />}
      title={t("states.offlineTitle", "You're offline")}
      description={
        cachedLabel
          ? t("states.offlineCached", { when: cachedLabel })
          : t(
              "states.offlineDescription",
              "We can't reach the server right now. We'll retry automatically as soon as you're back online.",
            )
      }
    >
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          aria-busy={retrying || undefined}
          className={stateSecondaryAction}
        >
          <IconRefresh
            size={16}
            aria-hidden="true"
            className={retrying ? "animate-spin" : undefined}
          />
          {retrying
            ? t("states.retrying", "Retrying…")
            : t("states.retryNow", "Retry now")}
        </button>
      )}
    </StateShell>
  );
}

export { formatCachedAt };
