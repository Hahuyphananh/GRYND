"use client";

// src/components/share/ShareProBadgeButton.tsx
//
// THE MEMBER'S OWN MARK, SHAREABLE.
//
// The ladder badge is seen by other players inside the app; this is how a
// founder tells people outside it. It renders NOTHING for a free account: the
// label is fetched from /api/membership/badge, which resolves the caller's own
// subscription rows, so the button cannot exist without the mark behind it.
//
// Same shape as ShareWinButton (preview → card → destinations → copy), and the
// same rule: every destination is a compose link, nothing is posted for the
// player. The card is drawn locally, so sharing the mark costs one request (the
// badge) and no upload.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBrandFacebook,
  IconBrandReddit,
  IconBrandTelegram,
  IconBrandWhatsapp,
  IconBrandX,
  IconCopy,
  IconDownload,
  IconShare,
} from "@tabler/icons-react";

import { useLanguage } from "../../context/LanguageContext";
import {
  buildMemberShareText,
  memberShareUrl,
  shareDestinations,
  shareLocale,
  sharePanelCopy,
  type ShareLocale,
} from "../../lib/shareWin";
import {
  createMemberCardDataUrl,
  memberCardFilename,
  winCardFile,
} from "../../lib/shareCard";

const DESTINATION_ICONS = {
  x: IconBrandX,
  facebook: IconBrandFacebook,
  whatsapp: IconBrandWhatsapp,
  telegram: IconBrandTelegram,
  reddit: IconBrandReddit,
} as const;

export default function ShareProBadgeButton({
  testId = "profile-share-pro",
}: {
  testId?: string;
}) {
  const { language } = useLanguage();
  const locale: ShareLocale = shareLocale(language);
  const copy = sharePanelCopy(locale);

  const [badge, setBadge] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [cardDataUrl, setCardDataUrl] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Resolve the mark once. A guest or a free account simply gets null, and the
  // component renders nothing at all.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let label: string | null = null;
      try {
        const response = await fetch("/api/membership/badge", {
          credentials: "same-origin",
        });
        if (response.ok) {
          const payload = (await response.json()) as {
            badge?: { label?: unknown } | null;
          };
          const value = payload?.badge?.label;
          label = value === "FOUNDER" || value === "PRO" ? value : null;
        }
      } catch {
        label = null;
      }
      if (cancelled) return;
      setBadge(label);
      setLoaded(true);
      if (label) setCardDataUrl(createMemberCardDataUrl(label, locale));
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const text = buildMemberShareText(badge, locale) ?? "";
  const href = memberShareUrl();
  const links = shareDestinations(text, href);

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
    const file = winCardFile(cardDataUrl, memberCardFilename());
    if (!file) return;
    try {
      await navigator.share({ files: [file], text });
      setStatus(copy.cardShared);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setStatus(copy.cardFailed);
    }
  }, [cardDataUrl, text, copy]);

  if (!loaded || !badge) return null;

  return (
    <div ref={wrapperRef} className="relative flex justify-center">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300/40 bg-emerald-300/10 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-300/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
      >
        <IconShare size={14} aria-hidden="true" />
        {copy.shareBadge}
      </button>

      {open && (
        <div
          role="group"
          aria-label={copy.groupBadge}
          data-testid={`${testId}-panel`}
          className="absolute top-full left-1/2 z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border border-white/15 bg-page p-3 text-left shadow-2xl"
        >
          <p data-testid={`${testId}-text`} className="text-[11px] leading-relaxed text-slate-300">
            {text}
          </p>

          {cardDataUrl && (
            <div className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cardDataUrl}
                alt={text}
                data-testid={`${testId}-card`}
                width={1200}
                height={630}
                className="w-full rounded-lg border border-white/10"
              />
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <a
                  href={cardDataUrl}
                  download={memberCardFilename()}
                  data-testid={`${testId}-card-save`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  <IconDownload size={13} aria-hidden="true" />
                  {copy.saveCard}
                </a>
                <button
                  type="button"
                  onClick={handleShareCard}
                  data-testid={`${testId}-card-share`}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:border-white/25 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
                >
                  <IconShare size={13} aria-hidden="true" />
                  {copy.shareImage}
                </button>
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

          <p aria-live="polite" className="mt-1.5 min-h-[14px] text-[11px] text-emerald-300">
            {status ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}
