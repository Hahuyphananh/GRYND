// ─── Dots & Boxes server-authoritative game engine ────────────────────
//
// Pure turn-based gameplay: each move alternates the current turn.
// Box completion detection, scoring, and game-over-on-box-completion
// are NOT implemented yet — the server is the only authority.

export interface GameState {
  /** Array of drawn edges: "h:0,0", "v:1,3", etc. */
  edges: string[];
  /** Current player: "host" or "guest" */
  currentTurn: "host" | "guest";
}

export const DOTS = 7;
export const TOTAL_EDGES = DOTS * (DOTS - 1) * 2; // 84

/** Create a fresh game state */
export function createInitialState(): GameState {
  return {
    edges: [],
    currentTurn: "host",
  };
}

/** Edge key helpers */
export function hEdgeKey(row: number, col: number): string {
  return `h:${row},${col}`;
}
export function vEdgeKey(row: number, col: number): string {
  return `v:${row},${col}`;
}

/**
 * Attempt to draw an edge. Returns the updated state if valid, or an error.
 * The server is the ONLY authority on game logic.
 *
 * Validation rules enforced:
 *   - It is the player's turn
 *   - The edge hasn't been drawn yet
 *   - The edge key is well-formed and within board bounds
 *
 * On valid move: edge is appended and the turn alternates.
 */
export function drawEdge(
  state: GameState,
  edgeKey: string,
  player: "host" | "guest",
): { state: GameState; error?: undefined } | { state?: undefined; error: string } {
  // ── Validate turn ──────────────────────────────────────────────────
  if (state.currentTurn !== player) {
    return { error: "Not your turn" };
  }

  // ── Validate edge hasn't been drawn ────────────────────────────────
  if (state.edges.includes(edgeKey)) {
    return { error: "Edge already drawn" };
  }

  // ── Validate edge key format ───────────────────────────────────────
  const parts = edgeKey.split(":");
  if (parts.length !== 2) {
    return { error: "Invalid edge key" };
  }

  const [type, coords] = parts as [string, string];
  const [rowStr, colStr] = coords.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);

  if (isNaN(row) || isNaN(col)) {
    return { error: "Invalid edge coordinates" };
  }

  if (type === "h") {
    if (row < 0 || row >= DOTS || col < 0 || col >= DOTS - 1) {
      return { error: "Edge out of bounds" };
    }
  } else if (type === "v") {
    if (row < 0 || row >= DOTS - 1 || col < 0 || col >= DOTS) {
      return { error: "Edge out of bounds" };
    }
  } else {
    return { error: "Invalid edge type" };
  }

  // ── Apply the edge and alternate turn ──────────────────────────────
  const newState: GameState = {
    edges: [...state.edges, edgeKey],
    currentTurn: player === "host" ? "guest" : "host",
  };

  return { state: newState };
}

/** Get remaining edge count */
export function remainingEdges(state: GameState): number {
  return TOTAL_EDGES - state.edges.length;
}
