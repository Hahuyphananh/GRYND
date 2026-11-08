/**
 * Phase 3 game screen: the board, the clocks, the controls and the result.
 *
 * Every rule, clock and result comes from `./match`, and every engine move from
 * `./engine`. This file owns presentation and the effects that drive the match;
 * it never decides whether a move is legal and never invents one.
 *
 * The engine runs in a Worker, so "thinking" never blocks the board: the clock
 * keeps ticking, the previous position stays playable to look at, and the move
 * lands when the search returns.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Chessboard } from "react-chessboard";
import type { Square } from "chess.js";

import {
  CHESS_AI_DIFFICULTIES,
  CHESS_AI_DIFFICULTY_LABELS,
  DEFAULT_CHESS_AI_DIFFICULTY,
  type ChessAiDifficulty,
} from "./chessDifficulty";
import { createChessEngine, type ChessEngine } from "./engine";
import {
  applyMove,
  applyUci,
  createLocalMatch,
  resign as resignMatch,
  tick,
  undo,
  view,
  type LocalMatch,
  type SeatColor,
} from "./match";
import {
  boardOrientation,
  capturedPieces,
  formatClock,
  isPromotionMove,
  kingSquare,
  legalTargetsFrom,
  moveRows,
  resultCopy,
  PROMOTION_OPTIONS,
} from "./uiLogic";

const ENGINE_URL = new URL("engine/stockfish-nnue-16-single.js", document.baseURI).href;

/** The clock a standalone game starts with; matches the production AI game. */
const INITIAL_TIME_MS = 300_000;

/** How often the clocks repaint. The controller derives time absolutely. */
const TICK_MS = 250;

const GLYPHS: Record<string, string> = {
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
};

type PromotionRequest = { from: string; to: string };

type DebugState = ReturnType<typeof view> & {
  thinking: boolean;
  engineReady: boolean;
  engineError: string | null;
  selected: string | null;
  promotionOpen: boolean;
};

declare global {
  interface Window {
    __CHESS_STATE__?: DebugState;
  }
}

