// ─── Dots & Boxes server-authoritative game engine ────────────────────
//
// The server is the ONLY authority on game logic. Clients send moves
// and receive the full authoritative state back.
//
// Official Dots & Boxes turn rule:
//   - Place one edge per turn (server validates bounds + not-drawn + turn)
//   - After placing, scan 1–2 adjacent boxes. Each box with all 4 edges
//     drawn is "claimed" by the moving player and increments their score.
//   - If the moving player claimed at least one new box, they get another
//     turn. Otherwise the turn switches.
//   - Multiple boxes from the same edge count as ONE bonus turn (no
//     chained "play forever" loops).
//
// Game ends when all 84 edges have been drawn. Winner = most boxes.

export const DOTS = 7; // 7×7 dot grid → 6×6 boxes
export const BOXES = 6;
export const TOTAL_BOXES = BOXES * BOXES; // 36
export const TOTAL_EDGES = DOTS * (DOTS - 1) * 2; // 7×6 + 6×7 = 84
// Default turn timer (per player move). Tuned via user feedback:
// 10s felt rushed for many players since Dots & Boxes needs the
// player to scan the board for safe edges before committing.
// Bumped to 20s on 2026-XX-XX after player survey. The DB column
// default and the migration shipped alongside the bump mirror this
// integer; clamped 5–120s at runtime by dotsAndBoxesServer.js.
export const TURN_SECONDS = 20;

export type Player = "host" | "guest";

export interface GameState {
  /** Drawn edges: "h:0,0", "v:1,3", etc. */
  edges: string[];
  /** Completed boxes keyed as "row,col" (0-5) */
  boxes: string[];
  /** Box ownership for each completed box */
  boxOwners: Record<string, Player>;
  /** Current player */
  currentTurn: Player;
  /** Score per player */
  scores: { host: number; guest: number };
}

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

/** Total boxes claimed */
export function boxesClaimed(state: GameState): number {
  return state.boxes.length;
}

/** Remaining edges that can still be drawn */
export function remainingEdges(state: GameState): number {
  return TOTAL_EDGES - state.edges.length;
}

/** Has the game ended? (all 84 edges drawn) */
export function isGameOver(state: GameState): boolean {
  return state.edges.length >= TOTAL_EDGES;
}

/**
 * Validate that the edge key is well-formed and within board bounds.
 * Pure validation — does NOT mutate state.
 */
function validateEdgeKey(edgeKey: string): { type: string; row: number; col: number } | { error: string } {
  const parts = edgeKey.split(":");
  if (parts.length !== 2) return { error: "Invalid edge key" };
  const [type, coords] = parts as [string, string];
  const [rowStr, colStr] = coords.split(",");
  const row = Number(rowStr);
  const col = Number(colStr);
  if (isNaN(row) || isNaN(col)) return { error: "Invalid edge coordinates" };

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
  return { type, row, col };
}

/**
 * Scan the boxes adjacent to a freshly drawn edge. Returns keys for
 * boxes that have all 4 edges in the supplied edge set. Newly-completed
 * boxes (not already claimed) are also detected.
 */
export function checkAdjacentBoxes(
  allEdges: string[],
  type: string,
  row: number,
  col: number,
): string[] {
  const completed: string[] = [];
  const has = (k: string) => allEdges.includes(k);

  if (type === "h") {
    // Horizontal edge at (row, col):
    //   - Above box: box(row-1, col) requires h(row-1,col), v(row-1,col),
    //     v(row-1,col+1), h(row,col)  ← newly drawn
    //   - Below box: box(row,   col) requires h(row,  col), v(row,  col),
    //     v(row,  col+1), h(row+1,col)
    if (row > 0) {
      const bk = boxKey(row - 1, col);
      const ok =
        has(hEdgeKey(row - 1, col)) &&
        has(vEdgeKey(row - 1, col)) &&
        has(vEdgeKey(row - 1, col + 1)) &&
        has(hEdgeKey(row, col));
      if (ok) completed.push(bk);
    }
    if (row < DOTS - 1) {
      const bk = boxKey(row, col);
      const ok =
        has(hEdgeKey(row, col)) &&
        has(vEdgeKey(row, col)) &&
        has(vEdgeKey(row, col + 1)) &&
        has(hEdgeKey(row + 1, col));
      if (ok) completed.push(bk);
    }
  } else if (type === "v") {
    // Vertical edge at (row, col):
    //   - Left  box: box(row, col-1) requires v(row,col-1), h(row,  col-1),
    //     h(row+1,col-1), v(row,col)  ← newly drawn
    //   - Right box: box(row, col)   requires v(row,col),   h(row,  col),
    //     h(row+1,col),   v(row,col+1)
    if (col > 0) {
      const bk = boxKey(row, col - 1);
      const ok =
        has(vEdgeKey(row, col - 1)) &&
        has(hEdgeKey(row, col - 1)) &&
        has(hEdgeKey(row + 1, col - 1)) &&
        has(vEdgeKey(row, col));
      if (ok) completed.push(bk);
    }
    if (col < DOTS - 1) {
      const bk = boxKey(row, col);
      const ok =
        has(vEdgeKey(row, col)) &&
        has(hEdgeKey(row, col)) &&
        has(hEdgeKey(row + 1, col)) &&
        has(vEdgeKey(row, col + 1));
      if (ok) completed.push(bk);
    }
  }

  return completed;
}

