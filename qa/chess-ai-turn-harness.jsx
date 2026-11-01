// qa/chess-ai-turn-harness.jsx
//
// Browser fixture for qa/chess-ai-turn-check.mjs. It mounts the REAL vs-AI
// chess board (src/app/casino/chess/ai/ChessAIPageInner) against a scripted
// chess backend installed as a `window.fetch` stub, so the client's own
// turn-taking can be observed without a database or a browser session.
//
// Only platform chrome (navigation, session recording, PostHog, audio, seat
// identity) is stubbed by the esbuild plugin in the check. The board, its AI
// effect, the practice-pause hook and chess.js are the shipped ones.

import React from "react";
import { createRoot } from "react-dom/client";
import { Chess } from "chess.js";
import ChessAIPage from "../src/app/casino/chess/ai/ChessAIPageInner";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GAME_ID = "11111111-1111-4111-8111-111111111111";

/**
 * How the scripted bot answers, chosen by the page URL:
 *
 *   ok    — it plays (the shipped happy path);
 *   error — the route fails with a 500, as a broken engine/host would;
 *   stall — it refuses with the board still the bot's to move (a refusal that
 *           carries the server's own snapshot);
 *   hang  — the request is never answered at all.
 */
const MODE = new URLSearchParams(window.location.search).get("mode") || "ok";

/** The scripted game row. */
const server = {
  moves: [],
  status: "in_progress",
  calls: [],
};

function uciOf(move) {
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function lastFen() {
  return server.moves.length ? server.moves[server.moves.length - 1].fenAfter : null;
}

function position() {
  return new Chess(lastFen() || START);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function record(move, chess) {
  server.moves.push({ san: move.san, uci: uciOf(move), fenAfter: chess.fen() });
}

window.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const path = String(url).replace(/^https?:\/\/[^/]+/, "");
  const method = String(init.method || "GET").toUpperCase();
  const body = (() => {
    try {
      return init.body ? JSON.parse(init.body) : {};
    } catch {
      return {};
    }
  })();
  server.calls.push(`${method} ${path}`);

  if (path.startsWith("/api/practice/pause")) {
    return method === "GET" ? json({ paused: false }) : json({ ok: true, paused: false });
  }

  if (path.startsWith("/api/chess/game-state")) {
    return json({
      success: true,
      data: {
        gameId: GAME_ID,
        status: server.status,
        fen: lastFen(),
        viewerRole: "white",
        whitePlayerName: "QA Player",
        blackPlayerName: "Chess AI",
        moves: server.moves.map((move, index) => ({
          id: index + 1,
          playedBy: "seat",
          moveUci: move.uci,
          moveSan: move.san,
          fenAfter: move.fenAfter,
        })),
      },
    });
  }

  if (path === "/api/chess/move" && method === "POST") {
    const chess = position();
    const move = chess.move({ from: body.from, to: body.to, promotion: body.promotion || "q" });
    if (!move) return json({ error: "Illegal move" }, 400);
    record(move, chess);
    return json({ success: true, data: { fen: chess.fen(), move: move.san } });
  }

  if (path === "/api/chess/ai-move" && method === "POST") {
    if (MODE === "hang") {
      // A real fetch rejects with an AbortError when its signal aborts, which is
      // what the page's own deadline relies on; the stub must behave the same
      // or the check would be testing a code path no browser has.
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The user aborted a request.", "AbortError"));
        });
      });
    }
    if (MODE === "error") return json({ error: "Internal Server Error" }, 500);

    const chess = position();
    if (MODE === "stall") {
      // A refusal that carries the server's snapshot, in which the bot is still
      // the side to move — the answer the board must not treat as progress.
      return json(
        {
          error: "The AI produced an unusable move",
          reason: "invalid_move",
          state: {
            gameId: GAME_ID,
            status: server.status,
            turn: "black",
            fen: chess.fen(),
            isGameOver: false,
            humanColor: "white",
            aiColor: "black",
            moveCount: server.moves.length,
          },
        },
        409,
      );
    }
    if (chess.turn() !== "b") {
      return json(
        {
          error: "Not the AI's turn",
          reason: "not_ai_turn",
          state: {
            gameId: GAME_ID,
            status: server.status,
            turn: chess.turn() === "w" ? "white" : "black",
            fen: chess.fen(),
            isGameOver: chess.isGameOver(),
            humanColor: "white",
            aiColor: "black",
            moveCount: server.moves.length,
          },
        },
        409,
      );
    }
    const legal = chess.moves({ verbose: true });
    if (legal.length === 0) return json({ error: "Terminal" }, 409);
    const move = legal[0];
    chess.move(move);
    record(move, chess);
    return json({
      success: true,
      data: {
        gameId: GAME_ID,
        status: server.status,
        turn: "white",
        fen: chess.fen(),
        isGameOver: chess.isGameOver(),
        humanColor: "white",
        aiColor: "black",
        moveCount: server.moves.length,
        aiMove: {
          san: move.san,
          uci: uciOf(move),
          from: move.from,
          to: move.to,
          promotion: move.promotion ?? null,
        },
        difficulty: "medium",
        outcome: "moved",
      },
    });
  }

  return json({ success: true, data: {} });
};

window.__qa = {
  calls: () => server.calls.slice(),
  moves: () => server.moves.map((move) => move.san),
  fen: () => position().fen(),
  resetCalls: () => {
    server.calls.length = 0;
  },
};

createRoot(document.getElementById("root")).render(<ChessAIPage />);
