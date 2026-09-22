"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { IconCloudOff, IconRefresh, IconWifi } from "@tabler/icons-react";
import { useOnlineStatus } from "../../hooks/useOnlineStatus";
import { useTranslation } from "../../hooks/useTranslation";
import { withReducedMotion } from "../../lib/animations";

const BACK_ONLINE_MS = 2600;

/**
 * Global connectivity banner, mounted once for the whole app.
 *
 * While offline every screen keeps rendering whatever it has cached; this
 * banner is the one always-visible signal that the data may be stale. On
 * reconnect it revalidates every SWR key at once and asks the router to
 * refresh server components — that is the "retry automatically on
 * reconnect" half of the offline contract, and it means individual screens
 * don't each need a reconnect listener.
 *
 * Positioned top-centre as a floating pill so it never covers the fixed
 * navigation's logo (left) or its actions (right).
 */
export default function OfflineBanner() {
  const { online, reconnectAt } = useOnlineStatus();
  const { t } = useTranslation();
  const router = useRouter();
  const shouldReduce = useReducedMotion();
  const [showBackOnline, setShowBackOnline] = useState(false);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setShowBackOnline(false);
      return;
    }

    if (!wasOffline.current) return;
    wasOffline.current = false;

    // Connection is back: refresh everything we can reach.
    void mutate(() => true, undefined, { revalidate: true });
    try {
      router.refresh();
    } catch {
      // router.refresh is best-effort.
    }

    setShowBackOnline(true);
    const timer = setTimeout(() => setShowBackOnline(false), BACK_ONLINE_MS);
    return () => clearTimeout(timer);
  }, [online, reconnectAt, router]);

  const visible = !online || showBackOnline;
  const motionProps = withReducedMotion(shouldReduce, {
    initial: { opacity: 0, y: -12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
    transition: { duration: 0.22, ease: "easeOut" as const },
  });

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          {...motionProps}
          role="status"
          aria-live="polite"
          className={`fixed left-1/2 top-2 z-[70] -translate-x-1/2 rounded-full border px-3.5 py-1.5 text-xs font-semibold shadow-[0_0_24px_rgba(0,0,0,0.4)] backdrop-blur-md ${
            online
              ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-200"
              : "border-[#f5ff3b]/50 bg-[#08142f]/95 text-[#f5ff3b]"
          }`}
        >
          <span className="inline-flex items-center gap-2">
            {online ? (
              <IconWifi size={14} aria-hidden="true" />
            ) : (
              <IconCloudOff size={14} aria-hidden="true" />
            )}
            {online
              ? t("states.backOnline", "Back online — refreshing")
              : t("states.bannerOffline", "You're offline — showing saved data")}
            {!online && (
              <button
                type="button"
                onClick={() => {
                  void mutate(() => true, undefined, { revalidate: true });
                  try {
                    router.refresh();
                  } catch {
                    // best-effort
                  }
                }}
                aria-label={t("states.retryNow", "Retry now")}
                className="rounded-full p-0.5 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
              >
                <IconRefresh size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
