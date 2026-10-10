"use client";

// src/app/casino/barricade/play-ai/PageClient.tsx
//
// Barricade — free practice against the bot.
//
// There is no match row, no wager and no rating here: the whole match lives in
// one React state value shaped by `src/lib/barricade/rules.ts`, and the bot is a
// pure function of that same state (`src/lib/barricade/ai.ts`). Free play is
// deliberately client-side — a practice game cannot fail because a socket,
// a database or a second human is unavailable.
//
// THE UI OWNS NO RULES. Every destination that lights up came from the engine's
// `legalMoves`; every barricade click is checked by `classifyWall` before it is
// applied through `applyAction`; the goal rows come from `goalRowFor`; the win
// and loss come from the engine's `winner`. The board component only draws the
// position it is handed.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  IconArrowLeft,
  IconArrowsHorizontal,
  IconArrowsVertical,
  IconBallpen,
  IconHelpCircle,
  IconPlayerPlay,
  IconRefresh,
  IconRobot,
  IconUsers,
  IconWall,
} from "@tabler/icons-react";

import NavigationBar from "../../../../components/navigation-bar";
import FrameAvatar from "../../../../components/FrameAvatar";
import GameSessionHost from "../../../../components/GameSessionHost";
import PvpResultScreen from "../../../../components/result/PvpResultScreen";
import AiDifficultyPicker from "../../../../components/lobby/AiDifficultyPicker";
import BarricadeBoard, { type BarricadePreview } from "../../../../components/barricade/BarricadeBoard";
import useMySeatIdentity from "../../../../hooks/useMySeatIdentity";
import { BARRICADE_TIER_HINTS, chooseAiAction } from "../../../../lib/barricade/ai";
import { MOVE_KINDS, ORIENTATIONS } from "../../../../lib/barricade/constants";
import {
  BarricadeRuleError,
  applyAction,
  classifyWall,
  createInitialState,
  goalRowFor,
  isMatchFinished,
  legalMoves,
  legalWalls,
  wallKey,
} from "../../../../lib/barricade/rules";
import type {
  BarricadeAction,
  BarricadeState,
  MoveKind,
  Orientation,
  Position,
  Seat,
  WallPlacement,
} from "../../../../lib/barricade/types";
import { readStoredAiDifficulty, storeAiDifficulty, type AiDifficulty } from "../../../../lib/aiDifficulty";
import {
  playBarricadeJump,
  playBarricadeLoss,
  playBarricadeNewGame,
  playBarricadeReject,
  playBarricadeStep,
  playBarricadeWall,
  playBarricadeWin,
} from "../../../../lib/barricadeAudio";

/** The human always holds the first seat (and therefore the first move). */
const HUMAN_SEAT: Seat = "player1";
const AI_SEAT: Seat = "player2";
/** A short beat before the bot answers, so its move reads as a turn. */
const AI_THINK_DELAY_MS = 480;
const LOBBY_PATH = "/casino";
/**
 * The online 1v1 lobby — the other half of the game, one click away. The
 * CANONICAL form matters here: bare `/casino/barricade` permanently redirects to
 * the public landing page `/games/barricade`, and Barricade has no landing page
 * yet (its catalogue entry is a separate, later change), so that URL would 404.
 * `/games/barricade/play` is the lobby itself — the same shape every other game
 * uses — and it is rewritten to `/casino/barricade` internally.
 */
const ONLINE_PATH = "/games/barricade/play";

/** One cue per accepted action, keyed on what the engine actually did. */
function playMoveSound(kind: MoveKind, mine: boolean) {
  if (kind === MOVE_KINDS.STEP) playBarricadeStep(mine);
  else playBarricadeJump(kind === MOVE_KINDS.JUMP_DIAGONAL, mine);
}