/**
 * Enumerate all legal edge keys still available from the supplied state.
 */
export function getLegalEdges(state: GameState): string[] {
  const out: string[] = [];
  const taken = new Set(state.edges);

  for (let row = 0; row < DOTS; row++) {
    for (let col = 0; col < DOTS - 1; col++) {
      const k = hEdgeKey(row, col);
      if (!taken.has(k)) out.push(k);
    }
  }
  for (let row = 0; row < DOTS - 1; row++) {
    for (let col = 0; col < DOTS; col++) {
      const k = vEdgeKey(row, col);
      if (!taken.has(k)) out.push(k);
    }
  }

  return out;
}

/** Pick a random legal edge. Assumes at least one exists. */
export function pickRandomLegalEdge(state: GameState): string | null {
  const legal = getLegalEdges(state);
  if (legal.length === 0) return null;
  // Defensive Math.random offset for spread across array
  const idx = Math.floor(Math.random() * legal.length);
  return legal[Math.min(idx, legal.length - 1)];
}

/**
 * Apply a player's edge draw. Server is the ONLY authority.
 *
 * Validation rules:
 *   - It is the player's turn
 *   - The edge has not already been drawn
 *   - The edge key is well-formed and within board bounds
 *
 * Side effects on valid move:
 *   - Edge is appended to the board
 *   - Any newly-completed adjacent boxes are claimed by the player and
 *     added to their score
 *   - If the player claimed at least one new box, they get another turn;
 *     otherwise the turn switches to the opponent
 */
export function drawEdge(
  state: GameState,
  edgeKey: string,
  player: Player,
): { state: GameState; error?: undefined } | { state?: undefined; error: string } {
  // Validate turn
  if (state.currentTurn !== player) {
    return { error: "Not your turn" };
  }

  // Validate not drawn
  if (state.edges.includes(edgeKey)) {
    return { error: "Edge already drawn" };
  }

  // Validate key format and bounds
  const parsed = validateEdgeKey(edgeKey);
  if ("error" in parsed) return { error: parsed.error };

  const { type, row, col } = parsed as { type: string; row: number; col: number };

  // Apply the edge
  const newEdges = [...state.edges, edgeKey];

  // Detect newly-completed adjacent boxes
  const adjacent = checkAdjacentBoxes(newEdges, type, row, col);
  const newBoxes = [...state.boxes];
  const newBoxOwners = { ...state.boxOwners };
  let boxesClaimedThisTurn = 0;

  for (const bk of adjacent) {
    if (!newBoxes.includes(bk)) {
      newBoxes.push(bk);
      newBoxOwners[bk] = player;
      boxesClaimedThisTurn++;
    }
  }

  // Apply bonus-turn rule
  const nextTurn = boxesClaimedThisTurn > 0 ? player : player === "host" ? "guest" : "host";

  // Update scores
  const newScores = {
    host: state.scores.host + (player === "host" ? boxesClaimedThisTurn : 0),
    guest: state.scores.guest + (player === "guest" ? boxesClaimedThisTurn : 0),
  };

  const newState: GameState = {
    edges: newEdges,
    boxes: newBoxes,
    boxOwners: newBoxOwners,
    currentTurn: nextTurn as Player,
    scores: newScores,
  };

  return { state: newState };
}

/** Determine the winner (or null on a draw). */
export function determineResult(
  state: GameState,
  hostClerkId: string,
  guestClerkId: string | null,
): { result: "host_win" | "guest_win" | "draw"; winnerClerkId: string | null } {
  if (state.scores.host > state.scores.guest) {
    return { result: "host_win", winnerClerkId: hostClerkId };
  }
  if (state.scores.guest > state.scores.host) {
    return { result: "guest_win", winnerClerkId: guestClerkId };
  }
  return { result: "draw", winnerClerkId: null };
}

/** Normalize a possibly-stale gameState JSON value to a valid GameState */
export function ensureState(value: unknown): GameState {
  const fresh = createInitialState();
  if (!value || typeof value !== "object") return fresh;
  const v = value as Partial<GameState>;
  const edges = Array.isArray(v.edges) ? v.edges.filter((x): x is string => typeof x === "string") : fresh.edges;
  const boxes = Array.isArray(v.boxes) ? v.boxes.filter((x): x is string => typeof x === "string") : fresh.boxes;
  const boxOwners: Record<string, Player> = {};
  if (v.boxOwners && typeof v.boxOwners === "object") {
    for (const [k, role] of Object.entries(v.boxOwners)) {
      if (role === "host" || role === "guest") boxOwners[k] = role;
    }
  }
  const currentTurn: Player = v.currentTurn === "guest" ? "guest" : "host";
  const scores = {
    host: Math.max(0, Number(v.scores?.host) || 0),
    guest: Math.max(0, Number(v.scores?.guest) || 0),
  };
  return { edges, boxes, boxOwners, currentTurn, scores };
}
