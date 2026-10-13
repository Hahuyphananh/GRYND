/**
 * Chess VS-AI — game creation: request validation and the persisted row.
 *
 * WHY THIS IS A MODULE AND NOT JUST THE ROUTE
 * ------------------------------------------
 * The route is the only thing that may touch a request/session, but everything
 * ABOUT creating a game is a decision worth testing on its own: which tier a
 * body means, whether it is legal at all, which colour the server resolves, and
 * which seat each player is written into. Keeping those decisions here means the
 * route cannot quietly diverge from what the tests pin, and the tests do not
 * have to import a Next route to reach them.
 *
 * The one impure step — the INSERT — is injected by the route, so the whole flow
 * runs in a test against a fake that records the row it was asked to write. No
 * database is needed to prove what gets persisted.
 *
 * WHAT THE CLIENT MAY AND MAY NOT DECIDE
 * --------------------------------------
 * The body is a REQUEST, never a fact. It says which tier and which colour were
 * asked for; the server validates the tier, resolves the colour (including
 * `random`), assigns both seats, and reports the result back. A client cannot
 * name a seat, and cannot name a player it is not — that comes from the session.
 */

import {
  DEFAULT_CHESS_AI_DIFFICULTY,
  CHESS_AI_DIFFICULTY_LEVELS,
  coerceChessAiDifficulty,
  isChessAiDifficulty,
  type ChessAiDifficulty,
} from "./chessDifficulty";
import {
  chessSeatsForHumanColor,
  isChessColorChoice,
  resolveChessHumanColor,
  type ChessColorChoice,
  type ChessSeatColor,
} from "./chessAiSeat";

/**
 * The colour a request with no usable colour resolves to.
 *
 * `random` rather than a fixed colour, for two reasons: it is what the lobby's
 * picker already defaults to, and it keeps the server from ASSUMING the human is
 * White — the assumption this whole change exists to remove. The server decides,
 * and the creation response reports the decision, so nothing downstream has to
 * guess.
 */
export const DEFAULT_CHESS_COLOR_CHOICE: ChessColorChoice = "random";

/** The row a VS-AI game is created with. Every field is explicit. */
export type ChessAiGameInsert = {
  playerWhiteId: string;
  playerBlackId: string;
  betAmount: string;
  timerMode: string;
  initialTimeSeconds: number;
  isAiGame: true;
  status: "in_progress";
  /**
   * The tier, persisted so the row records the strength that will produce its
   * own move history (migration 0211). NEVER left to a client default: a row
   * whose opponent strength is unknown cannot be audited later.
   */
  aiDifficulty: ChessAiDifficulty;
};

/**
 * The initial clock a VS-AI game has always been created with. Unchanged by this
 * stage — the AI board owns its own clock today, and moving that is a later
 * stage's job.
 */
export const CHESS_AI_GAME_INITIAL_TIME_SECONDS = 300;

/** A validation failure. `status` is the HTTP status the route answers with. */
export type ChessAiGameRequestError = {
  ok: false;
  status: 400;
  error: string;
};

/** An accepted request: what to persist, and what to report back. */
export type ChessAiGameRequest = {
  ok: true;
  difficulty: ChessAiDifficulty;
  /** Still a request at this point — `random` is resolved at creation. */
  color: ChessColorChoice;
};

/** The creation response. `gameId` last, so the seat facts read first. */
export type ChessAiGameCreated = {
  ok: true;
  gameId: string;
  /** The colour the HUMAN plays — resolved by the server, not the browser. */
  humanColor: ChessSeatColor;
  /** The tier that was persisted. */
  aiDifficulty: ChessAiDifficulty;
  /** The same tier on the legacy 1–5 scale the board still displays. */
  difficultyLevel: number;
};

export type CreateChessAiGameResult = ChessAiGameCreated | {
  ok: false;
  status: 400 | 500;
  error: string;
};

const VALID_DIFFICULTY_MESSAGE =
  "Invalid difficulty: expected easy, medium or hard";
const VALID_COLOR_MESSAGE = "Invalid color: expected white, black or random";

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * Normalise the FORM of a tier string without loosening its VOCABULARY:
 * `" Easy "` is the same request as `"easy"`, while `"normal"` — the shared
 * casino scale's middle tier, which is a different vocabulary — is not accepted
 * here. The caller maps its own vocabulary into chess's before asking (that is
 * what `coerceChessAiDifficulty` is for); a route that guessed would persist a
 * tier nobody chose.
 */