export default function BarricadePracticePage() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  // Real username / official icon / equipped colour for the human seat — a
  // client-side game has no server match payload to carry it.
  const myIdentity = useMySeatIdentity();

  const [state, setState] = useState<BarricadeState>(() => createInitialState());
  const [difficulty, setDifficulty] = useState<AiDifficulty>(() =>
    readStoredAiDifficulty("barricade"),
  );
  const [wallMode, setWallMode] = useState(false);
  const [orientation, setOrientation] = useState<Orientation>(ORIENTATIONS[0]);
  const [hovered, setHovered] = useState<WallPlacement | null>(null);
  const [legalWallKeys, setLegalWallKeys] = useState<ReadonlySet<string> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [score, setScore] = useState({ wins: 0, losses: 0 });

  const epochRef = useRef(0);
  const resultSoundedRef = useRef<number | null>(null);

  const matchOver = isMatchFinished(state);
  const myTurn = !matchOver && state.turn === HUMAN_SEAT;
  const canPlay = myTurn && !aiThinking;

  // The engine's move menu for the seat that owns the turn (the human's, unless
  // the bot is answering).
  const moves = useMemo(() => legalMoves(state, state.turn), [state]);

  const preview: BarricadePreview | null = useMemo(() => {
    if (!hovered) return null;
    // The engine answers "could this barricade be placed?" — the UI only wraps
    // the verdict for display.
    const verdict = classifyWall(state, HUMAN_SEAT, hovered);
    if (verdict.ok === false) return { wall: hovered, ok: false, message: verdict.message };
    return { wall: hovered, ok: true, message: "Tap to place this barricade." };
  }, [hovered, state]);

  // The full legality pass over every groove costs a breadth-first search per
  // candidate, so it is computed AFTER paint (in a zero-delay timer) instead of
  // blocking the render. Until it lands the slots are drawn neutral; a click is
  // still validated by the engine, so nothing can slip through.
  useEffect(() => {
    if (!wallMode || !canPlay) {
      setLegalWallKeys(null);
      return undefined;
    }
    setLegalWallKeys(null);
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      setLegalWallKeys(new Set(legalWalls(state, HUMAN_SEAT).map((action) => wallKey(action.wall))));
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [wallMode, canPlay, state]);

  const resetGame = useCallback((announce = true) => {
    epochRef.current += 1;
    resultSoundedRef.current = null;
    setState(createInitialState());
    setWallMode(false);
    setHovered(null);
    setNotice(null);
    setAiThinking(false);
    setLegalWallKeys(null);
    if (announce) playBarricadeNewGame();
  }, []);

  // ── The bot's turn ────────────────────────────────────────────────────
  // One bounded, synchronous decision (tens of milliseconds at most — the
  // search has both a node and a clock budget), taken after a short beat so the
  // player can see whose turn it was. The epoch guard drops a stale timer after
  // a restart.
  useEffect(() => {
    if (matchOver || state.turn !== AI_SEAT) return undefined;
    setAiThinking(true);
    const epoch = epochRef.current;
    const handle = setTimeout(() => {
      if (epoch !== epochRef.current) return;
      const action = chooseAiAction(state, AI_SEAT, difficulty);
      setAiThinking(false);
      if (!action) return;
      try {
        const next = applyAction(state, AI_SEAT, action);
        const played = next.lastAction?.action;
        if (played && played.type === "move") playMoveSound(played.kind, false);
        else playBarricadeWall(false);
        setNotice(null);
        setState(next);
      } catch (error) {
        // The engine refused its own bot's action: that is a bug in the bot, not
        // a player mistake. Say so out loud and hand the player a fresh board
        // rather than leaving a stuck one.
        setNotice(
          error instanceof BarricadeRuleError
            ? `The bot tried an illegal move (${error.code}) — the board has been reset.`
            : "The bot hit an unexpected error — the board has been reset.",
        );
        resetGame(false);
      }
    }, AI_THINK_DELAY_MS);
    return () => clearTimeout(handle);
  }, [state, matchOver, difficulty, resetGame]);

  // ── Result cues and the session tally ─────────────────────────────────
  useEffect(() => {
    if (!matchOver) return;
    if (resultSoundedRef.current === state.ply) return;
    resultSoundedRef.current = state.ply;
    if (state.winner === HUMAN_SEAT) {
      playBarricadeWin();
      setScore((current) => ({ ...current, wins: current.wins + 1 }));
    } else {
      playBarricadeLoss();
      setScore((current) => ({ ...current, losses: current.losses + 1 }));
    }
  }, [matchOver, state.ply, state.winner]);

  // ── Playing a turn: always through the engine ─────────────────────────
  const play = useCallback(
    (action: BarricadeAction) => {
      try {
        const next = applyAction(state, HUMAN_SEAT, action);
        if (next.lastAction?.action.type === "move") {
          playMoveSound(next.lastAction.action.kind, true);
        } else {
          playBarricadeWall(true);
        }
        setNotice(null);
        setState(next);
        return true;
      } catch (error) {
        setNotice(
          error instanceof BarricadeRuleError
            ? error.message
            : "That turn could not be played — please try another.",
        );
        playBarricadeReject();
        return false;
      }
    },
    [state],
  );

  const handleMove = useCallback(
    (to: Position) => {
      if (!canPlay || wallMode) return;
      play({ type: "move", to });
    },
    [canPlay, wallMode, play],
  );

  const handlePlaceWall = useCallback(
    (wall: WallPlacement) => {
      if (!canPlay) return;
      // Ask the engine first, so an invalid placement is explained (and never
      // applied) instead of throwing.
      const verdict = classifyWall(state, HUMAN_SEAT, wall);
      if (verdict.ok === false) {
        setNotice(verdict.message);
        playBarricadeReject();
        return;
      }
      if (play({ type: "wall", wall })) setHovered(null);
    },
    [canPlay, play, state],
  );

  const handleDifficulty = useCallback((next: AiDifficulty) => {
    setDifficulty(next);
    storeAiDifficulty("barricade", next);
  }, []);

  // ── Derived display ───────────────────────────────────────────────────
  const myWalls = state.wallsRemaining[HUMAN_SEAT];
  const aiWalls = state.wallsRemaining[AI_SEAT];
  const myGoalRow = goalRowFor(HUMAN_SEAT);
  const aiGoalRow = goalRowFor(AI_SEAT);
  const myName = myIdentity?.name || "You";

  const statusText = matchOver
    ? state.winner === HUMAN_SEAT
      ? "You reached the far side. Match won!"
      : "The bot reached your baseline first. Match lost."
    : aiThinking
      ? "The bot is thinking…"
      : wallMode
        ? "Your turn — pick a groove for your barricade."
        : "Your turn — tap a highlighted square to move, or switch to barricades.";

  const seatChip = (seat: Seat, label: string, walls: number, active: boolean) => (
    <div
      key={seat}
      className={`barricade-seat ${active ? "is-active" : ""}`}
      data-testid={`barricade-seat-${seat}`}
      data-active={active ? "true" : "false"}
    >
      <span className="barricade-seat-avatar" aria-hidden="true">
        {seat === HUMAN_SEAT ? (
          <FrameAvatar
            frame={myIdentity.profileFrame}
            iconKey={myIdentity.iconKey}
            name={myName}
            isGuest={myIdentity.isGuest}
            size="h-9 w-9"
          />
        ) : (
          <span className="barricade-bot-avatar">
            <IconRobot size={20} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-white">{label}</span>
        <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/50">
          <IconWall size={12} aria-hidden="true" />
          <span data-testid={`barricade-walls-${seat}`}>{walls}</span> barricades left
        </span>
      </span>
      {active ? (
        <span className="barricade-turn-badge" data-testid="barricade-turn-badge">
          {aiThinking ? "thinking" : "to move"}
        </span>
      ) : null}
    </div>
  );

  const boardNode = (
    <div className="barricade-board-shell">
      <p className="barricade-goal-bar is-mine" data-testid="barricade-goal-mine">
        <IconPlayerPlay size={12} aria-hidden="true" /> Your goal — reach any square of this row (row{" "}
        {myGoalRow + 1})
      </p>
      <BarricadeBoard
        state={state}
        mySeat={HUMAN_SEAT}
        activeSeat={state.turn}
        moves={moves}
        wallMode={wallMode && canPlay}
        orientation={orientation}
        legalWallKeys={legalWallKeys}
        preview={preview}
        disabled={!canPlay}
        onMove={handleMove}
        onPlaceWall={handlePlaceWall}
        onHoverWall={setHovered}
      />
      <p className="barricade-goal-bar is-theirs" data-testid="barricade-goal-theirs">
        <IconRobot size={12} aria-hidden="true" /> The bot&apos;s goal — its own baseline (row{" "}
        {aiGoalRow + 1})
      </p>
    </div>
  );

  const controlsNode = (
    <div className="barricade-controls">
      <div className="flex gap-2" role="group" aria-label="Turn action">
        <button
          type="button"
          className={`barricade-mode-button ${!wallMode ? "is-active" : ""}`}
          aria-pressed={!wallMode}
          data-testid="barricade-mode-move"
          onClick={() => {
            setWallMode(false);
            setHovered(null);
          }}
        >
          <IconBallpen size={16} aria-hidden="true" /> Move
        </button>
        <button
          type="button"
          className={`barricade-mode-button ${wallMode ? "is-active" : ""}`}
          aria-pressed={wallMode}
          data-testid="barricade-mode-wall"
          disabled={!canPlay || myWalls <= 0}
          onClick={() => setWallMode(true)}
        >
          <IconWall size={16} aria-hidden="true" /> Barricade
        </button>
      </div>

      <div className="flex gap-2" role="group" aria-label="Barricade orientation">
        <button
          type="button"
          className={`barricade-orientation-button ${orientation === ORIENTATIONS[0] ? "is-active" : ""}`}
          aria-pressed={orientation === ORIENTATIONS[0]}
          data-testid="barricade-orientation-horizontal"
          onClick={() => setOrientation(ORIENTATIONS[0])}
        >
          <IconArrowsHorizontal size={16} aria-hidden="true" /> Horizontal
        </button>
        <button
          type="button"
          className={`barricade-orientation-button ${orientation === ORIENTATIONS[1] ? "is-active" : ""}`}
          aria-pressed={orientation === ORIENTATIONS[1]}
          data-testid="barricade-orientation-vertical"
          onClick={() => setOrientation(ORIENTATIONS[1])}
        >
          <IconArrowsVertical size={16} aria-hidden="true" /> Vertical
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="barricade-secondary-button"
          data-testid="barricade-restart"
          onClick={() => resetGame()}
        >
          <IconRefresh size={16} aria-hidden="true" /> Restart
        </button>
        <button
          type="button"
          className="barricade-secondary-button"
          data-testid="barricade-lobby"
          onClick={() => router.push(LOBBY_PATH)}
        >
          <IconArrowLeft size={16} aria-hidden="true" /> Back to lobby
        </button>
        {/* Practice stays entirely client-side; the online duel lives on its
            own route and decides everything server-side. */}
        <button
          type="button"
          className="barricade-secondary-button"
          data-testid="barricade-play-online"
          onClick={() => router.push(ONLINE_PATH)}
        >
          <IconUsers size={16} aria-hidden="true" /> Play online 1v1
        </button>
      </div>

      <div className="barricade-session" data-testid="barricade-session">
        This session:{" "}
        <span className="text-emerald-300 font-semibold">{score.wins}W</span> ·{" "}
        <span className="text-red-300 font-semibold">{score.losses}L</span> · {state.ply} actions
        played
      </div>
    </div>
  );

  const resultPanel = (
    <PvpResultScreen
      open
      outcome={state.winner === HUMAN_SEAT ? "win" : "loss"}
      headline={
        state.winner === HUMAN_SEAT
          ? "You reached the far side. Congratulations!"
          : "The bot got across this time."
      }
      subline="Free practice — no wager, no rating, no trophies."
      gameName="Barricade vs AI"
      opponent={{ name: `AI (${difficulty})`, iconKey: null, isAi: true }}
      summary={[
        { label: "Session", value: `${score.wins}W – ${score.losses}L` },
        { label: "Actions", value: String(state.ply) },
        { label: "Your barricades left", value: String(myWalls) },
        { label: "Bot barricades left", value: String(aiWalls) },
      ]}
      playAgain={{ label: "New game", onClick: () => resetGame() }}
      onReturnToLobby={() => router.push(LOBBY_PATH)}
    />
  );

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath={LOBBY_PATH} />
      <div className="mx-auto mt-2 max-w-3xl">
        <GameSessionHost autoStart={!matchOver} autoStop={matchOver} gameLabel="barricade-ai">
          <motion.h1
            initial={reduceMotion ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.3 }}
            className="logo-text text-center text-2xl font-black uppercase tracking-[0.12em] text-[#7cefff] drop-shadow-[0_0_16px_rgba(0,229,255,0.45)] sm:text-3xl"
          >
            Barricade vs AI
          </motion.h1>
          <p className="mb-3 text-center text-xs text-white/60">
            Free play · No wager · You are{" "}
            <span className="font-semibold text-sky-300">blue</span> and move first; the bot is{" "}
            <span className="font-semibold text-purple-300">purple</span>.
          </p>

          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            {seatChip(HUMAN_SEAT, myName, myWalls, state.turn === HUMAN_SEAT && !matchOver)}
            {seatChip(AI_SEAT, `Bot · ${difficulty}`, aiWalls, state.turn === AI_SEAT && !matchOver)}
          </div>

          <p
            className="barricade-status"
            role="status"
            aria-live="polite"
            data-testid="barricade-status"
          >
            {statusText}
          </p>

          {boardNode}

          <p
            className={`barricade-notice ${notice ? "is-visible" : ""}`}
            role="status"
            aria-live="polite"
            data-testid="barricade-notice"
          >
            {wallMode && canPlay ? (preview ? preview.message : (notice ?? "Pick a groove for your barricade.")) : (notice ?? "")}
          </p>

          {controlsNode}

          <AiDifficultyPicker
            gameKey="barricade"
            value={difficulty}
            onChange={handleDifficulty}
            title="Bot difficulty"
            hint={BARRICADE_TIER_HINTS}
            fallbackHint={BARRICADE_TIER_HINTS[difficulty]}
            className="mt-4"
          />

          <details className="barricade-rules" data-testid="barricade-rules">
            <summary className="barricade-rules-summary">
              <IconHelpCircle size={16} aria-hidden="true" /> How to play Barricade
            </summary>
            <ol className="barricade-rules-list">
              <li>
                Race your pawn from your own baseline to <strong>any square of the far row</strong>.
                Landing there wins instantly.
              </li>
              <li>Each turn is exactly one action: move your pawn one square, or place one barricade.</li>
              <li>Pawns move up, down, left or right — never diagonally as an ordinary move.</li>
              <li>
                Face to face, you may jump straight over the bot when the square behind it is free.
                If a barricade or the board edge is right behind it, jump to one of the two squares
                beside it instead.
              </li>
              <li>
                A barricade is two squares long and blocks <em>both</em> players. They may not overlap
                or cross.
              </li>
              <li>
                You can never seal a player in: every barricade must leave both pawns a route to
                their goal.
              </li>
              <li>You have ten barricades; when they run out you must move your pawn.</li>
            </ol>
          </details>

          <AnimatePresence initial={false}>
            {matchOver ? (
              <motion.div
                key="barricade-result"
                data-testid="barricade-result"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.25 }}
              >
                {resultPanel}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </GameSessionHost>
      </div>
    </div>
  );
}
