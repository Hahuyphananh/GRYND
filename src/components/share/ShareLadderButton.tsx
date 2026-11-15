"use client";

// src/components/share/ShareLadderButton.tsx
//
// THE PODIUM'S SHARE ENTRY.
//
// A player who placed on the weekly board can say so — and only their OWN card
// carries the control: sharing somebody else's rank would be putting words in
// their mouth, and the board is public data they did not choose to broadcast.
//
// Rank and points are the row the leaderboard rendered (the server's numbers),
// never recomputed here. Sits beside the podium card rather than inside it,
// because that card is a link to the profile and a button may not nest in one.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IconBrandFacebook,
  IconBrandReddit,
  IconBrandTelegram,
  IconBrandWhatsapp,
  IconBrandX,
  IconCheck,
  IconCopy,
  IconShare,
} from "@tabler/icons-react";

import { useLanguage } from "../../context/LanguageContext";
import {
  buildLadderShareText,
  ladderShareUrl,
  shareDestinations,
  shareLocale,
  sharePanelCopy,
  type ShareLocale,
} from "../../lib/shareWin";

const DESTINATION_ICONS = {
  x: IconBrandX,
  facebook: IconBrandFacebook,
  whatsapp: IconBrandWhatsapp,
  telegram: IconBrandTelegram,
  reddit: IconBrandReddit,
} as const;

export default function ShareLadderButton({
  rank,
  score = null,
  testId = "leaderboard-share",
}: {
  /** 1-based position on the board, as the server ranked it. */
  rank: number;
  /** The points/trophies the position is built on. */
  score?: number | null;
  testId?: string;
}) {
  const { language } = useLanguage();
  const locale: ShareLocale = shareLocale(language);
  const copy = sharePanelCopy(locale);

  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [canNative, setCanNative] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCanNative(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

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

  const text = buildLadderShareText({ rank, score }, locale);
  const href = ladderShareUrl();
  if (!text) return null;
  const links = shareDestinations(text, href);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`${text} ${href}`);
      setStatus(copy.copied);
    } catch {
      setStatus(copy.copyBlocked);
    }
  };

  const handleNative = useCallback(async () => {
    try {
      await navigator.share({ title: "GRYND", text: `${text} ${href}`, url: href });
      setStatus(copy.shared);
      setOpen(false);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      setStatus(copy.autoFailed);
    }
  }, [text, href, copy]);

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        type="button"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center justify-center gap-1 rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-[#00e5ff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        <IconShare size={11} aria-hidden="true" />
        {copy.share}
      </button>

      {open && (
        <div
          role="group"
          aria-label={copy.groupWin}
          data-testid={`${testId}-panel`}
          className="absolute top-full left-1/2 z-20 mt-2 w-72 -translate-x-1/2 rounded-xl border border-white/15 bg-slate-900 p-3 text-left shadow-2xl"
        >
          <p data-testid={`${testId}-text`} className="text-[11px] leading-relaxed text-slate-300">
            {text}
          </p>

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
              onClick={handleNative}
              data-testid={`${testId}-native`}
              className="mt-1.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-2.5 py-1.5 text-[11px] font-bold text-slate-950 transition hover:bg-emerald-400 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-emerald-300"
            >
              <IconCheck size={13} aria-hidden="true" />
              {copy.native}
            </button>
          )}

          <p aria-live="polite" className="mt-1.5 min-h-[14px] text-[10px] text-emerald-300">
            {status ?? ""}
          </p>
        </div>
      )}
    </div>
  );
}
