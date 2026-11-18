"use client";

// src/components/share/ShareWinButton.tsx
//
// "Share win" — the one control the winning popups grew, and only there.
//
// It renders in four places (Solo, Play vs AI, Ranked duel, the completed-game
// history) and nowhere else, because a share button on a loss is a joke at the
// player's expense. The copy it offers always names the time the run actually
// took, and the CARD it builds carries the same numbers — one source, so the
// image and the post can never disagree.
//
// THE LANGUAGE is the player's own (LanguageProvider, en/fr/es), and the game
// and mode arrive as KEYS, so a French player reads "J'ai gagné Solitaire Duel
// (Classé) en 3:42" rather than an English sentence with a French time.
//
// THE BADGE comes from the server (`/api/membership/badge`, resolved from the
// caller's own subscription rows). The client never claims a mark, so a member
// who shares a win is labelled by the same authority that labels them on the
// ladder, and a free account's post simply has no badge.
//
// THE LINK is /share/win?…, whose og:image is the generated card — so the social
// preview shows this run, not the site's generic artwork.
//
// The panel is deliberately not a modal and not a menu of accounts to connect:
// every destination is a plain compose link that opens in the player's own
// browser session, and nothing is posted unless they press send there. The card
// is a local PNG — drawn here, handed to the OS share sheet or downloaded.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  IconBrandFacebook,
  IconBrandReddit,
  IconBrandTelegram,
  IconBrandWhatsapp,
  IconBrandX,
  IconCheck,
  IconCopy,
  IconDownload,
  IconShare,
} from "@tabler/icons-react";

import { useLanguage } from "../../context/LanguageContext";
import {
  buildWinShareText,
  shareLocale,
  sharePanelCopy,
  shareWin,
  shareWinLinks,
  winShareUrl,
  type ShareLocale,
} from "../../lib/shareWin";
import {
  createWinCardDataUrl,
  winCardFile,
  winCardFilename,
} from "../../lib/shareCard";

const DESTINATION_ICONS = {
  x: IconBrandX,
  facebook: IconBrandFacebook,
  whatsapp: IconBrandWhatsapp,
  telegram: IconBrandTelegram,
  reddit: IconBrandReddit,
} as const;

