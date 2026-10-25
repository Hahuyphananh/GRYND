/**
 * Hillstrike — every rule number, tuning value and magic string the PURE engine
 * can emit.
 *
 * Hillstrike is a skill-based 1v1 artillery duel: two players sit on opposite
 * hills of one shared battlefield and each drives a TANK with a pool of HIT
 * POINTS. A direct hit costs HP in proportion to how far the shell flew, and a
 * turn offers three actions — fire, drive closer/farther, or drop a shield
 * block — so the duel is about the trade between range, damage and cover.
 *
 * This module and `./rules` / `./physics` / `./generation` are the single source
 * of truth for those rules; a store, a bot or a board UI is expected to derive
 * from them rather than re-implement them.
 *
 * ── COORDINATES ────────────────────────────────────────────────────────────
 * `x` grows to the right, `y` grows DOWN (screen convention), so y = 0 is the
 * top of the battlefield and `BATTLEFIELD_HEIGHT` is the bottom. A launch angle
 * is measured in degrees counter-clockwise from the +x axis with the same
 * screen flip applied: 0° is straight right, 90° is straight UP (decreasing y),
 * 180° is left. See `directionVector` in ./physics.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * The engine is pure: no randomness, no clocks, no I/O. Battlefield creation is
 * the ONLY place a seed is read, and it goes through the shared
 * `mulberry32` / `hashSeed` primitives (src/lib/physics2d/deterministic.ts), so
 * a battlefield is reproducible forever from `{ seed, FIELD_VERSION }`.
 *
 * That is what makes the SERVER the authority: it simulates the shot and stores
 * the resolved trajectory, and every client animates that same trajectory
 * instead of re-deriving the outcome.
 *
 * ── TRUST BOUNDARY ─────────────────────────────────────────────────────────
 * A caller supplies an ACTION and nothing else: an aim (`{ angleDeg, power }`),
 * a drive direction (`{ direction }`) or an empty build request. There is no
 * field for a position, a hit, an HP total, a terrain height, a structure or a
 * winner, and the engine reads none of those from input. Every consequence —
 * the new standing position, the block that was placed, the damage — is derived
 * here from the state the server already holds.
 */

// ──────────────────────────────────────────────────────────────────────────
// Battlefield
// ──────────────────────────────────────────────────────────────────────────

/**
 * Bump when the generator, the terrain model or any physics constant changes
 * the shape of a match. Stored on the match row, and mixed into the generator
 * seed, so a live match still replays with the rules it was created under.
 */
/**
 * v2 — taller cover walls, HP and the three-action turn. Bumped so a match dealt
 * under v1 (three lives, low towers) still replays with the layout it was dealt.
 */
export const FIELD_VERSION = 2;

/** Playable width, in world units (1 unit = 1 px at 1× render scale). */
export const BATTLEFIELD_WIDTH = 1280;

/** Playable height, in world units. */
export const BATTLEFIELD_HEIGHT = 720;

/**
 * Terrain model: a HEIGHTMAP of one surface y per column.
 *
 * A heightmap (rather than arbitrary polygons) is deliberate: it keeps the
 * collision test O(columns-crossed), makes deformation a bounded integer
 * operation, and means two runs can never disagree about whether a point is
 * inside the ground. Columns are `TERRAIN_COLUMN_WIDTH` wide and the last
 * column ends exactly at `BATTLEFIELD_WIDTH`.
 */
export const TERRAIN_COLUMN_WIDTH = 5;
export const TERRAIN_COLUMNS = BATTLEFIELD_WIDTH / TERRAIN_COLUMN_WIDTH; // 256

/** Highest a hill may rise (smallest surface y). */
export const TERRAIN_MIN_SURFACE_Y = 300;

/** Deepest a valley may sink (largest surface y). It leaves room for a crater. */
export const TERRAIN_MAX_SURFACE_Y = 660;

/** Maximum |Δy| between adjacent columns in a generated battlefield. */
export const TERRAIN_MAX_STEP = 6;

/** Columns at each edge kept flat, so both launchers stand on level ground. */
export const TERRAIN_PLATEAU_COLUMNS = 24;

/** Total height units one shot may ever remove from the terrain. */
export const TERRAIN_CARVE_BUDGET = 320;

