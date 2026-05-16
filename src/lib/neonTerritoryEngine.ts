export type TileOwner = "neutral" | "player1" | "player2";

export type NeonTile = {
  x: number;
  y: number;
  owner: TileOwner;
  hp: 0 | 1 | 2;
};

export type PlayerSlot = "player1" | "player2";

export type MatchAction = {
  userId: string;
  player: PlayerSlot;
  turnNumber: number;
  targetX: number;
  targetY: number;
};

export type NeonGameState = {
  grid: NeonTile[][];
  turnNumber: number;
  pendingActions: MatchAction[];
  status: "active" | "finished";
  playerStates: Record<PlayerSlot, { userId: string; tilesOwned: number }>;
};

const SIZE = 5;

export function createInitialState(player1Id: string, player2Id: string): NeonGameState {
  const grid: NeonTile[][] = Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => ({ x, y, owner: "neutral", hp: 0 } as NeonTile)),
  );

  grid[0][0] = { x: 0, y: 0, owner: "player1", hp: 2 };
  grid[SIZE - 1][SIZE - 1] = { x: SIZE - 1, y: SIZE - 1, owner: "player2", hp: 2 };

  return {
    grid,
    turnNumber: 0,
    pendingActions: [],
    status: "active",
    playerStates: {
      player1: { userId: player1Id, tilesOwned: 1 },
      player2: { userId: player2Id, tilesOwned: 1 },
    },
  };
}

function getNeighbors(x: number, y: number): [number, number][] {
  return [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ].filter(([nx, ny]) => nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE);
}

export function isAdjacentToPlayer(state: NeonGameState, targetX: number, targetY: number, player: PlayerSlot): boolean {
  return getNeighbors(targetX, targetY).some(([nx, ny]) => state.grid[ny][nx].owner === player);
}

export function validateAction(state: NeonGameState, action: MatchAction): { valid: boolean; error?: string } {
  const { targetX, targetY, player, turnNumber } = action;
  if (turnNumber !== state.turnNumber) return { valid: false, error: "Turn mismatch" };
  if (targetX < 0 || targetX >= SIZE || targetY < 0 || targetY >= SIZE) return { valid: false, error: "Invalid coordinates" };
  const tile = state.grid[targetY][targetX];
  if (tile.owner === player) return { valid: false, error: "Cannot attack your own tile" };
  if (!isAdjacentToPlayer(state, targetX, targetY, player)) return { valid: false, error: "Target must be adjacent" };
  return { valid: true };
}

export function resolveTurn(state: NeonGameState, actions: MatchAction[]): NeonGameState {
  const nextGrid = state.grid.map((row) => row.map((tile) => ({ ...tile })));

  for (const action of actions) {
    const tile = nextGrid[action.targetY][action.targetX];
    tile.hp = Math.min(2, (tile.hp + 1) as 0 | 1 | 2);
    if (tile.hp >= 2) {
      tile.owner = action.player;
      tile.hp = 2;
    }
  }

  const player1Tiles = nextGrid.flat().filter((t) => t.owner === "player1").length;
  const player2Tiles = nextGrid.flat().filter((t) => t.owner === "player2").length;
  const finished = player1Tiles === SIZE * SIZE || player2Tiles === SIZE * SIZE;

  return {
    ...state,
    grid: nextGrid,
    turnNumber: state.turnNumber + 1,
    pendingActions: [],
    status: finished ? "finished" : "active",
    playerStates: {
      player1: { ...state.playerStates.player1, tilesOwned: player1Tiles },
      player2: { ...state.playerStates.player2, tilesOwned: player2Tiles },
    },
  };
}

export function pickAiAction(state: NeonGameState, aiPlayer: PlayerSlot, aiUserId: string): MatchAction | null {
  const enemy = aiPlayer === "player1" ? "player2" : "player1";
  const candidates = state.grid
    .flat()
    .filter((tile) => tile.owner !== aiPlayer && isAdjacentToPlayer(state, tile.x, tile.y, aiPlayer));

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const enemyPriorityA = a.owner === enemy ? 2 : 1;
    const enemyPriorityB = b.owner === enemy ? 2 : 1;
    const weakA = 2 - a.hp;
    const weakB = 2 - b.hp;
    return enemyPriorityB - enemyPriorityA || weakB - weakA;
  });

  const pick = candidates[0];
  return {
    userId: aiUserId,
    player: aiPlayer,
    turnNumber: state.turnNumber,
    targetX: pick.x,
    targetY: pick.y,
  };
}
