export type TileOwner = "neutral" | "player1" | "player2";

export type PlayerSlot = "player1" | "player2";

export type NeonTile = {
  x: number;
  y: number;
  owner: TileOwner;
  troops: number;
  shield: number;
  capital?: boolean;
};

export type MatchActionType = "attack" | "reinforce" | "fortify";

export type MatchAction = {
  userId: string;
  player: PlayerSlot;
  turnNumber: number;
  actionType: MatchActionType;
  targetX: number;
  targetY: number;
};

export type NeonPlayerState = {
  userId: string;
  tilesOwned: number;
  energy: number;
};

export type NeonGameState = {
  grid: NeonTile[][];
  turnNumber: number;
  pendingActions: MatchAction[];
  status: "active" | "finished";
  winner?: PlayerSlot | null;
  playerStates: Record<PlayerSlot, NeonPlayerState>;
};

const SIZE = 5;
const STARTING_ENERGY = 3;
const ENERGY_GAIN = 3;
const MAX_ENERGY = 10;
const ACTION_COSTS: Record<MatchActionType, number> = {
  attack: 2,
  reinforce: 1,
  fortify: 1,
};

export function createInitialState(player1Id: string, player2Id: string): NeonGameState {
  const grid: NeonTile[][] = Array.from({ length: SIZE }, (_, y) =>
    Array.from(
      { length: SIZE },
      (_, x) => ({ x, y, owner: "neutral", troops: 0, shield: 0 }) as NeonTile,
    ),
  );

  grid[0][0] = { x: 0, y: 0, owner: "player1", troops: 5, shield: 1, capital: true };
  grid[SIZE - 1][SIZE - 1] = {
    x: SIZE - 1,
    y: SIZE - 1,
    owner: "player2",
    troops: 5,
    shield: 1,
    capital: true,
  };

  return {
    grid,
    turnNumber: 0,
    pendingActions: [],
    status: "active",
    winner: null,
    playerStates: {
      player1: { userId: player1Id, tilesOwned: 1, energy: STARTING_ENERGY },
      player2: { userId: player2Id, tilesOwned: 1, energy: STARTING_ENERGY },
    },
  };
}

export function normalizeGameState(state: NeonGameState): NeonGameState {
  const player1Id = state.playerStates?.player1?.userId ?? "";
  const player2Id = state.playerStates?.player2?.userId ?? "";
  const grid = state.grid.map((row, y) =>
    row.map((tile, x) => {
      const isLegacyCapital =
        (tile.owner === "player1" && x === 0 && y === 0) ||
        (tile.owner === "player2" && x === SIZE - 1 && y === SIZE - 1);

      if (typeof tile.troops === "number" && typeof tile.shield === "number") {
        return {
          x: tile.x ?? x,
          y: tile.y ?? y,
          owner: tile.owner,
          troops: tile.troops,
          shield: tile.shield,
          capital: (tile.capital ?? isLegacyCapital) || undefined,
        };
      }

      const legacyHealth = Number((tile as unknown as Record<string, unknown>)[`${"h"}p`] ?? 1);

      return {
        x: tile.x ?? x,
        y: tile.y ?? y,
        owner: tile.owner,
        troops: tile.owner === "neutral" ? 0 : Math.max(1, legacyHealth),
        shield: 0,
        capital: isLegacyCapital || undefined,
      };
    }),
  );

  const player1Tiles = countTiles(grid, "player1");
  const player2Tiles = countTiles(grid, "player2");

  return {
    ...state,
    grid,
    pendingActions: (state.pendingActions ?? []).map((action) => ({
      ...action,
      actionType: action.actionType ?? "attack",
    })),
    winner: state.winner ?? null,
    playerStates: {
      player1: {
        userId: state.playerStates?.player1?.userId ?? player1Id,
        tilesOwned: player1Tiles,
        energy: clampEnergy(state.playerStates?.player1?.energy ?? STARTING_ENERGY),
      },
      player2: {
        userId: state.playerStates?.player2?.userId ?? player2Id,
        tilesOwned: player2Tiles,
        energy: clampEnergy(state.playerStates?.player2?.energy ?? STARTING_ENERGY),
      },
    },
  };
}

function getNeighbors(x: number, y: number): [number, number][] {
  const neighbors: [number, number][] = [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ];

  return neighbors.filter(([nx, ny]) => nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE);
}

function countTiles(grid: NeonTile[][], player: PlayerSlot): number {
  return grid.flat().filter((tile) => tile.owner === player).length;
}

function clampEnergy(value: number): number {
  return Math.max(0, Math.min(MAX_ENERGY, value));
}

function getActionCost(actionType: MatchActionType): number {
  return ACTION_COSTS[actionType];
}

export function isAdjacentToPlayer(
  state: NeonGameState,
  targetX: number,
  targetY: number,
  player: PlayerSlot,
): boolean {
  return getNeighbors(targetX, targetY).some(([nx, ny]) => state.grid[ny][nx].owner === player);
}

