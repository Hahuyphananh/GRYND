/**
 * Bounded retries for a BOT'S TURN, shared by every vs-AI board that asks the
 * server to make the bot move.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bot's move is requested by a React effect that reacts to the match state
 * (`currentTurn === bot`, `turnNumber`, disc/edge counts, …). When the request
 * fails or is refused, adopting the server's snapshot re-renders the board — and
 * if that render leaves the bot still to move, the effect asks again. With no
 * bound, ONE failure becomes an unbounded request loop: the board spins on
 * "AI is thinking…", the endpoint is hammered, and the game never advances.
 *
 * The chess board (src/app/casino/chess/ai) hit exactly that; the same shape
 * exists on every other server-backed vs-AI board. So the policy lives here,
 * once:
 *
 *   * a turn gets at most `AI_TURN_MAX_ATTEMPTS` requests, spaced
 *     `AI_TURN_RETRY_BASE_MS × attempt` apart, and then it is GIVEN UP ON —
 *     no further automatic request for that turn;
 *   * a request that never answers is abandoned at `AI_TURN_TIMEOUT_MS`, because
 *     a hung request otherwise freezes the board with no error at all;
 *   * a new turn (a different key), a successful reply, or the player's own
 *     retry clears everything.
 *
 * WHAT IT IS NOT: it never decides the move, never adopts a snapshot, and never
 * changes a game rule. It only bounds how many times a page may ASK.
 */

/** How many times one bot turn may be requested. */
export const AI_TURN_MAX_ATTEMPTS = 3;

/** Spacing between attempts: attempt 1 waits 1×, attempt 2 waits 2×, … */
export const AI_TURN_RETRY_BASE_MS = 700;

/** A bot turn still unanswered after this long is abandoned (never honoured). */
export const AI_TURN_TIMEOUT_MS = 20_000;

/** Raised when a bot-turn request is still unanswered at its deadline. */
export class AiTurnTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiTurnTimeoutError";
  }
}

/**
 * `fetch` with a deadline.
 *
 * The race is explicit rather than relying on the transport honouring the abort
 * signal: a request that never settles must not leave the page waiting forever,
 * whatever the implementation does with `signal`.
 */
export async function fetchAiTurn(
  url: string,
  init: RequestInit = {},
  {
    timeoutMs = AI_TURN_TIMEOUT_MS,
    fetchImpl = fetch,
  }: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AiTurnTimeoutError(
              `${url} was not answered within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type AiTurnGuard = {
  /**
   * Begin the turn identified by `key` (any stable description of the position
   * the bot is to move in — a turn number, a move count, a FEN).
   *
   * Returns false when that turn has already used up its attempts, so the caller
   * must NOT ask again; the page then waits for the server's own resolution or
   * for the position to change.
   */
  begin: (key: string) => boolean;
  /**
   * Record a failed attempt. Returns how long to wait before the next one, or
   * `null` when the turn has given up — in which case nothing more is sent.
   */
  fail: () => number | null;
  /** The bot answered: forget the turn (the next key starts clean). */
  succeed: () => void;
  /** Forget everything — a new position, or the player asked again. */
  reset: () => void;
  /** The turn currently tracked, for tests and diagnostics. */
  currentKey: () => string | null;
  /** The attempts made for the current turn. */
  attempts: () => number;
  /** True when the current turn has used up its attempts. */
  gaveUp: () => boolean;
};

/**
 * The retry ledger for one board.
 *
 * Create it once per page (in a ref) and drive it from the AI effect:
 *
 *   if (!guard.begin(key)) return;            // this turn is over
 *   … request …
 *   const delay = ok ? (guard.succeed(), null) : guard.fail();
 *   if (delay !== null) schedule(() => ask(key), delay);
 */
export function createAiTurnGuard(
  {
    maxAttempts = AI_TURN_MAX_ATTEMPTS,
    baseDelayMs = AI_TURN_RETRY_BASE_MS,
  }: { maxAttempts?: number; baseDelayMs?: number } = {},
): AiTurnGuard {
  let key: string | null = null;
  let attempts = 0;
  let exhaustedFor: string | null = null;

  return {
    begin(nextKey: string) {
      if (exhaustedFor !== null && exhaustedFor === nextKey) return false;
      if (key !== nextKey) {
        key = nextKey;
        attempts = 0;
        if (exhaustedFor !== null && exhaustedFor !== nextKey) exhaustedFor = null;
      }
      return true;
    },
    fail() {
      attempts += 1;
      if (attempts >= maxAttempts) {
        exhaustedFor = key;
        return null;
      }
      return baseDelayMs * attempts;
    },
    succeed() {
      key = null;
      attempts = 0;
      exhaustedFor = null;
    },
    reset() {
      key = null;
      attempts = 0;
      exhaustedFor = null;
    },
    currentKey: () => key,
    attempts: () => attempts,
    gaveUp: () => exhaustedFor !== null && exhaustedFor === key,
  };
}
