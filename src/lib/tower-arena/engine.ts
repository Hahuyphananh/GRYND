// src/lib/tower-arena/engine.ts
//
// Deterministic, server-authoritative Tower Arena engine.
// Blocks fall vertically onto the highest support below their footprint and
// become fixed. The only losing placement is one that crosses the ceiling.

export const GRID_WIDTH = 12;
export const GRID_DEPTH = 1;
export const CEILING_HEIGHT = 18;
export const BLOCK_HEIGHT = 1;
export const OVERHANG_ALLOWANCE = 0;
export const SLIDE_BUDGET = 0;

export const BLOCK_SHAPES = ["I", "L", "T", "square", "short"] as const;
export type BlockShape = (typeof BLOCK_SHAPES)[number];

export const BLOCK_DIMS: Record<BlockShape, { w: number; h: number }> = {
  I: { w: 3, h: 1 },
  L: { w: 1, h: 2 },
  T: { w: 2, h: 2 },
  square: { w: 2, h: 1 },
  short: { w: 1, h: 1 },
};

export const BLOCK_FOOTPRINTS: Record<BlockShape, Array<[number, number]>> = {
  I: [[0, 0], [1, 0], [2, 0]],
  L: [[0, 0], [0, 1]],
  T: [[0, 0], [1, 0], [0, 1], [1, 1]],
  square: [[0, 0], [1, 0]],
  short: [[0, 0]],
};

function normalizedRotation(rotation: number): number {
  if (!Number.isInteger(rotation)) return 0;
  return ((rotation % 4) + 4) % 4;
}

export function blockWidth(shape: BlockShape, rotation: number): number {
  const { w, h } = BLOCK_DIMS[shape];
  return normalizedRotation(rotation) % 2 === 1 ? h : w;
}

export function blockHeight(shape: BlockShape, rotation: number): number {
  const { w, h } = BLOCK_DIMS[shape];
  return normalizedRotation(rotation) % 2 === 1 ? w : h;
}

export function blockCells(shape: BlockShape, rotation: number): Array<[number, number]> {
  const width = blockWidth(shape, rotation);
  const height = blockHeight(shape, rotation);
  const cells: Array<[number, number]> = [];
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < height; z += 1) cells.push([x, z]);
  }
  return cells;
}

export const footprintFor = blockCells;

export function footprintExtent(shape: BlockShape, rotation: number): { maxX: number; maxDepth: number } {
  return { maxX: blockWidth(shape, rotation) - 1, maxDepth: blockHeight(shape, rotation) - 1 };
}

export function dropRangeFor(shape: BlockShape, rotation: number): { minX: number; maxX: number } {
  return { minX: 0, maxX: GRID_WIDTH - blockWidth(shape, rotation) };
}

export function dropInBounds(shape: BlockShape, rotation: number, x: number): boolean {
  const { minX, maxX } = dropRangeFor(shape, rotation);
  return Number.isInteger(x) && x >= minX && x <= maxX;
}

export function centerXFor(shape: BlockShape, rotation: number): number {
  return Math.max(0, Math.floor((GRID_WIDTH - blockWidth(shape, rotation)) / 2));
}

export function centerDepthFor(_shape?: BlockShape, _rotation?: number): number {
  return 0;
}

export function fitsInGrid(cells: Array<[number, number]>, anchorX: number, _anchorDepth?: number): boolean {
  return cells.every(([x]) => anchorX + x >= 0 && anchorX + x < GRID_WIDTH);
}

export interface TowerCell {
  x: number;
  depth: number;
  z: number;
}

export interface TowerBlock {
  id: string;
  shape: string;
  rotation: number;
  x: number;
  depth: number;
  z: number;
  width: number;
  height: number;
  cells: TowerCell[];
  placedByUserId: string;
  turnNumber: number;
}

export type TowerState = TowerBlock[];

export interface PlacementOutcome {
  stable: boolean;
  collapsed: boolean;
  tower: TowerState;
  removedBlockIds: string[];
  placedBlock: TowerBlock | null;
  fallenBlocks: TowerBlock[];
  slid: boolean;
  finalX: number;
}

function heightMap(tower: TowerState): number[] {
  const heights = new Array<number>(GRID_WIDTH).fill(0);
  for (const block of tower) {
    for (const cell of block.cells || []) {
      if (cell.x >= 0 && cell.x < GRID_WIDTH) heights[cell.x] = Math.max(heights[cell.x], cell.z);
    }
  }
  return heights;
}