export function validateAction(
  rawState: NeonGameState,
  action: MatchAction,
): { valid: boolean; error?: string } {
  const state = normalizeGameState(rawState);
  const { targetX, targetY, player, turnNumber, actionType } = action;

  if (state.status !== "active") return { valid: false, error: "Match is finished" };
  if (turnNumber !== state.turnNumber) return { valid: false, error: "Turn mismatch" };
  if (!["attack", "reinforce", "fortify"].includes(actionType)) {
    return { valid: false, error: "Invalid action type" };
  }
  if (targetX < 0 || targetX >= SIZE || targetY < 0 || targetY >= SIZE) {
    return { valid: false, error: "Invalid coordinates" };
  }

  const energy = state.playerStates[player].energy;
  const cost = getActionCost(actionType);
  if (energy < cost) return { valid: false, error: "Not enough energy" };

  const tile = state.grid[targetY][targetX];
  const adjacent = isAdjacentToPlayer(state, targetX, targetY, player);

  if (actionType === "attack") {
    if (tile.owner === player) return { valid: false, error: "Cannot attack your own territory" };
    if (!adjacent) return { valid: false, error: "Attack target must be adjacent" };
    return { valid: true };
  }

  if (tile.owner !== player) return { valid: false, error: "Target must be your territory" };
  if (!adjacent) return { valid: false, error: "Target must border another owned territory" };

  return { valid: true };
}

export function resolveTurn(rawState: NeonGameState, actions: MatchAction[]): NeonGameState {
  const state = normalizeGameState(rawState);
  const nextGrid = state.grid.map((row) => row.map((tile) => ({ ...tile })));
  const nextPlayerStates: Record<PlayerSlot, NeonPlayerState> = {
    player1: { ...state.playerStates.player1 },
    player2: { ...state.playerStates.player2 },
  };

  for (const action of actions) {
    const workingState = { ...state, grid: nextGrid, playerStates: nextPlayerStates };
    const validation = validateAction(workingState, action);
    if (!validation.valid) continue;

    const tile = nextGrid[action.targetY][action.targetX];
    nextPlayerStates[action.player].energy = clampEnergy(
      nextPlayerStates[action.player].energy - getActionCost(action.actionType),
    );

    if (action.actionType === "reinforce") {
      tile.troops += 1;
      continue;
    }

    if (action.actionType === "fortify") {
      tile.shield += 1;
      continue;
    }

    if (tile.shield > 0) {
      tile.shield -= 1;
    } else if (tile.troops > 0) {
      tile.troops -= 1;
    }

    if (tile.troops <= 0) {
      tile.owner = action.player;
      tile.troops = 2;
      tile.shield = 0;
      tile.capital = false;
    }
  }

  const player1Tiles = countTiles(nextGrid, "player1");
  const player2Tiles = countTiles(nextGrid, "player2");
  const winner = player1Tiles === 0 ? "player2" : player2Tiles === 0 ? "player1" : null;

  return {
    ...state,
    grid: nextGrid,
    turnNumber: state.turnNumber + 1,
    pendingActions: [],
    status: winner ? "finished" : "active",
    winner,
    playerStates: {
      player1: {
        ...nextPlayerStates.player1,
        tilesOwned: player1Tiles,
        energy: clampEnergy(nextPlayerStates.player1.energy + ENERGY_GAIN),
      },
      player2: {
        ...nextPlayerStates.player2,
        tilesOwned: player2Tiles,
        energy: clampEnergy(nextPlayerStates.player2.energy + ENERGY_GAIN),
      },
    },
  };
}

export function pickAiAction(
  rawState: NeonGameState,
  aiPlayer: PlayerSlot,
  aiUserId: string,
): MatchAction | null {
  const state = normalizeGameState(rawState);
  const enemy = aiPlayer === "player1" ? "player2" : "player1";
  const energy = state.playerStates[aiPlayer].energy;
  const baseAction = {
    userId: aiUserId,
    player: aiPlayer,
    turnNumber: state.turnNumber,
  };

  if (energy >= ACTION_COSTS.attack) {
    const attackTargets = state.grid
      .flat()
      .filter((tile) => tile.owner !== aiPlayer && isAdjacentToPlayer(state, tile.x, tile.y, aiPlayer))
      .sort((a, b) => {
        const ownerPriorityA = a.owner === enemy ? 2 : 1;
        const ownerPriorityB = b.owner === enemy ? 2 : 1;
        const weaknessA = 10 - a.troops * 2 - a.shield + (a.capital ? -3 : 0);
        const weaknessB = 10 - b.troops * 2 - b.shield + (b.capital ? -3 : 0);
        return ownerPriorityB - ownerPriorityA || weaknessB - weaknessA;
      });

    if (attackTargets.length) {
      const target = attackTargets[0];
      return { ...baseAction, actionType: "attack", targetX: target.x, targetY: target.y };
    }
  }

  const ownedTargets = state.grid
    .flat()
    .filter((tile) => tile.owner === aiPlayer && isAdjacentToPlayer(state, tile.x, tile.y, aiPlayer));

  const weakOwned = ownedTargets
    .filter((tile) => tile.troops <= 2)
    .sort((a, b) => a.troops - b.troops || a.shield - b.shield);

  if (energy >= ACTION_COSTS.reinforce && weakOwned.length) {
    const target = weakOwned[0];
    return { ...baseAction, actionType: "reinforce", targetX: target.x, targetY: target.y };
  }

  const capital = ownedTargets.find((tile) => tile.capital && tile.shield < 4);
  if (energy >= ACTION_COSTS.fortify && capital && state.turnNumber % 3 === 0) {
    return { ...baseAction, actionType: "fortify", targetX: capital.x, targetY: capital.y };
  }

  const fortifyTarget = ownedTargets.sort((a, b) => a.shield - b.shield || a.troops - b.troops)[0];
  if (energy >= ACTION_COSTS.fortify && fortifyTarget) {
    return {
      ...baseAction,
      actionType: "fortify",
      targetX: fortifyTarget.x,
      targetY: fortifyTarget.y,
    };
  }

  return null;
}
