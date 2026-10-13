/**
 * Chess VS-AI — the AI's seat identity, and the colour/seat resolution both the
 * creation route and the AI board read.
 *
 * WHY A SEAT MODEL HAD TO CHANGE
 * -----------------------------
 * Chess VS-AI used to store `player_white_id = <human>` and
 * `player_black_id = NULL`, and the board you were given was decided by the
 * browser: the lobby put `color=<white|black|random>` in the URL and the AI page
 * rolled its own colour when it read `random`. Two consequences, both real:
 *
 *   1. The row could not describe its own game. A player who chose Black was
 *      still recorded as White, and nothing on the row said which seat the bot
 *      held — so any server-side reader (analysis, evaluation, a later
 *      server-authoritative AI move) would have had to re-derive the seat from
 *      the same browser roll it was supposed to be authoritative over.
 *   2. `playerBlackId === null` means "this seat is UNCLAIMED" everywhere else in
 *      the schema — `available-games`, `join-game`, `quickQueueChess` all match
 *      on `isNull(playerBlackId)`. Overloading NULL to also mean "the bot" is
 *      what made an AI game indistinguishable from an open table.
 *
 * So the AI now occupies a real seat: the human is written into the seat that
 * matches the colour they chose (resolved SERVER-side, including for `random`),
 * and the bot into the opposite seat.
 *
 * THE SENTINEL
 * ------------
 * `chess_ai_bot` follows the existing per-game bot convention
 * (`tic_tac_toe_ai_bot`, `mini_golf_ai_bot`, `blackjack_ai_bot`). It is safe in a
 * seat column because real seats are always prefixed — Clerk ids `user_*` and
 * guest ids `guest_*` (src/lib/guestIdentity.ts) — and `src/lib/seatIdentity.js`
 * resolves an identity for nothing else, leaving the slot null so the client
 * draws its AI label. `ai_difficulty` stays the authority on HOW STRONG the bot
 * is; the sentinel only says WHICH seat it holds.
 *
 * THIS MODULE IS PURE — no engine, no I/O, no database, no React. It is imported
 * by the creation route (server) and by the AI page (client) so the two cannot
 * disagree about who is on which side of the board.
 */

/**
 * A board colour. `white` moves first; the seat columns are named after it.
 */
export type ChessSeatColor = "white" | "black";

/**
 * What a player may ask for at creation: a specific colour, or `random` for
 * "you decide" — in which case the SERVER decides and reports what it chose.
 */
export type ChessColorChoice = ChessSeatColor | "random";

/** Board colours, in board order. Render a picker from this. */
export const CHESS_SEAT_COLORS: readonly ChessSeatColor[] = Object.freeze([
  "white",
  "black",
] as const);

/** The three accepted colour requests. The closed vocabulary is deliberate. */
export const CHESS_COLOR_CHOICES: readonly ChessColorChoice[] = Object.freeze([
  "white",
  "black",
  "random",
] as const);

/**
 * The AI opponent's seat identity.
 *
 * Declared here rather than inside the route so the board, the route and any
 * later server-authoritative AI move all name the bot with one constant.
 */
export const CHESS_AI_PLAYER_ID = "chess_ai_bot";

/**
 * The label a bot seat renders as. Mirrors the wording the chess game-state
 * route and board already use, so neither learns a second name.
 */
export const CHESS_AI_DISPLAY_NAME = "Chess AI";

/** True for the chess bot's sentinel id. Never true for a real seat. */
export function isChessAiPlayerId(value: unknown): boolean {
  return typeof value === "string" && value === CHESS_AI_PLAYER_ID;
}

/** Strict test for a board colour. */
export function isChessSeatColor(value: unknown): value is ChessSeatColor {
  return value === "white" || value === "black";
}

/**
 * Strict test for an acceptable colour REQUEST.
 *
 * Like `isChessAiDifficulty`, this is the validating test: a request that names
 * a colour we do not understand is rejected rather than coerced, because
 * guessing here would seat the player on the side they did not ask for.
 */
export function isChessColorChoice(value: unknown): value is ChessColorChoice {
  return value === "white" || value === "black" || value === "random";
}

/**
 * Flip a colour. The bot always sits opposite the human, so every seat
 * assignment is one call to this.
 */
export function oppositeChessSeatColor(color: ChessSeatColor): ChessSeatColor {
  return color === "white" ? "black" : "white";
}