function blockTopZ(block: TowerBlock): number {
  return (block.cells || []).reduce((max, cell) => Math.max(max, cell.z), -Infinity);
}

function cloneBlockWithCells(block: TowerBlock, cells: TowerCell[]): TowerBlock {
  if (cells.length === 0) return { ...block, cells: [], z: -1 };
  const minX = Math.min(...cells.map((cell) => cell.x));
  const minZ = Math.min(...cells.map((cell) => cell.z));
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const maxZ = Math.max(...cells.map((cell) => cell.z));
  return {
    ...block,
    x: minX,
    z: minZ,
    width: maxX - minX + 1,
    height: maxZ - minZ + 1,
    cells,
  };
}

function rebaseTower(tower: TowerState): TowerState {
  if (tower.length === 0) return [];
  const minZ = Math.min(...tower.flatMap((block) => (block.cells || []).map((cell) => cell.z)));
  const shift = minZ - 1;
  if (shift === 0) return tower;
  return tower.map((block) => cloneBlockWithCells(
    block,
    (block.cells || []).map((cell) => ({ ...cell, z: cell.z - shift })),
  ));
}

/**
 * First ceiling elimination keeps the bottom half. Later eliminations keep the
 * top quarter of the current tower. Retained cells are rebased to the floor.
 */
export function trimTowerAfterElimination(
  tower: TowerState,
  eliminationNumber: number,
): { tower: TowerState; removedBlockIds: string[] } {
  if (tower.length === 0) return { tower: [], removedBlockIds: [] };
  const maxZ = Math.max(...tower.flatMap((block) => (block.cells || []).map((cell) => cell.z)), 0);
  if (maxZ <= 0) return { tower: [], removedBlockIds: tower.map((block) => block.id) };

  const keepBottom = eliminationNumber <= 1;
  const boundary = keepBottom
    ? Math.max(1, Math.floor(maxZ / 2))
    : Math.max(1, Math.ceil((maxZ * 3) / 4));
  const keepCell = (z: number) => keepBottom ? z <= boundary : z >= boundary;
  const keptIds = new Set<string>();
  const retained: TowerState = [];

  for (const block of tower) {
    const cells = (block.cells || []).filter((cell) => keepCell(cell.z));
    if (cells.length > 0) {
      keptIds.add(block.id);
      retained.push(cloneBlockWithCells(block, cells));
    }
  }

  return {
    tower: rebaseTower(retained),
    removedBlockIds: tower.filter((block) => !keptIds.has(block.id)).map((block) => block.id),
  };
}

export function applyPlacementBlock(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): TowerBlock {
  const rotation = normalizedRotation(params.rotation ?? 0);
  const cells2 = blockCells(params.shape, rotation);
  const heights = heightMap(tower);
  let maxUnder = 0;
  for (const [rx] of cells2) maxUnder = Math.max(maxUnder, heights[params.x + rx] || 0);
  const z = dropInBounds(params.shape, rotation, params.x) ? maxUnder + 1 : -1;
  return {
    id: params.blockId,
    shape: params.shape,
    rotation,
    x: params.x,
    depth: 0,
    z,
    width: blockWidth(params.shape, rotation),
    height: blockHeight(params.shape, rotation),
    cells: z >= 1 ? cells2.map(([rx, rz]) => ({ x: params.x + rx, depth: 0, z: z + rz })) : [],
    placedByUserId: params.placedByUserId,
    turnNumber: params.turnNumber,
  };
}

export function wouldFall(block: TowerBlock, tower: TowerState): boolean {
  if (block.cells.length === 0 || blockTopZ(block) > CEILING_HEIGHT) return true;
  const occupied = new Set<string>();
  for (const existing of tower) {
    for (const cell of existing.cells) occupied.add(`${cell.x}:${cell.z}`);
  }
  return block.cells.some((cell) => occupied.has(`${cell.x}:${cell.z}`));
}