/**
 * Distance (world units of actual FLIGHT — the arc, not the straight line) at
 * which a shell has lost all the power it can lose, and the fraction it keeps.
 *
 * This is the game's central trade, and the numbers below are measured against
 * real trajectories (a lob flies far further than the straight line between the
 * tanks), not against the map width. With this curve the scale is simply
 * `1 - flightDistance / 2000`:
 *
 *   point-blank brawl     ≈ 660 flight   → 67% power → 34 damage → 3 hits
 *   driven 120 units in   ≈ 1060 flight  → 47% power → 24 damage
 *   the opening exchange  ≈ 1180 flight  → 41% power → 21 damage → 5 hits
 *   a full-map lob       ≥ 1400 flight   → 30% power → 15 damage → 7 hits
 *
 * So the range dial is worth roughly a hit across a whole duel: closing it buys
 * damage, giving it up denies the same to the opponent, and the same scale
 * shrinks the explosion (see ./physics), so a long shot craters less too.
 */
export const SHOT_POWER_FALLOFF_DISTANCE = 1400;
export const SHOT_POWER_MIN_SCALE = 0.3;

// ──────────────────────────────────────────────────────────────────────────
// Players / hit points
// ──────────────────────────────────────────────────────────────────────────

/** The two seats. A seat is derived from the match, never from a request. */
export const SEATS = ["player1", "player2"] as const;

/**
 * Hit points each tank starts with.
 *
 * 100 is chosen so damage reads as a percentage at a glance, and so the range
 * bands land on clearly different hit counts (see the table on
 * SHOT_POWER_FALLOFF_DISTANCE):
 *
 *   point blank (≈660 flight)    → 34 damage → 3 hits
 *   the opening exchange (≈1180) → 21 damage → 5 hits
 *   a full-map lob (≥1400)       → 15 damage → 7 hits
 *
 * A duel therefore runs three to seven direct hits — long enough for cover and
 * drives to matter, short enough that one good turn moves the bar visibly. A
 * direct hit is also the rarest way to point a shot at a tank: the walls eat
 * most lines, which is what the HP bar is sized against.
 */
export const MAX_HP = 100;

/** Player hit radius (the projectile radius is added on top). */
export const PLAYER_RADIUS = 13;

/** Distance from the battlefield edge to each launcher, in world units. */
export const LAUNCHER_INSET_X = 96;

/** Minimum horizontal distance between the two validated spawn points. */
export const MIN_PLAYER_SEPARATION = 400;

// ──────────────────────────────────────────────────────────────────────────
// Structures (damageable towers)
// ──────────────────────────────────────────────────────────────────────────

/** A tower block is a square of this many world units. */
export const STRUCTURE_BLOCK_SIZE = 26;

/**
 * Blocks per seat at generation, widest row first (bottom → top).
 *
 * Four rows of 26-unit blocks stand 104 units tall — 33% taller than the v1
 * wall — so each tank's cover is a real obstacle: flat shots hit stone, and
 * opening a firing lane means knocking it down. It is also the wall a player
 * hides behind, which is what gives the shield block something to extend.
 */
export const STRUCTURE_ROW_WIDTHS = [5, 4, 3, 2] as const;

/**
 * Hard cap on blocks per seat / per battlefield (a deserialised state may lie).
 *
 * 14 blocks are dealt, so the per-seat cap leaves room for eight shield blocks
 * placed over the course of a match without ever letting the board grow into an
 * unreachable maze.
 */
export const MAX_STRUCTURE_BLOCKS_PER_SEAT = 22;
export const MAX_STRUCTURE_BLOCKS = 44;

/** How many blast hits a block survives. */
export const BLOCK_MAX_INTEGRITY = 2;

/** Horizontal distance from the battlefield edge to a tower's centre. */
export const STRUCTURE_CENTRE_INSET_X = 380;

/** How far a block may move in one collapse pass before it counts as detached. */
export const SUPPORT_TOLERANCE = 0.75;

// ──────────────────────────────────────────────────────────────────────────
// Shot / volley state machine
// ──────────────────────────────────────────────────────────────────────────

/**
 * The agreed opening: the randomly drawn opening seat takes ONE action, the
 * other seat answers with TWO, and from then on the seats alternate two-action
 * volleys.
 *
 * An ACTION is any of the three below — firing, driving or building — so a
 * two-action volley is "drive into range, then fire", or "build cover, then
 * fire", not necessarily two shells.
 */
