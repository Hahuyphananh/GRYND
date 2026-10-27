/**
 * Hillstrike — every rule number, tuning value and magic string the PURE engine
 * can emit.
 *
 * Hillstrike is a skill-based 1v1 artillery duel: two players start in ROOFED
 * BASES at the bottom of opposite hills and each drives a TANK with a pool of
 * HIT POINTS. A direct hit costs HP in proportion to how far the shell flew, and
 * a turn offers two actions — fire, or drive closer/farther — so the duel is
 * about leaving the safety of the base, breaking a way through the GIANT TOWER
 * that walls off the middle, and trading range for damage.
 *
 * A match is also timed (`MATCH_DURATION_OPTIONS_MS`): when the clock runs out the
 * tank with more HP wins, and equal HP is a draw. Nothing in the engine reads a
 * clock — the caller decides that time is up and asks `finishOnTime`.
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
 * A caller supplies an ACTION and nothing else: an aim (`{ angleDeg, power }`)
 * or a drive direction (`{ direction }`). There is no field for a position, a
 * hit, an HP total, a terrain height, a structure or a winner, and the engine
 * reads none of those from input. Every consequence — the new standing position,
 * the damage, the tower blocks that broke — is derived here from the state the
 * server already holds.
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
 * v4 — the giant middle TOWER, one set of power-ups on each side of it, no
 * respawning pickups, no build action and a match clock. Bumped so a match dealt
 * under v1 (three lives, low towers), v2 (cover walls, no roofs) or v3 (buildable
 * cover, respawning pickups) still replays with the layout it was dealt.
 */
export const FIELD_VERSION = 4;

/**
 * Playable width, in world units (1 unit = 1 px at 1× render scale).
 * Twice the v2 width: the duel is now about the climb to the middle, not about
 * lobbing across a short valley.
 */
export const BATTLEFIELD_WIDTH = 2560;

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
export const TERRAIN_MIN_SURFACE_Y = 120;

/** Deepest a valley may sink (largest surface y). It leaves room for a crater. */
export const TERRAIN_MAX_SURFACE_Y = 660;

/**
 * The surface height of a spawn shelf.
 *
 * Both bases sit in the LOW ground at the foot of the map's central massif, so
 * the only way to see (and reach) the middle is to drive UP the hill. Together
 * with the indestructible roof over each spawn, that is what pushes a camper out
 * of its base instead of letting it lob from perfect cover forever.
 */
export const SPAWN_SURFACE_Y = 620;

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
 *   point-blank brawl    ≈ 660 flight   → 76% power → 38 damage → 3 hits
 *   a climb to the middle ≈ 1400 flight → 50% power → 25 damage
 *   across the whole map ≈ 2500 flight  → 32% power → 16 damage → 7 hits
 *
 * So the range dial is worth roughly a hit across a whole duel: closing it buys
 * damage, giving it up denies the same to the opponent, and the same scale
 * shrinks the explosion (see ./physics), so a long shot craters less too.
 */
export const SHOT_POWER_FALLOFF_DISTANCE = 2800;
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
 *   point blank (≈660 flight)    → 38 damage → 3 hits
 *   a mid-map exchange (≈1400)   → 25 damage → 4 hits
 *   across the whole map (≥2500) → 16 damage → 7 hits
 *
 * A duel therefore runs three to seven direct hits — long enough for the climb,
 * cover and the power-ups to matter, short enough that one good turn moves the
 * bar visibly.
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
 * A base roof: the indestructible ceiling over each tank's SPAWN.
 *
 * It replaces the v2 cover wall. There is no wall in front of a tank any more —
 * nothing blocks a flat shot — but nothing can be dropped in from above onto a
 * tank that has not left its base either, so "sit at spawn and lob" is no longer
 * a winning plan. The roof is FIXED at the starting position: driving out from
 * under it is how a player earns the map, and the only cover out there is what
 * they build themselves.
 */
export const BASE_ROOF_BLOCKS = 3;
/**
 * Height of the roof's underside above the spawn shelf. 130 units clears the
 * tank (about 40 units tall) with room to fire a shallow lob out from under it,
 * while still stopping a steep drop from above.
 */
export const BASE_ROOF_CLEARANCE = 130;

/**
 * Hard cap on blocks held by one battlefield (a deserialised state may lie).
 *
 * It has to cover the two base roofs AND the whole middle tower, whose columns
 * run from the sky to the ground: three tower columns of up to 28 blocks are 84,
 * plus six roof blocks, plus the slack a legacy row's cover needs.
 */
export const MAX_STRUCTURE_BLOCKS = 160;

/**
 * How many blast hits a cover block or a base roof survives.
 *
 * ONE: a projectile that reaches a cover block destroys it outright, however far
 * it flew. Distance is a dial for HP damage on tanks, never for structures or
 * ground — a shell is a shell when it lands. Base roofs are indestructible
 * outright and never take a hit at all.
 */
export const BLOCK_MAX_INTEGRITY = 1;

/**
 * The middle TOWER: a wall of anchored, damageable blocks across the centre of
 * the map, from the ground to the sky.
 *
 * It is the map's one gate. Nothing crosses the centre until a lane of it has
 * been shot away — including a lob, because it reaches y = 0 and anything fired
 * above the battlefield is out of bounds. Its blocks are ANCHORED (no collapse),
 * so a hole stays a hole instead of being filled by the blocks above it.
 */
export const TOWER_COLUMNS = 3;
/** The tower's top edge: the first row of blocks starts at the sky. */
export const TOWER_TOP_Y = 0;
/**
 * Blast hits one tower block survives. Twice a cover block: the whole middle is
 * one obstacle, and a shell that merely clips it should not open the map.
 */
