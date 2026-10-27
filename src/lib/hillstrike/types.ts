/**
 * Hillstrike — the strongly typed shapes the pure engine reads and writes.
 *
 * Everything here is plain data: JSON-serialisable, immutable by convention
 * (`./rules` returns deeply frozen state) and free of React/HTTP/DB/browser
 * types, so one state object can travel through a Drizzle row, a socket push
 * and a battlefield component unchanged.
 *
 * SECRET STATE: there is none. Hillstrike is perfect information — terrain,
 * both towers, both HP pools and the volley counters are public — so a snapshot
 * projection only has to decide what the VIEWER is (which seat, whose turn),
 * never what to hide.
 */

import type { Vec2 } from "../physics2d/kinematics";
import type {
  END_REASONS,
  IMPACT_KINDS,
  MATCH_STATUS,
  MOVE_DIRECTIONS,
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

/** Which way a drive goes. */
export type MoveDirection =
  (typeof MOVE_DIRECTIONS)[keyof typeof MOVE_DIRECTIONS];

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

/** A drive: close the range (`forward`) or open it (`back`). */
export interface MoveInput {
  readonly direction: MoveDirection;
}

/**
 * The two actions a turn can spend. Each is plain data and each is validated by
 * ./rules from the state the server already holds — an action never carries a
 * hit or a damage figure, and there is no action that places a block: the only
 * structures on the board are the base roofs and the middle tower.
 */
export type HillstrikeAction =
  | { readonly type: "shoot"; readonly angleDeg: number; readonly power: number }
  | { readonly type: "move"; readonly direction: MoveDirection };

/** One action as the ENGINE accepts it (already narrowed and type-tagged). */
export type ActionType = HillstrikeAction["type"];

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
 * One block. Three kinds share the same collision and the same square geometry:
 *
 *   • `roof`  — a base ceiling: INDESTRUCTIBLE and anchored, which is what makes
 *               "sit in your base" safe from above but useless for winning;
 *   • `tower` — the middle wall: damageable, and ANCHORED, so a hole shot into it
 *               stays open instead of being filled by the blocks above it;
 *   • `cover` — a legacy (v3) cover block from when building was an action. New
 *               matches never create one, but a stored match still reads.
 */
export type BlockKind = "cover" | "roof" | "tower";

/**
 * One block: an axis-aligned square whose `(x, y)` is its TOP-LEFT corner and
 * whose `integrity` is how many blast hits it survives.
 *
 * `seat` is the seat that owns the block — a base roof — and `null` for the
 * middle tower, which belongs to neither seat (so "the enemy's cover" and "my
 * cover" can never describe it).
 */
export interface TowerBlock {
  readonly id: number;
  readonly seat: Seat | null;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly integrity: number;
  readonly kind: BlockKind;
}

/** The three pickups the middle of the map deals. */
export type PowerUpKind = "double-damage" | "double-blast" | "heal";

/**
 * One pickup, resting on the terrain at `(x, y)` where `y` is its CENTRE.
 *
 * A tank collects it by driving within `POWERUP_RADIUS` of that centre, so a
 * buff always costs an action in the open.
 */
export interface PowerUp {
  readonly id: number;
  readonly kind: PowerUpKind;
  readonly x: number;
  readonly y: number;
}

/** A seat's armed buffs. Each weapon buff is spent by the NEXT shot fired. */
export interface Buffs {
  readonly doubleDamage: boolean;
  readonly doubleBlast: boolean;
}

/**
 * The battlefield. `terrain` holds one surface y per column (column `c` spans
 * `x ∈ [c·5, (c+1)·5)`), so the ground is a polyline; `blocks` holds the two base
 * roofs and the middle tower, and `pickups` the six buffs dealt either side of
 * it. A pickup is collected once and never returns.
 */
export interface Battlefield {
  readonly version: number;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly number[];
  readonly blocks: readonly TowerBlock[];
  readonly pickups: readonly PowerUp[];
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
  /** The block that was struck, for `kind: "block"`; otherwise null. */
  readonly blockId: number | null;
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
      readonly blockId: number | null;
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
      readonly type: "pickup-collected";
      readonly tick: number;
      readonly seat: Seat;
      readonly pickupId: number;
      readonly kind: PowerUpKind;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "healed";
      readonly tick: number;
      readonly seat: Seat;
      /** The healed seat's HP AFTER the pickup. */
      readonly hp: number;
      readonly amount: number;
    }
  | {
      readonly type: "hp-lost";
      readonly tick: number;
      readonly seat: Seat;
      /** The victim's HP AFTER the hit. */
      readonly hp: number;
      /** How much this hit took, after the distance falloff. */
      readonly damage: number;
    }
  | {
      readonly type: "moved";
      readonly tick: number;
      readonly seat: Seat;
      readonly direction: MoveDirection;
      readonly fromX: number;
      readonly fromY: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "block-built";
      readonly tick: number;
      readonly seat: Seat;
      readonly blockId: number;
      readonly x: number;
      readonly y: number;
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

/** One resolved shell, as recorded on the state and in match history. */
export interface ShotRecord {
  readonly type: "shoot";
  readonly seat: Seat;
  readonly turnIndex: number;
  readonly shot: ShotInput;
  readonly impact: Impact;
  readonly path: readonly Vec2[];
  readonly events: readonly ShotEvent[];
  /** HP taken off the opponent by this shell (0 when it hit cover/ground). */
  readonly damage: number;
  /** Total flight distance, and the power scale it left the shell with. */
  readonly distance: number;
  readonly powerScale: number;
  /** The buffs this shot spent (both consumed by firing, hit or miss). */
  readonly buffs: Buffs;
}

/** One drive, as recorded on the state and in match history. */
export interface MoveRecord {
  readonly type: "move";
  readonly seat: Seat;
  readonly turnIndex: number;
  readonly direction: MoveDirection;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly events: readonly ShotEvent[];
}

/**
 * Whatever the last accepted action resolved to. Discriminated on `type`, so a
 * client animates a shell only when there is one and just re-reads the board for
 * a drive.
 */
export type ActionRecord = ShotRecord | MoveRecord;

/**
 * The whole match, as pure data.
 *
 * When `status` is not `playing` the match accepts nothing further: `turn` and
 * `actionsRemaining` are then informational only, and `winner` /
 * `terminationReason` are the truth.
 */
export interface HillstrikeState {
  readonly status: MatchStatus;
  readonly fieldVersion: number;
  /** The battlefield seed — the battlefield is reproducible from it forever. */
  readonly seed: number;
  /** The randomly drawn seat that took the opening action. */
  readonly openingSeat: Seat;
  /** The ACTIVE seat (the seat allowed to act right now). */
  readonly turn: Seat;
  /** Accepted actions so far. Doubles as the match's version/ply. */
  readonly turnIndex: number;
  /** Actions the ACTIVE seat may still spend in this turn (1 or 2). */
  readonly actionsRemaining: number;
  /** True until the opening seat's single opening shot has been fired. */
  readonly openingShotPending: boolean;
  readonly hp: Readonly<Record<Seat, number>>;
  /** Buffs the ACTIVE shot would spend. Both are cleared the moment one fires. */
  readonly buffs: Readonly<Record<Seat, Buffs>>;
  readonly battlefield: Battlefield;
  readonly projectile: ProjectileSpec;
  readonly winner: Seat | null;
  readonly terminationReason: EndReason | null;
  readonly lastAction: ActionRecord | null;
}

/** Why a specific action is or is not legal. */
export type ActionVerdict =
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
  /** World units the shell actually flew, launch point → impact. */
  readonly distance: number;
  /** The power it had left (1 = full, `SHOT_POWER_MIN_SCALE` = floor). */
  readonly powerScale: number;
}

/** What `applyAction` returns: the next authoritative state plus animation data. */
export interface ApplyActionResult {
  readonly state: HillstrikeState;
  readonly events: readonly ShotEvent[];
}

/** One seat's hit points, for callers that only need the map. */
export type Hp = Readonly<Record<Seat, number>>;