export const OPENING_ACTIONS = 1;
export const ACTIONS_PER_TURN = 2;

/**
 * The opening seat's single action, and the two actions every later turn gets
 * (see the comment above). Kept as named aliases because a reader of ./rules
 * meets the volley counter far more often than a raw number.
 */
export const OPENING_SHOTS = OPENING_ACTIONS;
export const SHOTS_PER_VOLLEY = ACTIONS_PER_TURN;

/** The three things a turn can spend an action on. */
export const ACTION_TYPES = {
  SHOOT: "shoot",
  MOVE: "move",
  BUILD: "build",
} as const;

/** Which way a drive goes: `forward` closes the range, `back` opens it. */
export const MOVE_DIRECTIONS = {
  FORWARD: "forward",
  BACK: "back",
} as const;

/**
 * How far one drive action moves a tank, and how far it may ever travel from its
 * spawn.
 *
 * 60 units per drive, capped at 120 from the spawn: a tank can never reach its
 * own cover wall (its base starts ~220 units ahead of a spawn), so there is
 * always room to lob over the wall it is hiding behind. Closing the whole 120
 * units shortens a shot's flight by about 10%, which is worth a point or two of
 * damage — and opening it does the same to the opponent's next shot.
 */
export const MOVE_STEP = 60;
export const MOVE_RANGE = 120;

/** Closest a tank may ever stand to a battlefield edge. */
export const MOVE_EDGE_MARGIN = 24;

/**
 * Gap between a tank's hull and a shield block it builds in front of itself.
 * Kept at the hull radius so the block never overlaps the tank that placed it.
 */
export const BUILD_BLOCK_GAP = 3;

/** Canonical angle range: [0, 360). 90° is straight up (see the header). */
export const ANGLE_MIN = 0;
export const ANGLE_MAX = 360;

/** Power is an integer 0…100. Both seats share it; nothing scales by seat. */
export const POWER_MIN = 0;
export const POWER_MAX = 100;

/** Muzzle speed (world units per tick) at power 0 and power 100. */
export const MIN_LAUNCH_SPEED = 4;
export const MAX_LAUNCH_SPEED = 26;

/** Pull distance (px) that maps to 100% power in `aimFromDrag`. */
export const DEFAULT_MAX_PULL = 150;

/** Shorter drags are treated as "not aiming yet". */
export const MIN_PULL = 8;

// ──────────────────────────────────────────────────────────────────────────
// Projectile / simulation limits
// ──────────────────────────────────────────────────────────────────────────

/**
 * THE one projectile. Both seats fire it with identical parameters — there is
 * deliberately no per-seat tuning anywhere in this module or in ./physics.
 */
export const PROJECTILE = Object.freeze({
  radius: 3,
  gravity: 0.5, // world units per tick²
  maxTicks: 600, // hard cap: 10 s of flight at 60 Hz
  substepMaxPx: 4, // maximum travel per collision substep (anti-tunnelling)
  pathSampleEvery: 2, // record a trajectory point every N ticks
});

/** Fixed simulation step. There is no variable timestep and no clock read. */
export const TICK_MS = 1000 / 60;

/** Hard cap on collision substeps per tick (belt-and-braces on substepCount). */
export const MAX_SUBSTEPS_PER_TICK = 16;

/** Recorded trajectory points are capped so a match row stays small. */
export const MAX_PATH_POINTS = 240;

/** Consecutive path points closer than this (per axis) are dropped. */
export const PATH_DEDUPE_TOLERANCE = 0.75;

// ──────────────────────────────────────────────────────────────────────────
// Damage
// ──────────────────────────────────────────────────────────────────────────

/**
 * A direct hit's damage at FULL power (see `damageForDistance` in ./physics).
 *
 * Scaled by the SAME distance falloff that shrinks the explosion, so a shot that
 * flew across the whole map both craters less and hits for less. 50 at full
 * power is what makes the range table on SHOT_POWER_FALLOFF_DISTANCE land on
 * 44 / 31 / 28 / 18 — three hits at point blank, six at the far end of the map.
 */
export const HIT_DAMAGE_MAX = 50;

