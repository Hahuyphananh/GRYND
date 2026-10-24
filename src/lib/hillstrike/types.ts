/**
 * Hillstrike — the strongly typed shapes the pure engine reads and writes.
 *
 * Everything here is plain data: JSON-serialisable, immutable by convention
 * (`./rules` returns deeply frozen state) and free of React/HTTP/DB/browser
 * types, so one state object can travel through a Drizzle row, a socket push
 * and a battlefield component unchanged.
 *
 * SECRET STATE: there is none. Hillstrike is perfect information — terrain,
 * both towers, both lives and the volley counters are public — so a snapshot
 * projection only has to decide what the VIEWER is (which seat, whose turn),
 * never what to hide.
 */

import type { Vec2 } from "../physics2d/kinematics";
import type {
  END_REASONS,
  IMPACT_KINDS,
  MATCH_STATUS,
  REJECTION,
  SEATS,
} from "./constants";

/** Who the state belongs to. Derived from the match's seats, never a request. */
export type Seat = (typeof SEATS)[number];

/** Match lifecycle. The engine only produces `playing` and `finished`. */
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

/** Why a match ended. The engine emits `lives-exhausted` only. */
export type EndReason = (typeof END_REASONS)[keyof typeof END_REASONS];

/** What the projectile met first. */
export type ImpactKind = (typeof IMPACT_KINDS)[keyof typeof IMPACT_KINDS];

/** Machine-readable rejection code. */
export type RejectionCode = (typeof REJECTION)[keyof typeof REJECTION];

/**
 * A shot as a caller may submit it: a direction and a power, and nothing else.
 *
 * `angleDeg` is in [0, 360) measured counter-clockwise from +x with the screen
 * flip applied (90° is straight up). `power` is an integer in [0, 100].
 */
export interface ShotInput {
  readonly angleDeg: number;
  readonly power: number;
}

/**
 * The ONE projectile specification, snapshotted into the match state so a
 * replay is independent of later tuning. Both seats always share this object:
 * `./rules` copies it from the frozen `PROJECTILE` constant at creation and
 * never varies it per seat.
 */
export interface ProjectileSpec {
  readonly radius: number;
  readonly gravity: number;
  readonly maxTicks: number;
  readonly substepMaxPx: number;
  readonly pathSampleEvery: number;
  readonly launchSpeedMin: number;
  readonly launchSpeedMax: number;
}

/** A player's standing position, on the terrain surface at their spawn x. */
export interface Player {
  readonly seat: Seat;
  readonly x: number;
  readonly y: number;
}

/**
 * One damageable tower block: an axis-aligned square whose `(x, y)` is its
 * TOP-LEFT corner and whose `integrity` is how many blast hits it survives.
 */
export interface TowerBlock {
  readonly id: number;
  readonly seat: Seat;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly integrity: number;
}

/**
 * The battlefield. `terrain` holds one surface y per column (column `c` spans
 * `x ∈ [c·5, (c+1)·5)`), so the ground is a polyline and the whole map is two
 * arrays plus at most `MAX_STRUCTURE_BLOCKS` blocks.
 */
export interface Battlefield {
  readonly version: number;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly number[];
  readonly blocks: readonly TowerBlock[];
  readonly players: Readonly<Record<Seat, Player>>;
}

/** Where a shot stopped, and what it met there. */
export interface Impact {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
  readonly kind: ImpactKind;
  /** The seat that was hit, for `kind: "player"`; otherwise null. */
  readonly target: Seat | null;
}

/** The client-facing animation record of one accepted shot. */
export type ShotEvent =
  | {
      readonly type: "launch";
      readonly tick: number;
      readonly seat: Seat;
      readonly angleDeg: number;
      readonly power: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "impact";
      readonly tick: number;
      readonly x: number;
      readonly y: number;
      readonly kind: ImpactKind;
      readonly target: Seat | null;
    }
  | {
      readonly type: "block-damaged";
      readonly tick: number;
      readonly blockId: number;
      readonly integrity: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "block-destroyed";
      readonly tick: number;
      readonly blockId: number;
      readonly x: number;
      readonly y: number;
      readonly cause: "damage" | "collapse";
    }
  | {
      readonly type: "terrain-carved";
      readonly tick: number;
      readonly x: number;
      readonly y: number;
      readonly fromColumn: number;
      readonly toColumn: number;
    }
  | {
      readonly type: "collapse";
      readonly tick: number;
      readonly blockId: number;
      readonly fromX: number;
      readonly fromY: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "player-hit";
      readonly tick: number;
      readonly seat: Seat;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "life-lost";
      readonly tick: number;
      readonly seat: Seat;
      readonly lives: number;
    }
  | {
      readonly type: "match-ended";
      readonly tick: number;
      readonly winner: Seat;
      readonly reason: EndReason;
    }
  | {
      readonly type: "settled";
      readonly tick: number;
      readonly x: number;
      readonly y: number;
    };

/** One accepted shot, as recorded on the state and in match history. */
export interface ShotRecord {
  readonly seat: Seat;
  readonly turnIndex: number;
  readonly shot: ShotInput;
  readonly impact: Impact;
  readonly path: readonly Vec2[];
  readonly events: readonly ShotEvent[];
  readonly livesLost: number;
}

/**
 * The whole match, as pure data.
 *
 * When `status` is not `playing` the match accepts nothing further: `turn` and
 * `shotsRemaining` are then informational only, and `winner` /
 * `terminationReason` are the truth.
 */
export interface HillstrikeState {
  readonly status: MatchStatus;
  readonly fieldVersion: number;
  /** The battlefield seed — the battlefield is reproducible from it forever. */
  readonly seed: number;
  /** The randomly drawn seat that fired the opening shot. */
  readonly openingSeat: Seat;
  /** The ACTIVE seat (the seat allowed to shoot right now). */
  readonly turn: Seat;
  /** Accepted shots so far. Doubles as the match's version/ply. */
  readonly turnIndex: number;
  /** Shots the ACTIVE seat may still fire in the current volley (1 or 2). */
  readonly shotsRemaining: number;
  /** True until the opening seat's single opening shot has been fired. */
  readonly openingShotPending: boolean;
  readonly lives: Readonly<Record<Seat, number>>;
  readonly battlefield: Battlefield;
  readonly projectile: ProjectileSpec;
  readonly winner: Seat | null;
  readonly terminationReason: EndReason | null;
  readonly lastShot: ShotRecord | null;
}

/** Why a specific shot is or is not legal. */
export type ShotVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string };

/** The result of validating a battlefield (used by the generator and tests). */
export type BattlefieldVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** What `simulateShot` resolves. `battlefield` is the post-impact battlefield. */
export interface ShotSimulation {
  readonly path: readonly Vec2[];
  readonly impact: Impact;
  readonly events: readonly ShotEvent[];
  readonly battlefield: Battlefield;
  readonly ticks: number;
}

/** What `applyShot` returns: the next authoritative state plus animation data. */
export interface ApplyShotResult {
  readonly state: HillstrikeState;
  readonly events: readonly ShotEvent[];
}

/** One seat's lives, for callers that only need the number. */
export type Lives = Readonly<Record<Seat, number>>;