/**
 * A coin toss, with the RNG injectable so tests never depend on chance.
 *
 * `Math.random() > 0.5` is kept exactly as the client used to roll it, so a
 * `random` game is resolved by the same distribution it always had — the only
 * change is that the server now rolls once and everyone reads that result.
 */
export function randomChessSeatColor(rng: () => number = Math.random): ChessSeatColor {
  return rng() > 0.5 ? "white" : "black";
}

/**
 * Resolve a validated request into the colour the human actually plays.
 *
 * `random` is the only branch that needs a decision, and it is made here — on
 * whatever side of the wire calls this — so the value written to the row and the
 * value handed back to the client are one resolution, never two.
 */
export function resolveChessHumanColor(
  choice: ChessColorChoice,
  rng: () => number = Math.random,
): ChessSeatColor {
  return choice === "random" ? randomChessSeatColor(rng) : choice;
}

/** The two seat columns of a chess game row. */
export type ChessSeats = {
  playerWhiteId: string | null;
  playerBlackId: string | null;
};

/**
 * Seat assignment for a VS-AI game: the human in the seat matching their
 * resolved colour, the bot in the other one.
 *
 * Both seats are therefore always non-null on an AI row, which is what lets
 * every existing seat reader (`canAccess`, `viewerRole`, viewer-colour
 * resolution, `or(white = me, black = me)` history lookups) keep working
 * unchanged in BOTH colours — the human is simply found in the seat they hold.
 * The PvP "unclaimed seat" meaning of a NULL is left intact.
 */
export function chessSeatsForHumanColor(
  humanId: string,
  humanColor: ChessSeatColor,
): { playerWhiteId: string; playerBlackId: string } {
  return humanColor === "white"
    ? { playerWhiteId: humanId, playerBlackId: CHESS_AI_PLAYER_ID }
    : { playerWhiteId: CHESS_AI_PLAYER_ID, playerBlackId: humanId };
}

/**
 * Which seat a player id holds, or null if it holds neither. Alias-safe: the
 * caller passes whatever set of ids count as "this player".
 */
export function chessSeatOfPlayer(
  seats: ChessSeats,
  matches: (id: string) => boolean,
): ChessSeatColor | null {
  if (seats.playerWhiteId && matches(String(seats.playerWhiteId))) return "white";
  if (seats.playerBlackId && matches(String(seats.playerBlackId))) return "black";
  return null;
}

/**
 * The colour the board should be drawn from, given the `color` URL parameter.
 *
 * A concrete `white`/`black` is the SERVER's resolved seat and is returned
 * verbatim — that is the whole point of the creation route reporting
 * `humanColor`: the board follows the row instead of independent client state.
 *
 * Anything else (`random`, absent, or hand-edited) is a colour the server did not
 * resolve for this page, so it keeps the historical coin toss. Two honest cases
 * reach it: a bare practice board with no server game at all, and the URL of a
 * browser still running a bundle from before the server resolved colours — which
 * is the state this fallback cannot fix from here, because the row it disagrees
 * with cannot be read without a fetch. Neither ASSUMES the human is White.
 *
 * The roll is taken here rather than injected as a colour, so every caller gets
 * the same policy; `rng` is injectable only so a test can pin the branch without
 * depending on chance.
 */
export function resolveInitialPlayerColor(
  colorParam: string | null | undefined,
  rng: () => number = Math.random,
): ChessSeatColor {
  return isChessSeatColor(colorParam) ? colorParam : randomChessSeatColor(rng);
}

/**
 * The label to render for a seat when the username lookup produced nothing.
 *
 * Three distinct cases, kept distinct on purpose:
 *
 *   * the sentinel seat IS the bot, in either colour → "Chess AI";
 *   * an EMPTY seat on an AI row is the bot too (a row written before the seat
 *     model changed stored a NULL second seat) → "Chess AI";
 *   * anything else falls back to the caller's own wording — "White" for the
 *     first seat and "Waiting..." for the second, exactly as before.
 *
 * A resolved name always wins, so a human whose profile lookup failed still
 * renders their seat's literal rather than being labelled the bot.
 */
export function chessSeatDisplayName(
  playerId: string | null | undefined,
  resolvedName: string | null | undefined,
  { isAiGame, emptyLabel }: { isAiGame: boolean; emptyLabel: string },
): string {
  if (resolvedName) return resolvedName;
  if (isChessAiPlayerId(playerId)) return CHESS_AI_DISPLAY_NAME;
  if (isAiGame && !playerId) return CHESS_AI_DISPLAY_NAME;
  return emptyLabel;
}
