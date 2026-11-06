"use client";

// src/components/guest/GuestProgressPanel.tsx
//
// The signed-out visitor's own practice record (Phase 2F), rendered inside
// /profil's guest branch. It reads ONE endpoint — GET /api/guest/progress —
// which resolves the caller from the HMAC-signed `grynd_guest` cookie. There is
// no guest id in the request, so this panel can only ever display the visitor's
// own rows.
//
// WHAT IT DELIBERATELY DOES NOT SHOW
//
// A guest result is a private, cosmetic practice record. There is no Elo, no
// trophy, no token balance, no streak and no leaderboard position in this
// panel, because no such thing is ever written for a guest (see
// src/lib/guest/practiceProgress.ts). The account profile below is untouched:
// signed-in players see exactly what they saw before.
//
// STATE HANDLING
//
// A 401/403 is not an error — it means "no guest record in this browser yet"
// (missing or expired cookie), so the screen invites the visitor to start one.
// A real failure shows the shared ErrorState with a retry. Loading uses the
// shared skeleton, and both the account invitation and the games link stay
// visible in every state.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { IconArrowRight, IconDeviceGamepad2, IconUserCircle } from "@tabler/icons-react";
import AsyncState from "../states/AsyncState";
import StatTile from "../stats/StatTile";
import { useTranslation } from "../../hooks/useTranslation";
import {
  buildGuestGameRows,
  buildGuestHistoryRows,
  guestWinRate,
  normalizeGuestProgressResponse,
  type GuestHistoryRow,
  type GuestProgressData,
  type GuestProgressView,
} from "../../lib/guest/guestProgressView";

const ENDPOINT = "/api/guest/progress";

function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function GuestProgressPanel() {
  const { t } = useTranslation();
  const [view, setView] = useState<GuestProgressView>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setView({ status: "loading" });
      try {
        const response = await fetch(ENDPOINT, {
          // The signed guest cookie is the identity; never send it cross-site.
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        // A proxy error page is not a payload — treat unparsable bodies as
        // `null` and let the status decide the state.
        const payload = await response.json().catch(() => null);
        if (!cancelled) setView(normalizeGuestProgressResponse(response.status, payload));
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setView({ status: "error" });
      }
    }

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return (
    <section data-testid="guest-progress-panel" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#00e5ff]/40 bg-[#00e5ff]/10 text-[#00e5ff]">
            <IconUserCircle size={22} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p
              data-testid="guest-badge"
              className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#00e5ff]"
            >
              {t("guestProgress.badge", "Guest")}
            </p>
            <p className="truncate text-sm text-[#9dd8ff]/80">
              {t(
                "guestProgress.sessionNote",
                "Practice results saved in this browser — not an account, and never ranked.",
              )}
            </p>
          </div>
        </div>
        <Link
          href="/sign-up?redirect_url=/profil"
          className="shrink-0 rounded-lg border border-[#00e5ff]/40 px-3 py-2 text-xs font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
        >
          {t("guestProgress.keepProgress", "Keep my progress")}
        </Link>
      </div>

      <AsyncState
        isLoading={view.status === "loading"}
        hasData={view.status === "ready" || view.status === "no_guest"}
        error={view.status === "error" ? true : undefined}
        onRetry={retry}
        skeleton={
          <div className="space-y-4" aria-busy="true">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="h-24 animate-pulse rounded-xl bg-white/5" />
              ))}
            </div>
            <div className="h-40 animate-pulse rounded-xl bg-white/5" />
            <div className="h-32 animate-pulse rounded-xl bg-white/5" />
          </div>
        }
      >
        {view.status === "ready" ? (
          <ReadyView data={view.data} />
        ) : (
          <NoSessionView />
        )}
      </AsyncState>

      <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-white">
            {t("guestProgress.invite.title", "Want to keep your record?")}
          </p>
          <p className="mt-1 text-xs text-[#9dd8ff]/70">
            {t(
              "guestProgress.invite.body",
              "An account saves your practice results across devices and unlocks ranked play. Guest progress lives in this browser for 30 days.",
            )}
          </p>
        </div>
        <Link
          href="/sign-up?redirect_url=/profil"
          data-testid="guest-cta-signup"
          className="inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border border-[#00ffa6]/40 bg-[#00ffa6]/10 px-4 py-2 text-sm font-semibold text-[#00ffa6] transition hover:bg-[#00ffa6]/20"
        >
          {t("guestProgress.invite.cta", "Create a free account")}
          <IconArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>

      <Link
        href="/games"
        data-testid="guest-cta-games"
        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#04122b]/70 px-4 py-3 text-sm font-semibold text-white transition hover:border-[#00e5ff]/40 hover:text-[#00e5ff]"
      >
        <span className="inline-flex items-center gap-2">
          <IconDeviceGamepad2 size={18} aria-hidden="true" className="text-[#00e5ff]" />
          {t("guestProgress.discover", "Discover other GRYND games")}
        </span>
        <IconArrowRight size={16} aria-hidden="true" />
      </Link>
    </section>
  );
}

