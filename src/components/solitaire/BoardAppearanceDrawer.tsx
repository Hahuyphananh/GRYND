"use client";

// THE APPEARANCE DRAWER — felts, card backs and deck skins, with live previews.
//
// Everything a player can equip is previewed from the SAME catalog the board
// paints (`lib/solitaire-duel/boardThemes` + `boardCosmetics`), so a swatch can
// never show one design and equip another.
//
// Locked items are shown, not hidden: the lock is the point of the milestone
// ("Unlock at 30-day streak"), and hiding it would hide the goal. The equip
// request is still server-authoritative — a locked item posted by hand is
// refused with 403.

import { useCallback, useEffect, useState, type ReactNode } from "react";

import {
  CARD_BACKS,
  DECK_SKINS,
  boardItemStreakDay,
  cardBackFor,
  deckSkinFor,
} from "../../lib/solitaire-duel/boardCosmetics";
import { BOARD_THEMES, boardThemeFor } from "../../lib/solitaire-duel/boardThemes";
import {
  applyBoardCosmetics,
  useSolitaireBoardCosmetics,
} from "../../hooks/useSolitaireBoardCosmetics";
import { setStoredBoardTheme } from "../../hooks/useSolitaireBoardTheme";

type Slot = "felt" | "card_back" | "deck_skin";

type StreakPayload = {
  signedIn: boolean;
  streak?: { currentStreak: number; nextMilestone: { day: number } | null };
  equipped?: { felt: string; cardBack: string; deckSkin: string };
};