/**
 * Blast tuning. A faster shot leaves a wider crater and a bigger structural
 * blast, so power is a real trade-off rather than a pure range dial. The impact
 * speed used here is the DISTANCE-SCALED speed (see ./physics), so a long lob
 * explodes small even when it arrives fast. Every value is an integer after
 * rounding, so the damage pass is deterministic.
 */
export const CRATER_MIN_DEPTH = 8;
export const CRATER_MAX_DEPTH = 30;
export const CRATER_MIN_RADIUS = 12;
export const CRATER_MAX_RADIUS = 26;
export const CRATER_DEPTH_PER_SPEED = 0.8;
export const CRATER_RADIUS_PER_SPEED = 0.7;

/** A structure impact craters at this fraction of a terrain impact's depth. */
export const STRUCTURE_CRATER_FACTOR = 0.5;

export const BLOCK_BLAST_MIN_RADIUS = 22;
export const BLOCK_BLAST_MAX_RADIUS = 34;

/**
 * Collapse limits. A collapse is resolved by repeated support passes, never by
 * recursion, and it always terminates: at most `MAX_COLLAPSE_PASSES` passes and
 * `MAX_COLLAPSE_MOVES` block moves per shot. Blocks still unsupported when the
 * budget runs out are removed as rubble (deterministically, by block id).
 */
export const MAX_COLLAPSE_PASSES = 8;
export const MAX_COLLAPSE_MOVES = 256;

// ──────────────────────────────────────────────────────────────────────────
// Vocabulary
// ──────────────────────────────────────────────────────────────────────────

/** Match lifecycle, in the same vocabulary every GRYND store persists. */
export const MATCH_STATUS = {
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
  CANCELLED: "cancelled",
} as const;

/**
 * Why a match ended. The ENGINE only ever produces HP_DEPLETED; the other three
 * are store-level terminal states (a resignation, a lost turn clock and a
 * disconnect) declared here so the whole app shares one vocabulary.
 *
 * LIVES_EXHAUSTED is the v1 spelling, kept because it is already written into
 * stored rows' `result_reason`; readers accept both, writers emit HP_DEPLETED.
 */
export const END_REASONS = {
  HP_DEPLETED: "hp-depleted",
  /** @deprecated v1 rows only — new matches never write this. */
  LIVES_EXHAUSTED: "lives-exhausted",
  RESIGNED: "resigned",
  TIMED_OUT: "timed-out",
  ABANDONED: "abandoned",
} as const;

/**
 * Advisory-lock namespace for the online match store's matchmaking critical
 * section (`pg_advisory_xact_lock(HILLSTRIKE_LOCK_NAMESPACE, 0)`). One namespace
 * per game, exactly like the other PvP stores, so two concurrent callers can
 * never both open a lobby and a caller can never join a lobby being cancelled.
 */
export const HILLSTRIKE_LOCK_NAMESPACE = 0x48535452 & 0x7fffffff; // "HSTR"

/** What the projectile met first. `out-of-bounds` / `timeout` mean no damage. */
export const IMPACT_KINDS = {
  PLAYER: "player",
  BLOCK: "block",
  TERRAIN: "terrain",
  OUT_OF_BOUNDS: "out-of-bounds",
  TIMEOUT: "timeout",
} as const;

/**
 * Machine-readable rejection codes (also the API/UI error key). Checked in this
 * fixed order: shot shape → match lifecycle → seat ownership → turn → shot
 * values, matching the other GRYND engines.
 */
export const REJECTION = {
  INVALID_STATE: "invalid-state",
  INVALID_SEAT: "invalid-seat",
  INVALID_ACTION: "invalid-action",
  INVALID_SHOT: "invalid-shot",
  MOVE_BLOCKED: "move-blocked",
  NO_ACTION_REMAINING: "no-action-remaining",
  MATCH_NOT_PLAYING: "match-not-playing",
  NOT_YOUR_TURN: "not-your-turn",
  NO_SHOTS_REMAINING: "no-shots-remaining",
  ANGLE_INVALID: "angle-invalid",
  POWER_INVALID: "power-invalid",
  INVALID_DIRECTION: "invalid-direction",
  NO_BUILD_SPACE: "no-build-space",
  BLOCK_LIMIT: "block-limit",
} as const;
