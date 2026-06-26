// ─── Dots & Boxes server-authoritative game engine ────────────────────
//
// All game logic lives here. Clients should never calculate box completion,
// scores, or game-over conditions — they send edge draws and receive the
// full authoritative state back from the server.

export interface GameState {
  /** Array of drawn edges: "h:0,0", "v:1,3", etc. */
  edges: string[];
  /** Array of completed boxes: "0,0", "2,1", etc. */
  boxes: string[];
  /** Who owns each completed box: Record<"row,col", "host" | "guest"> */
  boxOwners: Record<string, "host" | "guest">;
  /** Current player: "host" or "guest" */
  currentTurn: "host" | "guest";
  /** Scores */
  scores: { host: number; guest: number };
}

export const DOTS = 7;
export const BOXES = 6;
export const TOTAL_EDGES = DOTS * (DOTS - 1) * 2; // 84

/** Create a fresh game state */
export function createInitialState(): GameState {
  return {
    edges: [],
    boxes: [],
    boxOwners: {},
    currentTurn: "host",
    scores: { host: 0, guest: 0 },
  };
}

/** Edge key helpers */
export function hEdgeKey(row: number, col: number): string {
  return `h:${row},${col}`;
}
export function vEdgeKey(row: number, col: number): string {
  return `v:${row},${col}`;
}
export function boxKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * Attempt to draw an edge. Returns the updated state if valid, or an error.
 * The server is the ONLY authority on game logic.
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

  // ── Apply the edge ─────────────────────────────────────────────────
  const newEdges = [...state.edges, edgeKey];

  // ── Detect completed boxes ─────────────────────────────────────────
  const newBoxes = [...state.boxes];
  const newBoxOwners = { ...state.boxOwners };
  let boxesCompletedThisTurn = 0;

  const completedBoxes = findCompletedBoxes(newEdges, state.edges, type, row, col);

  for (const bk of completedBoxes) {
    if (!newBoxes.includes(bk)) {
      newBoxes.push(bk);
      newBoxOwners[bk] = player;
      boxesCompletedThisTurn++;
    }
  }

  // ── Update scores ──────────────────────────────────────────────────
  const newScores = {
    host: state.scores.host + (player === "host" ? boxesCompletedThisTurn : 0),
    guest: state.scores.guest + (player === "guest" ? boxesCompletedThisTurn : 0),
  };

  // ── Determine next turn ────────────────────────────────────────────
  // If player completed at least one box, they go again.
  // Otherwise, turn switches.
  const totalBoxes = newBoxes.length;
  const gameOver = totalBoxes >= BOXES * BOXES; // 36

  const nextTurn = gameOver
    ? state.currentTurn // Keep turn frozen when game is over
    : boxesCompletedThisTurn > 0
      ? player // Same player goes again
      : player === "host"
        ? "guest"
        : "host";

  const newState: GameState = {
    edges: newEdges,
    boxes: newBoxes,
    boxOwners: newBoxOwners,
    currentTurn: nextTurn as "host" | "guest",
    scores: newScores,
  };

  return { state: newState };
}

/**
 * Check which boxes (if any) are completed after drawing an edge.
 * We only need to check the 1-2 boxes adjacent to the newly drawn edge.
 */
function findCompletedBoxes(
  allEdges: string[],
  _previousEdges: string[],
  type: string,
  row: number,
  col: number,
): string[] {
  const completed: string[] = [];

  if (type === "h") {
    // Horizontal edge at (row, col). Affects:
    // - Box ABOVE: box(row-1, col) — needs h(row-1,col), v(row-1,col), v(row-1,col+1), h(row,col)
    // - Box BELOW: box(row, col)   — needs h(row,col),   v(row,col),   v(row,col+1),   h(row+1,col)

    // Box above (if row > 0)
    if (row > 0) {
      const bk = boxKey(row - 1, col);
      if (
        allEdges.includes(hEdgeKey(row - 1, col)) &&
        allEdges.includes(vEdgeKey(row - 1, col)) &&
        allEdges.includes(vEdgeKey(row - 1, col + 1)) &&
        allEdges.includes(hEdgeKey(row, col)) // the newly drawn edge
      ) {
        completed.push(bk);
      }
    }

    // Box below (if row < 6)
    if (row < DOTS - 1) {
      const bk = boxKey(row, col);
      if (
        allEdges.includes(hEdgeKey(row, col)) && // the newly drawn edge
        allEdges.includes(vEdgeKey(row, col)) &&
        allEdges.includes(vEdgeKey(row, col + 1)) &&
        allEdges.includes(hEdgeKey(row + 1, col))
      ) {
        completed.push(bk);
      }
    }
  } else {
    // Vertical edge at (row, col). Affects:
    // - Box LEFT:  box(row, col-1) — needs v(row,col-1), h(row,col-1), h(row+1,col-1), v(row,col)
    // - Box RIGHT: box(row, col)   — needs v(row,col),   h(row,col),   h(row+1,col),   v(row,col+1)

    // Box left (if col > 0)
    if (col > 0) {
      const bk = boxKey(row, col - 1);
      if (
        allEdges.includes(vEdgeKey(row, col - 1)) &&
        allEdges.includes(hEdgeKey(row, col - 1)) &&
        allEdges.includes(hEdgeKey(row + 1, col - 1)) &&
        allEdges.includes(vEdgeKey(row, col)) // the newly drawn edge
      ) {
        completed.push(bk);
      }
    }

    // Box right (if col < 6)
    if (col < DOTS - 1) {
      const bk = boxKey(row, col);
      if (
        allEdges.includes(vEdgeKey(row, col)) && // the newly drawn edge
        allEdges.includes(hEdgeKey(row, col)) &&
        allEdges.includes(hEdgeKey(row + 1, col)) &&
        allEdges.includes(vEdgeKey(row, col + 1))
      ) {
        completed.push(bk);
      }
    }
  }

  return completed;
}

/** Check if the game is over (all 36 boxes filled) */
export function isGameOver(state: GameState): boolean {
  return state.boxes.length >= BOXES * BOXES;
}

/** Get remaining edge count */
export function remainingEdges(state: GameState): number {
  return TOTAL_EDGES - state.edges.length;
}