export default function BoardAppearanceDrawer({ label = "Appearance" }: { label?: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<StreakPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { cardBackKey, deckSkinKey } = useSolitaireBoardCosmetics();
  const [feltKey, setFeltKey] = useState<string>("felt_default");

  useEffect(() => {
    if (!open || state) return;
    fetch("/api/streaks/me", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.json().catch(() => null))
      .then((body) => {
        if (!body?.success) return;
        setState(body);
        const equipped = body.equipped;
        if (equipped) {
          setFeltKey(equipped.felt);
          applyBoardCosmetics({ cardBack: equipped.cardBack, deckSkin: equipped.deckSkin });
          setStoredBoardTheme(equipped.felt);
        }
      })
      .catch(() => setState({ signedIn: false }));
  }, [open, state]);

  const streak = state?.streak?.currentStreak ?? 0;

  const equip = useCallback(
    async (slot: Slot, itemId: string) => {
      setBusy(itemId);
      setNotice(null);
      try {
        const response = await fetch("/api/cosmetics/equip", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: itemId, category: slot }),
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) {
          setNotice(body?.error || "That item is not available yet.");
          return;
        }
        if (slot === "felt") {
          setFeltKey(itemId);
          setStoredBoardTheme(itemId);
        } else if (slot === "card_back") {
          applyBoardCosmetics({ cardBack: itemId });
        } else {
          applyBoardCosmetics({ deckSkin: itemId });
        }
        window.dispatchEvent(new Event("grynd:streak-updated"));
      } catch {
        setNotice("Could not save that choice. Try again.");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const locked = (itemId: string) => boardItemStreakDay(itemId) > streak;

  return (
    <>
      {/* The review board is wrapped in `pointer-events-none`; the drawer is
          chrome, not a move, so it opts back in and stays usable there. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="board-appearance-trigger"
        className="pointer-events-auto rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.14em] text-white/70 transition hover:bg-white/10 hover:text-white"
      >
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Board appearance"
          data-testid="board-appearance-drawer"
          className="pointer-events-auto fixed inset-0 z-[120] flex justify-end bg-black/60 backdrop-blur-xs"
          onClick={() => setOpen(false)}
        >
          <div
            className="h-full w-full max-w-sm overflow-y-auto border-l border-white/10 bg-surface p-4 text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-black tracking-tight">Board theme</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-white/15 px-2 py-1 text-xs text-white/70"
              >
                Close
              </button>
            </div>
            <p className="mt-1 text-[11px] text-white/45">
              Cosmetics only — nothing here changes how the game plays.
            </p>

            {notice && (
              <p role="status" className="mt-3 rounded-lg border border-rose-300/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
                {notice}
              </p>
            )}

            <Section title="Table felt">
              {BOARD_THEMES.map((theme) => {
                const key = theme.key;
                const isLocked = (theme.streakDay ?? 0) > streak;
                const active = boardThemeFor(feltKey).key === key;
                return (
                  <Item
                    key={key}
                    active={active}
                    locked={isLocked}
                    streakDay={theme.streakDay ?? 0}
                    label={theme.label}
                    blurb={theme.blurb}
                    busy={busy === key}
                    onPick={() => equip("felt", key)}
                    preview={
                      <span
                        className="block h-10 w-full rounded-md border border-white/10"
                        style={{ backgroundImage: theme.felt }}
                      />
                    }
                  />
                );
              })}
            </Section>

            <Section title="Card back">
              {CARD_BACKS.map((back) => {
                const isLocked = back.streakDay > streak;
                return (
                  <Item
                    key={back.key}
                    active={cardBackFor(cardBackKey).key === back.key}
                    locked={isLocked}
                    streakDay={back.streakDay}
                    label={back.label}
                    blurb={back.blurb}
                    busy={busy === back.key}
                    onPick={() => equip("card_back", back.key)}
                    preview={
                      <span
                        className="block h-10 w-8 rounded-[4px] border"
                        style={{
                          backgroundImage: back.background,
                          borderColor: back.border,
                          animation: back.animation ?? "none",
                        }}
                      />
                    }
                  />
                );
              })}
            </Section>

            <Section title="Deck skin">
              {DECK_SKINS.map((deck) => {
                const isLocked = deck.streakDay > streak;
                return (
                  <Item
                    key={deck.key}
                    active={deckSkinFor(deckSkinKey).key === deck.key}
                    locked={isLocked}
                    streakDay={deck.streakDay}
                    label={deck.label}
                    blurb={deck.blurb}
                    busy={busy === deck.key}
                    onPick={() => equip("deck_skin", deck.key)}
                    preview={
                      <span
                        className="flex h-10 w-8 items-center justify-center rounded-[4px] border bg-white text-[13px] font-black"
                        style={{ borderColor: deck.accent ?? "#c9d4e6", color: deck.accent ?? "#141a24" }}
                      >
                        K{deck.crest ?? "♠"}
                      </span>
                    }
                  />
                );
              })}
            </Section>

            {!state?.signedIn && (
              <p className="mt-4 text-[11px] text-white/45">
                Sign in to save your streak and unlock the rest.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="text-[11px] font-black uppercase tracking-[0.22em] text-cyan-200/80">{title}</h3>
      <div className="mt-2 space-y-1.5">{children}</div>
    </section>
  );
}

function Item({
  active,
  locked,
  streakDay,
  label,
  blurb,
  busy,
  preview,
  onPick,
}: {
  active: boolean;
  locked: boolean;
  streakDay: number;
  label: string;
  blurb: string;
  busy: boolean;
  preview: ReactNode;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={locked || busy}
      onClick={onPick}
      aria-pressed={active}
      title={locked ? `Unlock at ${streakDay}-day streak` : blurb}
      className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left transition ${
        active
          ? "border-cyan-300/60 bg-cyan-400/10"
          : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
      } ${locked ? "opacity-55" : ""}`}
    >
      {preview}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-bold text-white">{label}</span>
        <span className="block truncate text-[11px] text-white/45">
          {locked ? `Unlock at ${streakDay}-day streak` : blurb}
        </span>
      </span>
      <span className="text-[11px] font-black uppercase tracking-[0.12em] text-cyan-200/80">
        {locked ? "Locked" : active ? "Equipped" : busy ? "Saving…" : "Equip"}
      </span>
    </button>
  );
}