export function isStable(tower: TowerState): boolean {
  const occupied = new Set<string>();
  for (const block of tower) {
    if (!block.cells || block.cells.length === 0) return false;
    if (block.cells.some((cell) => cell.x < 0 || cell.x >= GRID_WIDTH || cell.z < 1 || cell.z > CEILING_HEIGHT)) return false;
    for (const cell of block.cells) {
      const key = `${cell.x}:${cell.z}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }
  }
  return true;
}

/** Compatibility export retained for callers from the old physics engine. */
export function stackUnstable(_block: TowerBlock, _tower: TowerState): boolean {
  return false;
}

/** Compatibility export retained for callers from the old physics engine. */
export function shedUnstableStacks(tower: TowerState): { tower: TowerState; fallen: TowerBlock[] } {
  return { tower: tower.slice(), fallen: [] };
}

export function simulatePlacement(
  tower: TowerState,
  params: {
    shape: BlockShape;
    x: number;
    rotation?: number;
    blockId: string;
    placedByUserId: string;
    turnNumber: number;
  },
): PlacementOutcome {
  const placed = applyPlacementBlock(tower, params);
  if (placed.cells.length === 0 || blockTopZ(placed) > CEILING_HEIGHT) {
    return {
      stable: false,
      collapsed: true,
      tower: tower.slice(),
      removedBlockIds: [placed.id],
      placedBlock: placed,
      fallenBlocks: [placed],
      slid: false,
      finalX: placed.x,
    };
  }
  return {
    stable: true,
    collapsed: false,
    tower: [...tower, placed],
    removedBlockIds: [],
    placedBlock: placed,
    fallenBlocks: [],
    slid: false,
    finalX: placed.x,
  };
}

export function findSafeDrop(
  tower: TowerState,
  available: BlockShape[],
): { shape: BlockShape; x: number; rotation: number } | null {
  const preference: BlockShape[] = ["short", "square", "I", "T", "L"];
  for (const shape of preference) {
    if (!available.includes(shape)) continue;
    for (const rotation of [0, 1]) {
      const { minX, maxX } = dropRangeFor(shape, rotation);
      const center = centerXFor(shape, rotation);
      const attempts: number[] = [];
      for (let distance = 0; distance <= GRID_WIDTH; distance += 1) {
        const left = center - distance;
        const right = center + distance;
        if (left >= minX && !attempts.includes(left)) attempts.push(left);
        if (right <= maxX && !attempts.includes(right)) attempts.push(right);
      }
      for (const x of attempts) {
        const result = simulatePlacement(tower, {
          shape, x, rotation, blockId: "probe", placedByUserId: "", turnNumber: 0,
        });
        if (!result.collapsed) return { shape, x, rotation };
      }
    }
  }
  return null;
}

export interface ResourcePiece {
  id: string;
  shape: BlockShape;
}

const CYCLE_SHAPES_PER_PLAYER: Record<number, number> = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 };

function poolComposition(maxPlayers: number): BlockShape[] {
  const playerCount = Math.max(2, Math.min(6, Math.trunc(maxPlayers)));
  const perShape = CYCLE_SHAPES_PER_PLAYER[playerCount] ?? 2;
  const shapes: BlockShape[] = [];
  for (const shape of BLOCK_SHAPES) {
    for (let i = 0; i < perShape; i += 1) shapes.push(shape);
  }
  return shapes;
}

function seededRandom(seed: string): () => number {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) value = (value + seed.charCodeAt(i)) | 0;
  return () => {
    value = Math.imul(value + 0x6d2b79f5, 1664525) + 1013904223;
    return (value >>> 0) / 4294967296;
  };
}

export function buildResourcePool(maxPlayers: number, nonce: string): ResourcePiece[] {
  const shapes = poolComposition(maxPlayers);
  const random = seededRandom(`tower-arena:${nonce}:${maxPlayers}`);
  for (let i = shapes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shapes[i], shapes[j]] = [shapes[j], shapes[i]];
  }
  return shapes.map((shape, index) => ({ id: `p:${nonce}:${index}`, shape }));
}

export function takeFromPool(pool: ResourcePiece[], shape: BlockShape): { pool: ResourcePiece[]; piece: ResourcePiece | null } {
  const index = pool.findIndex((piece) => piece.shape === shape);
  if (index < 0) return { pool, piece: null };
  const next = pool.slice();
  const [piece] = next.splice(index, 1);
  return { pool: next, piece };
}

export function refillResourcePool(pool: ResourcePiece[], maxPlayers: number, nonce: string): ResourcePiece[] {
  return [...pool, ...buildResourcePool(maxPlayers, nonce)];
}
