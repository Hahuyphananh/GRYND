"use client";

// ── Precision: the phase panel of the match page ─────────────────────────
//
// One component decides WHICH phase UI is on screen, from the server snapshot
// alone:
//
//   missing   → the "this game is no longer running" panel,
//   waiting   → the shared waiting room,
//   ready_up  → the ready-up room,
//   arming    → <PrecisionArmedPanel>,          (recap + countdown)
//   active    → <PrecisionActiveRoundPanel>,    (live round + STOP)
//   finished  → <PrecisionFinishedPanel>        (under the result popup)
//
// The transitions between the four raced phases are wrapped in
// `<AnimatePresence mode="wait">` so a round can only ever hand over to the
// next one through one animation — never with two rounds mounted at once.
//
// All gameplay state arrives as props; this component derives only the
// presentation-level booleans from the snapshot.

import { AnimatePresence, motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { IconAlertTriangle } from "@tabler/icons-react";

import MatchWaiting from "../lobby/MatchWaiting";
import { useTranslation } from "../../hooks/useTranslation";
import { fadeUp } from "../../lib/animations";
import type { PrecisionLookup } from "../../hooks/usePrecisionMatchState";
import type { RoundStopsSummary } from "../../lib/precision/matchView";
import type { PlayerSeat, PrecisionPlayer, PrecisionState } from "../../lib/precision/types";
import type { PrecisionRank } from "../../lib/precision/utils";
import type { RocketLane } from "./PrecisionRocketRace";
import type { PrecisionEmote } from "./PrecisionActiveRoundPanel";
import PrecisionArmedPanel from "./PrecisionArmedPanel";
import PrecisionActiveRoundPanel from "./PrecisionActiveRoundPanel";
import PrecisionFinishedPanel from "./PrecisionFinishedPanel";
import PrecisionReadyRoom from "./PrecisionReadyRoom";

export interface PrecisionMatchPhasesProps {
  matchId: string;
  state: PrecisionState | null;
  lookup: PrecisionLookup;
  players: PrecisionPlayer[];
  localSeat: PlayerSeat;
  /** Optimistic local Ready flag (server truth is OR'd in below). */
  selfReady: boolean;
  readySubmitting: boolean;
  onReadyClick: () => void;
  onLeave: () => void;
  onResign: () => void;
  onStopClick: () => void;
  selfStopPending: boolean;
  stopSubmitting: boolean;
  awaitingOpponentStop: boolean;
  boardStops: RoundStopsSummary | null;
  countdownMs: number | null;
  timerMs: number;
  liveTargetMs: number | null;
  previewRank: PrecisionRank | null;
  raceLanes: (recap: boolean) => [RocketLane, RocketLane];
  incomingEmote: PrecisionEmote;
  myEmote: PrecisionEmote;
  sendEmote: (emote: PrecisionEmote) => void;
}

export default function PrecisionMatchPhases({
  matchId,
  state,
  lookup,
  players,
  localSeat,
  selfReady,
  readySubmitting,
  onReadyClick,
  onLeave,
  onResign,
  onStopClick,
  selfStopPending,
  stopSubmitting,
  awaitingOpponentStop,
  boardStops,
  countdownMs,
  timerMs,
  liveTargetMs,
  previewRank,
  raceLanes,
  incomingEmote,
  myEmote,
  sendEmote,
}: PrecisionMatchPhasesProps) {
  const { t } = useTranslation();
  const router = useRouter();

  // The server holds nothing for this id and we never received a snapshot:
  // render the "unavailable" panel instead of a waiting room that can never
  // progress.
  const matchMissing = lookup === "missing" && !state;
  const showWaiting =
    !matchMissing && (!state || state.phase === "waiting" || state.phase === "starting");
  const showReadyRoom = state?.phase === "ready_up";
  const showArming = state?.phase === "arming";
  const showActive = state?.phase === "active";
  const showFinished = state?.phase === "finished";

  const score = state?.score ?? { seat1: 0, seat2: 0 };
  const currentRound = state?.currentRound ?? 1;
  const lastRoundWinnerSeat = state?.lastRoundWinnerSeat ?? null;

  const hostName = players.find((p) => p.seat === 1)?.name ?? "Host";
  const isHost = players[0]?.seat === localSeat;
  // Derive selfReady from server truth whenever we have one — the optimistic
  // flag is only a hint for the brief window between click and response.
  const selfPlayer = players.find((p) => p.seat === localSeat) ?? null;
  const effectiveSelfReady = selfReady || selfPlayer?.isReady === true;

  return (
    <>
      {matchMissing && (
        <motion.div
          key="match-missing"
          {...fadeUp}
          data-testid="precision-match-unavailable"
          className="mt-6 rounded-2xl border border-red-400/40 bg-red-500/10 p-6 text-center sm:p-8"
        >
          <p className="text-4xl">
            <IconAlertTriangle className="mx-auto text-red-300" size={40} />
          </p>
          <h2 className="mt-3 text-2xl font-black text-red-200 sm:text-3xl">
            {t("games.precision.match_unavailable")}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-red-100/90">
            This game is no longer running — it finished, was cancelled, or a player left. Nothing
            is waiting for you on this link. Start a fresh duel below.
          </p>
          <button
            onClick={() => router.push("/casino/precision")}
            className="mt-5 rounded-xl bg-[#f5ff3b] px-6 py-3 font-black text-black transition hover:brightness-110"
          >
            {t("games.precision.lobby_button")}
          </button>
        </motion.div>
      )}

      {showWaiting && (
        <MatchWaiting
          state="waiting"
          gameName="Precision"
          subtitle={`Hosted by ${hostName} · ${(state?.wager ?? 0).toLocaleString()} stake`}
          seats={[
            {
              label: "Alpha",
              name: players.find((p) => p.seat === 1)?.name,
              occupied: Boolean(players.find((p) => p.seat === 1)),
            },
            {
              label: "Bravo",
              name: players.find((p) => p.seat === 2)?.name,
              occupied: Boolean(players.find((p) => p.seat === 2)),
            },
          ]}
          onCancel={isHost ? onLeave : null}
          cancelLabel={t("games.precision.cancel_lobby")}
          onLeave={onLeave}
          copyCode={matchId}
        />
      )}

      <AnimatePresence mode="wait" initial={false}>
        {showReadyRoom && (
          <motion.div key="phase-ready" {...fadeUp}>
            <PrecisionReadyRoom
              matchId={matchId}
              players={players}
              wager={state?.wager ?? 0}
              selfReady={effectiveSelfReady}
              readySubmitting={readySubmitting}
              onReadyClick={onReadyClick}
              onLeave={onLeave}
            />
          </motion.div>
        )}

        {showArming && state && (
          <PrecisionArmedPanel
            state={state}
            players={players}
            score={score}
            currentRound={currentRound}
            lastRoundWinnerSeat={lastRoundWinnerSeat}
            localSeat={localSeat}
            countdownMs={countdownMs}
            raceLanes={raceLanes}
            onResign={onResign}
          />
        )}

        {showActive && state && (
          <PrecisionActiveRoundPanel
            state={state}
            players={players}
            score={score}
            currentRound={currentRound}
            lastRoundWinnerSeat={lastRoundWinnerSeat}
            localSeat={localSeat}
            boardStops={boardStops}
            awaitingOpponentStop={awaitingOpponentStop}
            timerMs={timerMs}
            liveTargetMs={liveTargetMs}
            previewRank={previewRank}
            raceLanes={raceLanes}
            selfStopPending={selfStopPending}
            stopSubmitting={stopSubmitting}
            onStopClick={onStopClick}
            onResign={onResign}
            incomingEmote={incomingEmote}
            myEmote={myEmote}
            sendEmote={sendEmote}
          />
        )}

        {showFinished && state && (
          <PrecisionFinishedPanel
            state={state}
            players={players}
            score={state.score}
            currentRound={currentRound}
            lastRoundWinnerSeat={lastRoundWinnerSeat}
          />
        )}
      </AnimatePresence>
    </>
  );
}