export default function ShareWinButton({
  game,
  mode = null,
  durationMs = null,
  moves = null,
  url = null,
  compact = false,
  testId = "share-win",
}: {
  /** Game KEY: "solitaire" | "daily" | "duel". */
  game: string;
  /** Mode KEY: "ranked" | "practice" | "solo". Omitted for a solo run. */
  mode?: string | null;
  /** Measured finishing time, in ms — the same value the popup displays. */
  durationMs?: number | null;
  /** Accepted moves, when the surface counts them. */
  moves?: number | null;
  /** Explicit destination. Defaults to the generated share page. */
  url?: string | null;
  /** History-row size: a small "Share" pill instead of the popup's button. */
  compact?: boolean;
  testId?: string;
}) {
  const { language } = useLanguage();
  const locale: ShareLocale = shareLocale(language);
  // Every control in this panel speaks the player's language too — a French
  // post with an English "Save card" is worse than either language alone.
  const copy = sharePanelCopy(locale);

  const [open, setOpen] = useState(false);
  const [canNative, setCanNative] = useState(false);
  const [canShareCard, setCanShareCard] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [cardDataUrl, setCardDataUrl] = useState<string | null>(null);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // `navigator.share` cannot be read during render: the server has no navigator,
  // and a mismatch would break hydration. Read it once, after mount.
  useEffect(() => {
    setCanNative(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  // On first open: resolve the badge from the server, then draw the card with
  // it. Both are decorations — a failure here still leaves the text share and
  // the destination links working.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      let nextBadge: string | null = null;
      try {
        const response = await fetch("/api/membership/badge", {
          credentials: "same-origin",
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            badge?: { label?: unknown } | null;
          };
          const label = payload?.badge?.label;
          nextBadge = label === "FOUNDER" || label === "PRO" ? label : null;
        }
      } catch {
        nextBadge = null;
      }
      if (cancelled) return;

      setBadge(nextBadge);
      const dataUrl = createWinCardDataUrl(
        { game, mode, durationMs, moves, url, badge: nextBadge },
        locale,
      );
      setCardDataUrl(dataUrl);

      if (dataUrl) {
        try {
          const file = winCardFile(dataUrl, winCardFilename());
          setCanShareCard(
            Boolean(
              file &&
                typeof navigator.canShare === "function" &&
                navigator.canShare({ files: [file] }),
            ),
          );
        } catch {
          setCanShareCard(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, game, mode, durationMs, moves, url, locale]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const input = { game, mode, durationMs, moves, url };
  const text = buildWinShareText({ ...input, badge }, locale);
  const href = winShareUrl({ ...input, badge });
  const links = shareWinLinks({ ...input, badge }, href, locale);

  const handlePrimary = useCallback(async () => {
    const outcome = await shareWin({ ...input, badge }, locale);
    setStatus(
      outcome === "shared"
        ? copy.shared
        : outcome === "copied"
          ? copy.copied
          : outcome === "cancelled"
            ? null
            : copy.autoFailed,
    );
    if (outcome === "shared") setOpen(false);
  }, [game, mode, durationMs, moves, url, badge, locale, copy]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${href}`);
      setStatus(copy.copied);
    } catch {
      setStatus(copy.copyBlocked);
    }
  }, [text, href, copy]);

  const handleShareCard = useCallback(async () => {
    if (!cardDataUrl) return;
    const file = winCardFile(cardDataUrl, winCardFilename());
    if (!file) return;
    try {
      await navigator.share({ files: [file], text });
      setStatus(copy.cardShared);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setStatus(copy.cardFailed);
    }
  }, [cardDataUrl, text, copy]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={
          compact
            ? "inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-300/40 bg-emerald-300/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-300/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
            : "inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/5 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
        }
      >
        <IconShare size={compact ? 12 : 14} aria-hidden="true" />
        {compact ? copy.share : copy.shareWin}
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={copy.groupWin}
          data-testid={`${testId}-panel`}
          className="absolute bottom-full left-1/2 z-20 mb-2 w-72 -translate-x-1/2 rounded-xl border border-white/15 bg-page p-3 text-left shadow-2xl"
        >
          {/* Exactly what will be posted, badge and time included, so nothing is
              shared sight-unseen. */}
          <p
            data-testid={`${testId}-text`}
            className="text-[11px] leading-relaxed text-slate-300"
          >
            {text}
          </p>

          {/* The image card. Built locally from the same numbers; nothing is
              uploaded to make it. */}
          {cardDataUrl && (
            <div className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cardDataUrl}
                alt={`Win card: ${text}`}
                data-testid={`${testId}-card`}
                width={1200}
                height={630}
                className="w-full rounded-lg border border-white/10"
              />
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <a
                  href={cardDataUrl}
                  download={winCardFilename()}
                  data-testid={`${testId}-card-save`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  <IconDownload size={13} aria-hidden="true" />
                  {copy.saveCard}
                </a>
                {canShareCard && (
                  <button
                    type="button"
                    onClick={handleShareCard}
                    data-testid={`${testId}-card-share`}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                  >
                    <IconShare size={13} aria-hidden="true" />
                    {copy.shareImage}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {links.map((link) => {
              const Icon = DESTINATION_ICONS[link.id];
              return (
                <a
                  key={link.id}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={`${testId}-${link.id}`}
                  onClick={() => setStatus(null)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  <Icon size={13} aria-hidden="true" />
                  {link.label}
                </a>
              );
            })}
            <button
              type="button"
              onClick={handleCopy}
              data-testid={`${testId}-copy`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <IconCopy size={13} aria-hidden="true" />
              {copy.copy}
            </button>
          </div>

          {canNative && (
            <button
              type="button"
              onClick={handlePrimary}
              data-testid={`${testId}-native`}
              className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <IconCheck size={13} aria-hidden="true" />
              {copy.native}
            </button>
          )}

          <p
            aria-live="polite"
            className="mt-1.5 min-h-[14px] text-[10px] text-emerald-300"
          >
            {status ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}