function normalizeTierValue(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Validate a creation body.
 *
 * Rules, in order:
 *
 *   1. `difficulty` — when present it is the authority, and it must be a
 *      canonical chess tier after trimming and lower-casing. Anything else is a
 *      400: an explicitly requested tier we do not implement is a request we
 *      cannot honour, and silently playing at Medium when a player asked for
 *      something else is worse than telling them no. (`"insane"` is a real alias
 *      the shared coercer understands, and it is deliberately still rejected
 *      here — this route implements three tiers, so it accepts three spellings.)
 *   2. `difficultyLevel` — the pre-tier 1–5 numeric scale, sent by cached
 *      clients that predate `difficulty`. It is COERCED, never rejected, using
 *      the same shared coercer as everywhere else (1–2 → easy, 3 → medium,
 *      4–5 → hard), so those clients keep the tier their user picked rather than
 *      being quietly moved to the default.
 *   3. neither — `DEFAULT_CHESS_AI_DIFFICULTY` (`medium`), the documented
 *      default for a client that asks for no strength at all.
 *
 * `color` is then validated strictly (`white | black | random`); a body that
 * names an unusable colour is refused rather than seated on a coin toss. A
 * missing, null or empty `color` is the one request that legitimately has no
 * answer yet, and it resolves to `DEFAULT_CHESS_COLOR_CHOICE`.
 *
 * A missing or malformed BODY is treated as an empty one (defaults), not a 400:
 * it is the same situation as an older client omitting the fields, and nothing
 * in the body is trusted anyway — the player comes from the session.
 */
export function parseChessAiGameRequest(body: unknown): ChessAiGameRequest | ChessAiGameRequestError {
  const record = asRecord(body);

  const rawDifficulty = record.difficulty;
  const rawLegacyLevel = record.difficultyLevel;

  let difficulty: ChessAiDifficulty;

  if (rawDifficulty !== undefined && rawDifficulty !== null) {
    const requested = normalizeTierValue(rawDifficulty);
    if (!isChessAiDifficulty(requested)) {
      return { ok: false, status: 400, error: VALID_DIFFICULTY_MESSAGE };
    }
    difficulty = requested;
  } else if (rawLegacyLevel !== undefined && rawLegacyLevel !== null) {
    difficulty = coerceChessAiDifficulty(rawLegacyLevel);
  } else {
    difficulty = DEFAULT_CHESS_AI_DIFFICULTY;
  }

  const rawColor = record.color;
  let color: ChessColorChoice;

  if (rawColor === undefined || rawColor === null) {
    color = DEFAULT_CHESS_COLOR_CHOICE;
  } else {
    const requestedColor =
      typeof rawColor === "string" ? rawColor.trim().toLowerCase() : rawColor;
    if (!isChessColorChoice(requestedColor)) {
      return { ok: false, status: 400, error: VALID_COLOR_MESSAGE };
    }
    color = requestedColor;
  }

  return { ok: true, difficulty, color };
}

/** The initial row values for a VS-AI game — split out so a test can assert it. */
export function chessAiGameInsertValues(
  humanId: string,
  humanColor: ChessSeatColor,
  difficulty: ChessAiDifficulty,
): ChessAiGameInsert {
  return {
    ...chessSeatsForHumanColor(humanId, humanColor),
    betAmount: "0",
    timerMode: "blitz",
    initialTimeSeconds: CHESS_AI_GAME_INITIAL_TIME_SECONDS,
    isAiGame: true,
    status: "in_progress",
    aiDifficulty: difficulty,
  };
}

/**
 * The only impure step, injected: write the row and return its id.
 *
 * Returning null (no row) is a failure the caller must not paper over — a game
 * id that does not exist would surface later as a 404 on a board that thinks it
 * was created.
 */
export type CreateChessAiGameDeps = {
  insertGame: (values: ChessAiGameInsert) => Promise<{ id: string } | null | undefined>;
  /** Injectable coin for `random`, so tests never depend on chance. */
  random?: () => number;
};

/**
 * Create a VS-AI game row.
 *
 * `playerId` is the authenticated (or guest) player resolved by the route's own
 * gate — never a body field. This function decides the seats and persists them;
 * it does not start, move, or finish anything.
 */
export async function createChessAiGame(
  request: { playerId: string; difficulty: ChessAiDifficulty; color: ChessColorChoice },
  deps: CreateChessAiGameDeps,
): Promise<CreateChessAiGameResult> {
  const humanColor = resolveChessHumanColor(request.color, deps.random);
  const values = chessAiGameInsertValues(
    request.playerId,
    humanColor,
    request.difficulty,
  );

  const inserted = await deps.insertGame(values);
  if (!inserted?.id) {
    return { ok: false, status: 500, error: "Could not create the game" };
  }

  return {
    ok: true,
    gameId: inserted.id,
    humanColor,
    aiDifficulty: request.difficulty,
    difficultyLevel: CHESS_AI_DIFFICULTY_LEVELS[request.difficulty],
  };
}