export default function App() {
  const [difficulty, setDifficulty] = useState<ChessAiDifficulty>(DEFAULT_CHESS_AI_DIFFICULTY);
  const [humanColor, setHumanColor] = useState<SeatColor>("white");
  const [revision, setRevision] = useState(0);
  const [matchId, setMatchId] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [engineRetry, setEngineRetry] = useState(0);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [bootInfo, setBootInfo] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<PromotionRequest | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const matchRef = useRef<LocalMatch>(
    createLocalMatch({
      difficulty: DEFAULT_CHESS_AI_DIFFICULTY,
      humanColor: "white",
      initialTimeMs: INITIAL_TIME_MS,
      now: Date.now(),
    })
  );
  const engineRef = useRef<ChessEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createChessEngine({ url: ENGINE_URL });
  }

  // The controller is mutable, so a revision counter is what tells React the
  // board/clocks changed. `view()` is the only reader of the match.
  void revision;
  const current = view(matchRef.current, Date.now());
  const engine = engineRef.current;

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    engine
      .ready()
      .then(({ bootMs, identity }) => {
        if (!cancelled) setBootInfo(`${identity} · ready in ${Math.round(bootMs)} ms`);
      })
      .catch((error: unknown) => {
        if (!cancelled) setEngineError(String((error as Error)?.message ?? error));
      });
    return () => {
      cancelled = true;
    };
  }, [engine, engineRetry]);

  useEffect(() => () => engine.dispose(), [engine]);

  // ── clocks ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      const match = matchRef.current;
      if (match.status !== "playing") return;
      tick(match, Date.now());
      setRevision((value) => value + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // ── the AI's turn ───────────────────────────────────────────────────────
  // Keyed by the position's history length, so a ticking clock (or a clock
  // timeout repaint) never starts a second search. A stale answer is dropped by
  // comparing the FEN it was asked about with the position it would land on.
  const turnToken = `${matchId}:${current.history.length}:${current.status}:${engineRetry}`;

  useEffect(() => {
    const match = matchRef.current;
    if (match.status !== "playing" || current.isHumanTurn) return;

    let cancelled = false;
    const searchedFen = match.chess.fen();
    setThinking(true);

    engine
      .chooseMove(searchedFen, match.difficulty)
      .then((choice) => {
        if (cancelled || match.chess.fen() !== searchedFen) return;
        if (choice.uci) applyUci(match, choice.uci, Date.now());
      })
      .catch((error: unknown) => {
        if (!cancelled) setEngineError(String((error as Error)?.message ?? error));
      })
      .finally(() => {
        if (cancelled) return;
        setThinking(false);
        setRevision((value) => value + 1);
      });

    return () => {
      cancelled = true;
    };
    // `current.isHumanTurn` is derived from turnToken's position too; it is
    // named here only to document the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnToken, engine]);

  // A debug view for the QA scripts: the same data the UI renders.
  useEffect(() => {
    window.__CHESS_STATE__ = {
      ...view(matchRef.current, Date.now()),
      thinking,
      engineReady: Boolean(bootInfo),
      engineError,
      selected,
      promotionOpen: Boolean(promotion),
    };
  });

  // ── derived presentation ────────────────────────────────────────────────
  const targets = legalTargetsFrom(current.fen, selected);
  const captured = capturedPieces(current.fen);
  const rows = moveRows(current.history);
  const checkedKing = kingSquare(current.fen);
  const lastMove = current.history[current.history.length - 1] ?? null;

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    if (lastMove) {
      const from = lastMove.uci.slice(0, 2);
      const to = lastMove.uci.slice(2, 4);
      styles[from] = { backgroundColor: "rgba(251, 191, 36, 0.32)" };
      styles[to] = { backgroundColor: "rgba(251, 191, 36, 0.44)" };
    }
    for (const target of targets) {
      styles[target.to] = target.capture
        ? {
            background:
              "radial-gradient(circle, rgba(56,189,248,0) 58%, rgba(56,189,248,0.85) 60%)",
          }
        : {
            background:
              "radial-gradient(circle, rgba(56,189,248,0.85) 22%, rgba(56,189,248,0) 24%)",
          };
    }
    if (checkedKing) {
      styles[checkedKing] = {
        background:
          "radial-gradient(circle, rgba(248,113,113,0.95) 0%, rgba(248,113,113,0.35) 58%, rgba(248,113,113,0) 70%)",
      };
    }
    if (selected) {
      styles[selected] = {
        ...(styles[selected] ?? {}),
        backgroundColor: "rgba(56,189,248,0.38)",
        boxShadow: "inset 0 0 12px 3px rgba(56,189,248,0.65)",
      };
    }
    return styles;
  }, [lastMove, targets, checkedKing, selected]);

  const canHumanMove =
    current.status === "playing" && current.isHumanTurn && !thinking && !promotion;

  // ── actions ─────────────────────────────────────────────────────────────
  const play = useCallback((from: string, to: string, promotionPiece?: string) => {
    const match = matchRef.current;
    if (match.status !== "playing") return;
    if (isPromotionMove(match.chess.fen(), from, to) && !promotionPiece) {
      setPromotion({ from, to });
      return;
    }
    const result = applyMove(match, { from, to, promotion: promotionPiece }, Date.now());
    if (!result.ok) setNotice(result.error);
    else setNotice(null);
    setSelected(null);
    setPromotion(null);
    setRevision((value) => value + 1);
  }, []);

  const onSquareClick = useCallback(
    (square: string) => {
      if (!canHumanMove) return;
      const match = matchRef.current;
      if (selected) {
        if (square === selected) {
          setSelected(null);
          return;
        }
        if (legalTargetsFrom(match.chess.fen(), selected).some((target) => target.to === square)) {
          play(selected, square);
          return;
        }
      }
      const piece = match.chess.get(square as Square);
      const humanSide = match.humanColor === "white" ? "w" : "b";
      if (piece && piece.color === humanSide && piece.color === match.chess.turn()) {
        setSelected(square);
      } else {
        setSelected(null);
      }
    },
    [canHumanMove, play, selected]
  );

  const onPieceDrop = useCallback(
    (source: string, target: string) => {
      if (!canHumanMove) return false;
      const match = matchRef.current;
      if (!legalTargetsFrom(match.chess.fen(), source).some((option) => option.to === target)) {
        return false;
      }
      if (isPromotionMove(match.chess.fen(), source, target)) {
        setPromotion({ from: source, to: target });
        return false;
      }
      play(source, target);
      return true;
    },
    [canHumanMove, play]
  );

  const onUndo = useCallback(() => {
    if (thinking) return;
    if (undo(matchRef.current, Date.now())) {
      setSelected(null);
      setPromotion(null);
      setNotice(null);
      setRevision((value) => value + 1);
    }
  }, [thinking]);

  const onResign = useCallback(() => {
    if (matchRef.current.status !== "playing") return;
    resignMatch(matchRef.current);
    setSelected(null);
    setPromotion(null);
    setRevision((value) => value + 1);
  }, []);

  const startNewGame = useCallback((color: SeatColor, tier: ChessAiDifficulty) => {
    matchRef.current = createLocalMatch({
      humanColor: color,
      difficulty: tier,
      initialTimeMs: INITIAL_TIME_MS,
      now: Date.now(),
    });
    setHumanColor(color);
    setDifficulty(tier);
    setMatchId((value) => value + 1);
    setThinking(false);
    setSelected(null);
    setPromotion(null);
    setNotice(null);
    setDismissed(false);
    setEngineError(null);
    setEngineRetry((value) => value + 1);
    setRevision((value) => value + 1);
  }, []);

  const chooseDifficulty = useCallback((tier: ChessAiDifficulty) => {
    setDifficulty(tier);
    matchRef.current.difficulty = tier;
    setRevision((value) => value + 1);
  }, []);

  const choosePromotion = useCallback(
    (piece: string) => {
      if (!promotion) return;
      play(promotion.from, promotion.to, piece);
    },
    [play, promotion]
  );

  const result = resultCopy(current.outcome, current.reason);
  const showResult = current.status === "finished" && !dismissed;
  const aiLabel = CHESS_AI_DIFFICULTY_LABELS[current.difficulty];

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <h1>Chess</h1>
          <p className="tagline">Stockfish 16 · plays entirely in your browser</p>
        </div>
        <p className="engine-state" data-testid="engine-state">
          {engineError ? "engine error" : (bootInfo ?? "warming up…")}
        </p>
      </header>

      <main className="layout">
        <section className="board-column" aria-label="Chess board">
          <SeatBar
            name={`Stockfish · ${aiLabel}`}
            clockMs={current.clocks[current.aiColor ?? "black"]}
            active={current.isAiTurn}
            captured={current.aiColor === "white" ? captured.byWhite : captured.byBlack}
            tone="ai"
          />

          <div className="board-frame" data-testid="board">
            <Chessboard
              id="standalone-board"
              position={current.fen}
              boardOrientation={boardOrientation(current.humanColor)}
              onSquareClick={onSquareClick}
              onPieceDrop={onPieceDrop}
              arePiecesDraggable={canHumanMove}
              isDraggablePiece={({ piece }) =>
                canHumanMove && piece.charAt(0) === (current.humanColor === "white" ? "w" : "b")
              }
              customSquareStyles={squareStyles}
              animationDuration={180}
              customBoardStyle={{ borderRadius: "10px", overflow: "hidden" }}
              customLightSquareStyle={{ backgroundColor: "#e9e2cf" }}
              customDarkSquareStyle={{ backgroundColor: "#5b7c6b" }}
            />
          </div>

          <SeatBar
            name="You"
            clockMs={current.clocks[current.humanColor]}
            active={current.isHumanTurn}
            captured={current.humanColor === "white" ? captured.byWhite : captured.byBlack}
            tone="human"
          />
        </section>

        <aside className="panel">
          <div className="field">
            <label htmlFor="difficulty">Difficulty</label>
            <div className="segmented" id="difficulty" role="group" aria-label="Difficulty">
              {CHESS_AI_DIFFICULTIES.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  data-action={`difficulty-${tier}`}
                  className={tier === difficulty ? "is-active" : ""}
                  aria-pressed={tier === difficulty}
                  onClick={() => chooseDifficulty(tier)}
                >
                  {CHESS_AI_DIFFICULTY_LABELS[tier]}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="color">Play as</label>
            <div className="segmented" id="color" role="group" aria-label="Play as">
              {(["white", "black"] as const).map((color) => (
                <button
                  key={color}
                  type="button"
                  data-action={`color-${color}`}
                  className={color === humanColor ? "is-active" : ""}
                  aria-pressed={color === humanColor}
                  onClick={() => startNewGame(color, difficulty)}
                >
                  {color === "white" ? "White" : "Black"}
                </button>
              ))}
            </div>
            <p className="hint">Changing side starts a new game.</p>
          </div>

          <div className="status" data-testid="status" role="status">
            {current.status === "finished" ? (
              result.title
            ) : thinking ? (
              <span className="thinking">
                Stockfish is thinking<span>…</span>
              </span>
            ) : current.isHumanTurn ? (
              promotion ? (
                "Pick a promotion piece"
              ) : (
                "Your move"
              )
            ) : (
              "Stockfish to move"
            )}
            {notice ? <span className="notice"> · {notice}</span> : null}
          </div>

          {engineError ? (
            <div className="error-box" role="alert">
              <p>{engineError}</p>
              <button type="button" onClick={() => setEngineRetry((value) => value + 1)}>
                Retry engine
              </button>
            </div>
          ) : null}

          <div className="moves" data-testid="moves">
            {rows.length === 0 ? (
              <p className="moves-empty">No moves yet.</p>
            ) : (
              <ol>
                {rows.map((row) => (
                  <li key={row.number}>
                    <span className="move-number">{row.number}.</span>
                    <span className="move-san">{row.white?.san ?? "…"}</span>
                    <span className="move-san">{row.black?.san ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="actions">
            <button
              type="button"
              data-action="undo"
              onClick={onUndo}
              disabled={!current.canUndo || thinking}
            >
              Undo
            </button>
            <button
              type="button"
              data-action="resign"
              onClick={onResign}
              disabled={current.status !== "playing"}
            >
              Resign
            </button>
            <button
              type="button"
              data-action="new-game"
              className="primary"
              onClick={() => startNewGame(humanColor, difficulty)}
            >
              New game
            </button>
          </div>

          <p className="hint">
            Drag a piece or tap a square, then tap its destination. The clock is five minutes a
            side.
          </p>

          <footer className="footnote">
            Engine: Stockfish 16 (GPLv3), unmodified.{" "}
            <a href="./LICENSE-STOCKFISH.txt" target="_blank" rel="noopener noreferrer">
              Licence
            </a>{" "}
            ·{" "}
            <a href="./STOCKFISH-SOURCE.txt" target="_blank" rel="noopener noreferrer">
              Source
            </a>
          </footer>
        </aside>
      </main>

      {promotion ? (
        <div className="overlay" data-testid="promotion">
          <div className="card" role="dialog" aria-label="Choose a promotion piece">
            <h2>Promote to</h2>
            <div className="promotion-row">
              {PROMOTION_OPTIONS.map((piece) => (
                <button
                  key={piece}
                  type="button"
                  data-action={`promote-${piece}`}
                  className="promotion-piece"
                  onClick={() => choosePromotion(piece)}
                >
                  {GLYPHS[piece]}
                </button>
              ))}
            </div>
            <button type="button" className="ghost" onClick={() => setPromotion(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {showResult ? (
        <div className="overlay" data-testid="result" data-result={result.tone}>
          <div className={`card result ${result.tone}`}>
            <p className="result-kicker">
              {reasonLabel(current.reason)} · {rows.length} move{rows.length === 1 ? "" : "s"}
            </p>
            <h2>{result.title}</h2>
            <p className="result-detail">{result.detail}</p>
            <div className="result-actions">
              <button
                type="button"
                className="primary"
                data-action="play-again"
                onClick={() => startNewGame(humanColor, difficulty)}
              >
                Play again
              </button>
              <button type="button" className="ghost" onClick={() => setDismissed(true)}>
                Look at the board
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SeatBar({
  name,
  clockMs,
  active,
  captured,
  tone,
}: {
  name: string;
  clockMs: number;
  active: boolean;
  captured: string[];
  tone: "ai" | "human";
}) {
  const low = clockMs <= 30_000;
  return (
    <div className={`seat ${tone} ${active ? "is-active" : ""}`}>
      <div className="seat-identity">
        <span className="seat-dot" aria-hidden="true" />
        <span className="seat-name">{name}</span>
        <span className="seat-captured" aria-label="captured pieces">
          {captured.slice(0, 12).join("")}
        </span>
      </div>
      <div className={`clock ${low ? "is-low" : ""}`} data-testid={`clock-${tone}`}>
        {formatClock(clockMs)}
      </div>
    </div>
  );
}

function reasonLabel(reason: string | null): string {
  if (!reason) return "Game over";
  const labels: Record<string, string> = {
    checkmate: "Checkmate",
    stalemate: "Stalemate",
    "insufficient-material": "Insufficient material",
    "threefold-repetition": "Threefold repetition",
    "fifty-move": "Fifty-move rule",
    timeout: "Time out",
    resign: "Resignation",
  };
  return labels[reason] ?? "Game over";
}