export const TOWER_BLOCK_INTEGRITY = 2;

/** Hard cap on tower blocks a battlefield may hold (a deserialised state may lie). */
export const MAX_TOWER_BLOCKS =
  TOWER_COLUMNS * Math.ceil(BATTLEFIELD_HEIGHT / STRUCTURE_BLOCK_SIZE);

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
 * An ACTION is either of the two below — firing or driving — so a two-action
 * volley is "drive into range, then fire", not necessarily two shells.
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

/** The two things a turn can spend an action on. */
export const ACTION_TYPES = {
  SHOOT: "shoot",
  MOVE: "move",
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
 * 120 units per drive, capped at 1180 from the spawn — the leash reaches the
 * middle of the doubled map, which is where the power-ups are. Climbing out of
 * the base is therefore a real commitment of turns: closing the range buys HP
 * damage, and the middle is the only place to get a buff.
 */
export const MOVE_STEP = 120;
export const MOVE_RANGE = 1180;

/** Closest a tank may ever stand to a battlefield edge. */
export const MOVE_EDGE_MARGIN = 24;

/** Canonical angle range: [0, 360). 90° is straight up (see the header). */
export const ANGLE_MIN = 0;
export const ANGLE_MAX = 360;

/** Power is an integer 0…100. Both seats share it; nothing scales by seat. */
export const POWER_MIN = 0;
export const POWER_MAX = 100;

/**
 * Muzzle speed (world units per tick) at power 0 and power 100.
 *
 * Raised with the map: range grows with v²/g, and the doubled battlefield needs
 * a full-power lob to reach the far hill (`MAX_LAUNCH_SPEED² / gravity` ≈ 3200
 * units of range against a 2560-unit map).
 */
export const MIN_LAUNCH_SPEED = 6;
export const MAX_LAUNCH_SPEED = 40;

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
 * THE only thing flight distance changes. One number, `damageForDistance`, so a
 * shot across the whole map still hurts — just for less. 50 at full power is what
 * makes the range table on SHOT_POWER_FALLOFF_DISTANCE land on 38 / 25 / 16.
 */
export const HIT_DAMAGE_MAX = 50;

/**
 * Blast tuning — FIXED, deliberately independent of distance.
 *
 * A shell that lands carves the same crater and cracks the same radius whatever
 * the range: distance is a dial for HP damage on tanks and for nothing else. The
 * only thing that scales a blast is the `double-blast` power-up.
 */
export const CRATER_DEPTH = 26;
export const CRATER_RADIUS = 30;
/** A block impact carves this fraction of a terrain crater's depth. */
export const BLOCK_CRATER_FACTOR = 0.5;
/** Blocks within this radius of a blast lose their integrity (and break). */
export const BLOCK_BLAST_RADIUS = 30;

// ──────────────────────────────────────────────────────────────────────────
// Power-ups (middle of the map)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The three pickups that make the middle worth the climb. A tank collects one by
 * DRIVING onto it, so a buff always costs turn tempo in the open.
 */
export const POWERUP_KINDS = {
  DOUBLE_DAMAGE: "double-damage",
  DOUBLE_BLAST: "double-blast",
  HEAL: "heal",
} as const;

/** How close a tank must drive to a pickup to collect it (centre distance). */
export const POWERUP_RADIUS = 26;

/** HP a `heal` pickup restores, capped at MAX_HP. */
export const POWERUP_HEAL_AMOUNT = 35;

/** `double-damage` multiplies the NEXT shot's HP damage. */
export const POWERUP_DAMAGE_MULTIPLIER = 2;

/** `double-blast` multiplies the NEXT shot's crater and structural blast. */
export const POWERUP_BLAST_MULTIPLIER = 2;

/**
 * Where the pickups sit: ONE of each kind on each side of the middle tower, on
 * lanes measured from the centre of the map. The near lane (a heal) is just
 * outside the tower's face, so a tank has to drive up to the tower to take it.
 * Every lane has a mirror on the other side, so neither seat gets a shorter run.
 */
export const POWERUP_LANE_GAP = 70;

/**
 * Hard cap on pickups a battlefield may deal (a deserialised state may lie).
 * Six are dealt — three kinds on each side of the tower — and they never return.
 */
export const MAX_POWERUPS = 8;

/**
 * How far the hard tier will walk toward a power-up at all: beyond this it takes
 * a shot instead, because a lane it cannot reach this match is not worth an
 * action.
 */
export const POWERUP_CHASE_DRIVES = 8;

/**
 * Inside this range the walk becomes a SPRINT (both actions of the turn), so a
 * lane it has already walked to is actually taken instead of being abandoned one
 * step short when the match ends.
 */
export const POWERUP_SPRINT_DRIVES = 2;

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
  /** The match clock ran out: more HP wins, equal HP is a draw. */
  TIMED_OUT: "timed-out",
  ABANDONED: "abandoned",
} as const;

/**
 * The match clocks a lobby can be created with, in milliseconds.
 *
 * Chess clocks, as the brief puts it: five, ten or fifteen minutes. The clock is
 * fixed when the match is created and is the same for both seats.
 */
export const MATCH_DURATION_OPTIONS_MS = [300_000, 600_000, 900_000] as const;

/** The clock a match gets when the caller does not choose one: ten minutes. */
export const DEFAULT_MATCH_DURATION_MS = 600_000;

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
} as const;

/** True when `value` is one of the clocks a match may be created with. */
export function isMatchDurationMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    (MATCH_DURATION_OPTIONS_MS as readonly number[]).includes(value)
  );
}