function ReadyView({ data }: { data: GuestProgressData }) {
  const { t } = useTranslation();
  const games = buildGuestGameRows(data);
  const history = buildGuestHistoryRows(data);

  if (data.totals.matches === 0) return <EmptyPracticeView />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label={t("guestProgress.totals.matches", "Matches")}
          value={formatCount(data.totals.matches)}
        />
        <StatTile
          label={t("guestProgress.totals.wins", "Wins")}
          value={formatCount(data.totals.wins)}
          tone="good"
        />
        <StatTile
          label={t("guestProgress.totals.losses", "Losses")}
          value={formatCount(data.totals.losses)}
          tone="bad"
        />
        <StatTile
          label={t("guestProgress.totals.draws", "Draws")}
          value={formatCount(data.totals.draws)}
          tone="muted"
        />
      </div>

      <section
        data-testid="guest-games"
        className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4"
      >
        <h2 className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]">
          {t("guestProgress.games.title", "By game")}
        </h2>
        <p className="mt-1 text-xs text-[#9dd8ff]/70">
          {t(
            "guestProgress.games.note",
            "Practice matches only. Values are counted from your finished games.",
          )}
        </p>

        {games.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[#9dd8ff]/70">
            {t("guestProgress.games.empty", "No finished practice matches yet.")}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-[#9dd8ff]/70">
                  <th className="py-2 pr-3 font-semibold">
                    {t("guestProgress.games.game", "Game")}
                  </th>
                  <th className="py-2 pr-3 text-right font-semibold">
                    {t("guestProgress.games.matches", "Matches")}
                  </th>
                  <th className="py-2 pr-3 text-right font-semibold">
                    {t("guestProgress.games.record", "W–L–D")}
                  </th>
                  <th className="hidden py-2 text-right font-semibold sm:table-cell">
                    {t("guestProgress.games.winRate", "Win rate")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {games.map((row) => (
                  <tr
                    key={row.gameKey}
                    data-testid={`guest-game-${row.gameKey}`}
                    className="border-t border-white/10"
                  >
                    <td className="py-2 pr-3 font-semibold text-white">{row.label}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                      {formatCount(row.matches)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-[#d8fbff]">
                      {formatCount(row.wins)}–{formatCount(row.losses)}–{formatCount(row.draws)}
                    </td>
                    <td className="hidden py-2 text-right tabular-nums text-[#d8fbff] sm:table-cell">
                      {formatRate(row.winRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        data-testid="guest-history"
        className="rounded-xl border border-[#00e5ff]/25 bg-[#04122b]/70 p-4"
      >
        <h2 className="text-sm font-bold uppercase tracking-wider text-[#00e5ff]">
          {t("guestProgress.history.title", "Recent matches")}
        </h2>

        {history.length === 0 ? (
          <p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-4 py-6 text-center text-sm text-[#9dd8ff]/70">
            {t("guestProgress.history.empty", "No practice matches yet — play one to start your record.")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {history.map((row) => (
              <HistoryRow key={row.key} row={row} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function HistoryRow({ row }: { row: GuestHistoryRow }) {
  const { t } = useTranslation();
  const tone =
    row.result === "win"
      ? "border-[#00ffa6]/50 bg-[#00ffa6]/10 text-[#00ffa6]"
      : row.result === "draw"
        ? "border-[#f5ff3b]/50 bg-[#f5ff3b]/10 text-[#f5ff3b]"
        : "border-red-400/50 bg-red-500/10 text-red-200";

  return (
    <li
      data-testid="guest-history-item"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${tone}`}
        >
          {t(`guestProgress.outcome.${row.result}`, row.result)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">{row.label}</p>
          <p className="text-xs text-[#9dd8ff]/60">
            {formatDate(row.playedAt)}
            {row.aiDifficulty
              ? ` · ${t("guestProgress.history.difficulty", { value: row.aiDifficulty })}`
              : ""}
          </p>
        </div>
      </div>
      <span className="text-xs tabular-nums text-[#9dd8ff]/60">
        {t("guestProgress.history.versusBot", "vs bot")}
      </span>
    </li>
  );
}

function EmptyPracticeView() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="guest-empty"
      className="rounded-xl border border-white/10 bg-[#04122b]/70 p-6 text-center"
    >
      <p className="text-lg font-bold text-white">
        {t("guestProgress.empty.title", "No practice matches yet")}
      </p>
      <p className="mx-auto mt-2 max-w-xl text-sm text-[#9dd8ff]/70">
        {t(
          "guestProgress.empty.body",
          "Play any free vs-AI match and it appears here — wins, losses, draws and the games you played, all kept in this browser.",
        )}
      </p>
      <Link
        href="/games"
        className="mt-4 inline-flex items-center gap-1 rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
      >
        {t("guestProgress.empty.cta", "Play a practice match")}
        <IconArrowRight size={16} aria-hidden="true" />
      </Link>
    </div>
  );
}

function NoSessionView() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="guest-no-session"
      className="rounded-xl border border-white/10 bg-[#04122b]/70 p-6 text-center"
    >
      <p className="text-lg font-bold text-white">
        {t("guestProgress.noSession.title", "No guest record in this browser")}
      </p>
      <p className="mx-auto mt-2 max-w-xl text-sm text-[#9dd8ff]/70">
        {t(
          "guestProgress.noSession.body",
          "Guest progress is stored in a signed cookie for 30 days. If it expired, was cleared, or you have not played a practice match here yet, start one and it will be saved automatically.",
        )}
      </p>
      <Link
        href="/games"
        className="mt-4 inline-flex items-center gap-1 rounded-lg border border-[#00e5ff]/40 px-4 py-2 text-sm font-semibold text-[#00e5ff] transition hover:bg-[#00e5ff]/10"
      >
        {t("guestProgress.noSession.cta", "Find a practice game")}
        <IconArrowRight size={16} aria-hidden="true" />
      </Link>
    </div>
  );
}
