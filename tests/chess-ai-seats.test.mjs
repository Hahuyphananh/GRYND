/**
 * Chess VS-AI — Stage 2: game creation, difficulty, and seat/colour assignment.
 *
 * WHAT THIS PINS
 * --------------
 * The row a Chess VS-AI game is created with, and the one answer both the server
 * and the board must agree on: which colour the human plays.
 *
 * Before this stage the route stored `player_white_id = <human>` and
 * `player_black_id = NULL` and the browser decided the board (the lobby put
 * `color=<white|black|random>` in the URL and the AI page rolled its own colour
 * for `random`). A player who chose Black was recorded as White, nothing on the
 * row said which seat the bot held, and `NULL` — which everywhere else in the
 * schema means "this seat is unclaimed" — was overloaded to also mean "the bot".
 *
 * Now the server resolves the colour (including `random`), writes the human into
 * the seat they chose and `chess_ai_bot` into the other one, and reports the
 * resolved colour back as `humanColor`.
 *
 * HOW IT IS TESTED WITHOUT A DATABASE
 * -----------------------------------
 * The route's one impure step — the INSERT — is injected, so the whole creation
 * flow runs here against a fake that records exactly what would have been
 * written. Nothing in this file touches a live database, and no AI move is
 * generated, stored or authorised (that is a later stage).
 *
 * Run: npm run test:chess-ai-seats
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CHESS_AI_DISPLAY_NAME,
  CHESS_AI_PLAYER_ID,
  chessSeatDisplayName,
  chessSeatOfPlayer,
  chessSeatsForHumanColor,
  isChessAiPlayerId,
  isChessColorChoice,
  oppositeChessSeatColor,
  resolveChessHumanColor,
  resolveInitialPlayerColor,
} from "../src/lib/chessAiSeat.ts";
import {
  DEFAULT_CHESS_COLOR_CHOICE,
  chessAiGameInsertValues,
  createChessAiGame,
  parseChessAiGameRequest,
} from "../src/lib/chessAiGameCreation.ts";
import {
  CHESS_AI_DIFFICULTY_LEVELS,
  DEFAULT_CHESS_AI_DIFFICULTY,
  coerceChessAiDifficulty,
  isChessAiDifficulty,
} from "../src/lib/chessDifficulty.ts";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const CREATE_AI = read("src/app/api/chess/create-ai-game/route.js");
const CREATE_PVP = read("src/app/api/chess/create-game/route.js");
const GAME_STATE = read("src/app/api/chess/game-state/route.js");
const AVAILABLE = read("src/app/api/chess/available-games/route.js");
const JOIN_GAME = read("src/app/api/chess/join-game/route.js");
const QUICK_QUEUE = read("src/lib/quickQueueChess.ts");
const LOBBY = read("src/app/casino/chess/PageClient.jsx");
const AI_PAGE = read("src/app/casino/chess/ai/ChessAIPageInner.tsx");
const SCHEMA = read("src/db/schema.ts");
const SEAT_IDENTITY = read("src/lib/seatIdentity.js");

const HUMAN = "user_2abcHumanSeat";
const UUID = "11111111-1111-4111-8111-111111111111";

/** A fake INSERT: records the row it was asked to write. */
function recorder(mode = "ok") {
  const rows = [];
  return {
    rows,
    insertGame: async (values) => {
      rows.push(values);
      if (mode === "fail") return null;
      if (mode === "throw") throw new Error("insert exploded");
      return { id: UUID };
    },
  };
}

/** A fixed coin: rng() > 0.5 is White, exactly as the client used to roll it. */
const alwaysWhite = () => 0.9;
const alwaysBlack = () => 0.1;

// ════════════════════════════════════════════════════════════════════
// 1. Seat assignment — the human in the seat they chose
// ════════════════════════════════════════════════════════════════════

test("a human choosing White is stored in the White seat and the bot in Black", () => {
  const seats = chessSeatsForHumanColor(HUMAN, "white");
  assert.equal(seats.playerWhiteId, HUMAN);
  assert.equal(seats.playerBlackId, CHESS_AI_PLAYER_ID);
});

test("a human choosing Black is stored in the Black seat and the bot in White", () => {
  const seats = chessSeatsForHumanColor(HUMAN, "black");
  assert.equal(seats.playerBlackId, HUMAN);
  assert.equal(seats.playerWhiteId, CHESS_AI_PLAYER_ID);
});

test("the human is never written into the seat they did not choose", () => {
  for (const color of ["white", "black"]) {
    const seats = chessSeatsForHumanColor(HUMAN, color);
    const humanSeat = seats.playerWhiteId === HUMAN ? "white" : "black";
    const botSeat = seats.playerWhiteId === CHESS_AI_PLAYER_ID ? "white" : "black";
    assert.equal(humanSeat, color, `human seat must be ${color}`);
    assert.equal(botSeat, oppositeChessSeatColor(color), "the bot takes the other seat");
  }
});

test("both seats are filled, so no NULL seat is left to look like an open table", () => {
  for (const color of ["white", "black"]) {
    const row = chessAiGameInsertValues(HUMAN, color, "easy");
    assert.ok(row.playerWhiteId, "the White seat is filled");
    assert.ok(row.playerBlackId, "the Black seat is filled");
    // The only nullable seat on a chess row is an UNCLAIMED one — that meaning
    // is what `available-games`, `join-game` and the quick queue match on, so an
    // AI row must never produce it.
    assert.notEqual(row.playerBlackId, null);
    assert.notEqual(row.playerWhiteId, null);
  }
});

test("every column the creation row writes exists on chess_games", () => {
  // Parity between the module and the schema: a row key that is not a column
  // would 500 at INSERT time — the one failure mode this suite cannot otherwise
  // reach without a database.
  const start = SCHEMA.indexOf("export const chessGames = pgTable(");
  assert.ok(start > -1, "chess_games must be declared in schema.ts");
  const rest = SCHEMA.slice(start);
  const block = rest.slice(0, rest.indexOf("\n}));"));

  const row = chessAiGameInsertValues(HUMAN, "black", "hard");
  for (const key of Object.keys(row)) {
    assert.match(
      block,
      new RegExp(`\\b${key}:`),
      `${key} must be a column of chess_games`,
    );
  }
  // …and there is exactly one tier column, spelled as the migration writes it.
  assert.match(block, /aiDifficulty: varchar\("ai_difficulty", \{ length: 16 \}\)/);
});

test("an AI row still declares itself an AI game and stays unrated", () => {
  const row = chessAiGameInsertValues(HUMAN, "black", "hard");
  assert.equal(row.isAiGame, true);
  assert.equal(row.status, "in_progress");
  assert.equal(row.betAmount, "0");
  assert.equal(row.timerMode, "blitz");
  // No `startedAt`: the AI board owns its own clock today, and writing one would
  // change when the game-state timeout settlement can first see a depleted clock
  // — a finalization change this stage is not allowed to make.
  assert.ok(!("startedAt" in row), "creation must not start a server clock");
});

// ════════════════════════════════════════════════════════════════════
// 2. The bot's identity is a sentinel that cannot be a person
// ════════════════════════════════════════════════════════════════════

test("the sentinel follows the per-game bot convention", () => {
  assert.equal(CHESS_AI_PLAYER_ID, "chess_ai_bot");
  assert.match(CHESS_AI_PLAYER_ID, /^[a-z][a-z0-9_]*_ai_bot$/);
  // The shared resolver skips anything that is not a real user, so the bot's
  // slot resolves to null and the client draws its own AI label.
  assert.match(SEAT_IDENTITY, /const CLERK_ID_PREFIX = "user_";/);
  assert.match(SEAT_IDENTITY, /startsWith\(CLERK_ID_PREFIX\)/);
});

test("only the sentinel resolves as the bot — never a real seat", () => {
  assert.equal(isChessAiPlayerId(CHESS_AI_PLAYER_ID), true);
  for (const real of [HUMAN, "guest_9f0b0b0b-0000-4000-8000-000000000000", null, undefined, 42]) {
    assert.equal(isChessAiPlayerId(real), false, `${String(real)} is not the bot`);
  }
  // The seat readers build alias sets that also carry the numeric users.id.
  // `Number("chess_ai_bot")` is NaN, so the sentinel can never collide with a
  // real player's alias — the same guarantee the schema's `user_`/`guest_`
  // prefixes give.
  assert.ok(Number.isNaN(Number(CHESS_AI_PLAYER_ID)));
});

// ════════════════════════════════════════════════════════════════════
// 3. Difficulty — validated, defaulted, persisted
// ════════════════════════════════════════════════════════════════════

test("every accepted tier is persisted verbatim", async () => {
  for (const tier of ["easy", "medium", "hard"]) {
    const fake = recorder();
    const parsed = parseChessAiGameRequest({ difficulty: tier, color: "white" });
    assert.equal(parsed.ok, true);

    const result = await createChessAiGame(
      { playerId: HUMAN, difficulty: parsed.difficulty, color: parsed.color },
      fake,
    );

    assert.equal(result.ok, true);
    assert.equal(result.aiDifficulty, tier);
    assert.equal(fake.rows.length, 1);
    assert.equal(fake.rows[0].aiDifficulty, tier, "the tier reaches the row");
  }
});

test("a request with no difficulty defaults to Medium", async () => {
  const fake = recorder();
  const parsed = parseChessAiGameRequest({});
  assert.equal(parsed.ok, true);
  assert.equal(parsed.difficulty, "medium");
  assert.equal(DEFAULT_CHESS_AI_DIFFICULTY, "medium");

  const result = await createChessAiGame(
    { playerId: HUMAN, difficulty: parsed.difficulty, color: parsed.color },
    fake,
  );
  assert.equal(result.ok, true);
  assert.equal(fake.rows[0].aiDifficulty, "medium");
});

test("an explicitly invalid difficulty is refused, and nothing is persisted", async () => {
  const fake = recorder();
  for (const bad of ["impossible", "insane", "normal", "expert", "", 7, true, {}]) {
    const parsed = parseChessAiGameRequest({ difficulty: bad });
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(parsed.status, 400);
    assert.match(parsed.error, /easy, medium or hard/);
  }
  assert.equal(fake.rows.length, 0, "a refused request writes no row");
});

test("the FORM of a tier is normalised, its VOCABULARY is not", () => {
  // Case/whitespace is the same request.
  assert.equal(parseChessAiGameRequest({ difficulty: "  EASY " }).difficulty, "easy");
  // `normal` is the shared casino scale's middle tier — a different vocabulary.
  // The caller maps it (coerceChessAiDifficulty) before asking; the route must
  // not guess and persist a tier nobody chose.
  const shared = parseChessAiGameRequest({ difficulty: "normal" });
  assert.equal(shared.ok, false);
  assert.equal(coerceChessAiDifficulty("normal"), "medium");
});

test("a cached client's legacy 1–5 level keeps the tier its user picked", async () => {
  // The pre-tier lobby sent only `difficultyLevel` (AI_LEVEL_BY_TIER:
  // easy 2, normal 3, hard 5). Those clients must keep working, and keep the
  // user's choice rather than being moved to the default.
  const cases = [
    [1, "easy"],
    [2, "easy"],
    [3, "medium"],
    [4, "hard"],
    [5, "hard"],
  ];

  for (const [level, tier] of cases) {
    const parsed = parseChessAiGameRequest({ ai_game: true, difficultyLevel: level });
    assert.equal(parsed.ok, true, `legacy level ${level} must not be rejected`);
    assert.equal(parsed.difficulty, tier);

    const fake = recorder();
    await createChessAiGame(
      { playerId: HUMAN, difficulty: parsed.difficulty, color: parsed.color },
      fake,
    );
    assert.equal(fake.rows[0].aiDifficulty, tier);
  }

  // A malformed legacy value is coerced, not refused: it is a value from a
  // client that predates the vocabulary, and refusing it would break a player
  // mid-session over a field nothing trusts.
  assert.equal(parseChessAiGameRequest({ difficultyLevel: "nonsense" }).difficulty, "medium");
});

test("the legacy level scale and the coercer are exact inverses", () => {
  for (const tier of ["easy", "medium", "hard"]) {
    assert.equal(isChessAiDifficulty(tier), true);
    assert.equal(
      coerceChessAiDifficulty(CHESS_AI_DIFFICULTY_LEVELS[tier]),
      tier,
      `${tier} must round-trip through the legacy level ${CHESS_AI_DIFFICULTY_LEVELS[tier]}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════
// 4. Colour — resolved server-side, reported back, never named by the body
// ════════════════════════════════════════════════════════════════════

test("white and black are honoured exactly as requested", async () => {
  for (const color of ["white", "black"]) {
    const fake = recorder();
    const result = await createChessAiGame(
      { playerId: HUMAN, difficulty: "medium", color },
      fake,
    );
    assert.equal(result.ok, true);
    assert.equal(result.humanColor, color);
    assert.equal(fake.rows[0][`player${color === "white" ? "White" : "Black"}Id`], HUMAN);
  }
});

test("random is resolved by the SERVER, and the response matches the persisted seats", async () => {
  for (const [rng, expected] of [
    [alwaysWhite, "white"],
    [alwaysBlack, "black"],
  ]) {
    const fake = recorder();
    const result = await createChessAiGame(
      { playerId: HUMAN, difficulty: "medium", color: "random" },
      { ...fake, random: rng },
    );

    assert.equal(result.ok, true);
    assert.equal(result.humanColor, expected);
    // The load-bearing cross-check: the colour REPORTED to the client is the
    // colour the human was actually written into. The board is drawn from
    // `humanColor`, so if these two ever disagreed the client would be playing
    // from the wrong side of its own row.
    const seat = fake.rows[0].playerWhiteId === HUMAN ? "white" : "black";
    assert.equal(result.humanColor, seat);
  }
});

test("`random` is the documented answer when a request names no colour", async () => {
  assert.equal(DEFAULT_CHESS_COLOR_CHOICE, "random");
  const parsed = parseChessAiGameRequest({ difficulty: "easy" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.color, "random");
  // …and it is still resolved to a concrete seat before anything is written.
  const fake = recorder();
  const result = await createChessAiGame(
    { playerId: HUMAN, difficulty: "easy", color: parsed.color },
    { ...fake, random: alwaysBlack },
  );
  assert.equal(result.humanColor, "black");
  assert.equal(fake.rows[0].playerBlackId, HUMAN);
});

test("an unusable colour is refused, and nothing is persisted", async () => {
  const fake = recorder();
  for (const bad of ["purple", "1", 1, [], {}, true]) {
    const parsed = parseChessAiGameRequest({ difficulty: "easy", color: bad });
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.equal(parsed.status, 400);
    assert.match(parsed.error, /white, black or random/);
  }
  assert.equal(fake.rows.length, 0);
  assert.equal(isChessColorChoice("random"), true);
  assert.equal(isChessColorChoice("white"), true);
  assert.equal(isChessColorChoice(null), false);
  // …while the FORM of a colour is normalised, exactly as a tier is: a padded
  // or differently-cased spelling is the same request, not a different colour.
  assert.equal(parseChessAiGameRequest({ color: " Black " }).color, "black");
  assert.equal(parseChessAiGameRequest({ color: "RANDOM" }).color, "random");
});

test("the body cannot name a seat, a player or a tier it is not entitled to", async () => {
  const fake = recorder();
  const parsed = parseChessAiGameRequest({
    difficulty: "hard",
    color: "black",
    // Every field a client might try to use to place itself. None of them is
    // read: the player comes from the session, and the seats are derived.
    playerWhiteId: "user_attacker",
    playerBlackId: "user_attacker",
    userId: "user_attacker",
    playedBy: "user_attacker",
    isAiGame: false,
    status: "finished",
    winnerId: "user_attacker",
    aiDifficulty: "easy",
  });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.difficulty, "hard");

  const result = await createChessAiGame(
    { playerId: HUMAN, difficulty: parsed.difficulty, color: parsed.color },
    fake,
  );
  assert.equal(result.ok, true);

  const row = fake.rows[0];
  assert.equal(row.playerBlackId, HUMAN, "the human takes the requested seat");
  assert.equal(row.playerWhiteId, CHESS_AI_PLAYER_ID);
  assert.equal(row.aiDifficulty, "hard", "the validated request wins over the body's tier");
  assert.equal(row.isAiGame, true);
  assert.equal(row.status, "in_progress");
  assert.equal(row.winnerId, undefined, "creation decides no result");
  assert.ok(!JSON.stringify(row).includes("user_attacker"));
});

test("a malformed body is treated as an empty one, not a failure", () => {
  for (const body of [undefined, null, "nonsense", 42, []]) {
    const parsed = parseChessAiGameRequest(body);
    assert.equal(parsed.ok, true, `${JSON.stringify(body)} must not be a hard failure`);
    assert.equal(parsed.difficulty, "medium");
    assert.equal(parsed.color, "random");
  }
});

// ════════════════════════════════════════════════════════════════════
// 5. The creation response contract
// ════════════════════════════════════════════════════════════════════

test("creation reports the resolved colour, the tier, and its legacy level", async () => {
  const fake = recorder();
  const result = await createChessAiGame(
    { playerId: HUMAN, difficulty: "easy", color: "black" },
    fake,
  );

  assert.deepEqual(
    { ...result },
    {
      ok: true,
      gameId: UUID,
      humanColor: "black",
      aiDifficulty: "easy",
      difficultyLevel: 2,
    },
  );
});

test("a failed insert is reported as a failure, never as a created game", async () => {
  const result = await createChessAiGame(
    { playerId: HUMAN, difficulty: "medium", color: "white" },
    recorder("fail"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.gameId, undefined);

  // An insert that throws propagates to the route's own 500 handler.
  await assert.rejects(() =>
    createChessAiGame(
      { playerId: HUMAN, difficulty: "medium", color: "white" },
      recorder("throw"),
    ),
  );
});

test("the route is a thin shell: it validates, delegates, and reports humanColor", () => {
  assert.match(CREATE_AI, /import \{\s*createChessAiGame,\s*parseChessAiGameRequest,\s*\} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/chessAiGameCreation";/);
  assert.match(CREATE_AI, /const parsed = parseChessAiGameRequest\(body\);/);
  assert.match(CREATE_AI, /if \(!parsed\.ok\) \{\s*return NextResponse\.json\(\{ error: parsed\.error \}, \{ status: parsed\.status \}\);/);
  assert.match(CREATE_AI, /playerId: userId,/);
  assert.match(CREATE_AI, /humanColor: result\.humanColor,/);
  // The response is built from the result, never from the request body.
  assert.ok(!/difficulty: body\./.test(CREATE_AI));
});

// ════════════════════════════════════════════════════════════════════
// 6. PvP creation is untouched, and an unclaimed seat keeps its meaning
// ════════════════════════════════════════════════════════════════════

test("the PvP route writes no AI identity and no tier", () => {
  assert.match(
    CREATE_PVP,
    /\.insert\(chessGames\)\s*\.values\(\{\s*playerWhiteId: clerkId,/,
  );
  assert.match(CREATE_PVP, /isAiGame: false,/);
  assert.ok(
    !CREATE_PVP.includes("aiDifficulty"),
    "PvP creation must not stamp a difficulty onto a row with no bot",
  );
  assert.ok(
    !CREATE_PVP.includes("CHESS_AI_PLAYER_ID"),
    "PvP creation must not seat a bot",
  );
});

test("ai_difficulty is nullable with no default, so a PvP row is NULL", () => {
  const column = SCHEMA.match(
    /aiDifficulty: varchar\("ai_difficulty", \{ length: 16 \}\)([^,\n]*),/,
  );
  assert.ok(column, "the ai_difficulty column must exist");
  assert.ok(
    !column[1].includes(".default("),
    "a default would stamp 'medium' onto rows that have no bot",
  );
  assert.ok(
    !column[1].includes(".notNull()"),
    "the column must stay nullable — NULL is what 'no bot' means",
  );
});

test("an unclaimed seat still means 'no opponent' for the PvP flows", () => {
  // The rule this whole change had to protect: these matchers key on a NULL
  // black seat AND on the game not being an AI game. Both hold for an AI row
  // now (in_progress, is_ai_game = true), so a VS-AI game can never be listed,
  // joined or matched as an open table.
  for (const [name, src] of [
    ["available-games", AVAILABLE],
    ["join-game", JOIN_GAME],
    ["quickQueueChess", QUICK_QUEUE],
  ]) {
    assert.match(src, /isNull\(chessGames\.playerBlackId\)/, `${name} matches a NULL black seat`);
    assert.match(src, /isAiGame, false/, `${name} excludes AI games`);
  }
});

// ════════════════════════════════════════════════════════════════════
// 7. Existing game-state behavior stays compatible in BOTH colours
// ════════════════════════════════════════════════════════════════════

test("the requesting human is found in whichever seat they hold", () => {
  const aliases = (ids) => new Set(ids);
  const human = aliases([HUMAN, "42"]);

  assert.equal(chessSeatOfPlayer(chessSeatsForHumanColor(HUMAN, "white"), (id) => human.has(id)), "white");
  assert.equal(chessSeatOfPlayer(chessSeatsForHumanColor(HUMAN, "black"), (id) => human.has(id)), "black");

  // The bot holds the other seat, and a viewer who is neither seat holds none.
  const bot = chessSeatsForHumanColor(HUMAN, "black");
  assert.equal(chessSeatOfPlayer(bot, (id) => id === CHESS_AI_PLAYER_ID), "white");
  assert.equal(chessSeatOfPlayer(bot, (id) => id === "user_someone_else"), null);
});

test("game-state authorises and roles the viewer from the seat columns", () => {
  // `canAccess`/`viewerRole` are derived from playerWhiteId/playerBlackId, which
  // is exactly what makes the new seats work: the human matches the seat they
  // were written into, and the sentinel matches nobody's alias set.
  assert.match(GAME_STATE, /const canAccess =\s*userAliases\.has\(String\(game\.playerWhiteId\)\) \|\|/);
  assert.match(GAME_STATE, /const viewerRole = canAccess/);
  assert.match(GAME_STATE, /userAliases\.has\(String\(game\.playerWhiteId\)\)\s*\?\s*"white"\s*:\s*"black"/);
});

test("the bot's seat renders as the AI in either colour", () => {
  const ai = { isAiGame: true };
  assert.equal(chessSeatDisplayName(CHESS_AI_PLAYER_ID, null, { ...ai, emptyLabel: "White" }), CHESS_AI_DISPLAY_NAME);
  assert.equal(chessSeatDisplayName(CHESS_AI_PLAYER_ID, null, { ...ai, emptyLabel: "Waiting..." }), CHESS_AI_DISPLAY_NAME);
  // The human's seat keeps its real username, and a name that failed to resolve
  // still resolves to the seat's literal — not to the bot's label.
  assert.equal(chessSeatDisplayName(HUMAN, "Ada", { ...ai, emptyLabel: "White" }), "Ada");
  assert.equal(chessSeatDisplayName(HUMAN, null, { ...ai, emptyLabel: "Black" }), "Black");
});

test("an unjoined PvP seat still reads Waiting..., and a legacy AI row still reads Chess AI", () => {
  // PvP: no bot anywhere.
  assert.equal(chessSeatDisplayName(null, null, { isAiGame: false, emptyLabel: "Waiting..." }), "Waiting...");
  assert.equal(chessSeatDisplayName(HUMAN, null, { isAiGame: false, emptyLabel: "White" }), "White");
  // A row written BEFORE the seat model changed stored the bot as an empty black
  // seat; those rows must keep rendering the bot rather than an open table.
  assert.equal(chessSeatDisplayName(null, null, { isAiGame: true, emptyLabel: "Waiting..." }), CHESS_AI_DISPLAY_NAME);
});

test("game-state uses the shared seat label for BOTH seats", () => {
  assert.match(
    GAME_STATE,
    /import \{[^}]*\bchessSeatDisplayName\b[^}]*\} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/chessAiSeat";/,
  );
  assert.match(GAME_STATE, /whitePlayerName: chessSeatDisplayName\(game\.playerWhiteId, whiteName, \{/);
  assert.match(GAME_STATE, /blackPlayerName: chessSeatDisplayName\(game\.playerBlackId, blackName, \{/);
  // The old hardcoded black-only bot label is gone — it would have mislabelled
  // the bot white whenever the human chose Black.
  assert.ok(
    !/blackName \|\| \(game\.isAiGame \? "Chess AI" : "Waiting\.\.\."\)/.test(GAME_STATE),
  );
});

// ════════════════════════════════════════════════════════════════════
// 8. The client draws its board from the server's answer
// ════════════════════════════════════════════════════════════════════

test("the AI page takes its colour from the server-confirmed parameter", () => {
  assert.match(AI_PAGE, /import \{ resolveInitialPlayerColor \} from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/chessAiSeat";/);
  // Resolved ONCE per URL: the board's initial state, the initialise effect and
  // a restart all read that single answer, so a re-roll can never flip sides
  // mid-mount or move a seat the row already fixed.
  assert.match(
    AI_PAGE,
    /const serverColor = useMemo\(\s*\(\) => resolveInitialPlayerColor\(colorParam\),\s*\[colorParam\],\s*\);/,
  );
  assert.match(
    AI_PAGE,
    /const \[playerColor, setPlayerColor\] = useState<"white" \| "black">\(serverColor\);/,
  );
  assert.equal(
    AI_PAGE.split("const chosenColor = serverColor;").length - 1,
    2,
    "both the initialise and the restart paths must use the resolved colour",
  );
  assert.ok(
    !/useState<"white" \| "black">\("white"\)/.test(AI_PAGE),
    "the board must not start from an assumed White seat",
  );
  // The page must not roll a colour of its own any more.
  assert.ok(!AI_PAGE.includes("Math.random"), "no client-side colour roll is left");
  // The client-side move generator is still here — moving the bot's move onto
  // the server is a later stage, and this stage must not have touched it.
  assert.match(AI_PAGE, /function pickBestMove\(game: Chess, aiColor: "w" \| "b", aiLevel: number\)/);
});

test("the colour resolver honours a server answer and never assumes White", () => {
  const neverRoll = () => {
    throw new Error("a resolved colour must not be re-rolled");
  };
  assert.equal(resolveInitialPlayerColor("white", neverRoll), "white");
  assert.equal(resolveInitialPlayerColor("black", neverRoll), "black");
  // A colour the server never resolved falls back to the coin toss…
  assert.equal(resolveInitialPlayerColor("random", alwaysBlack), "black");
  assert.equal(resolveInitialPlayerColor(null, alwaysWhite), "white");
  assert.equal(resolveInitialPlayerColor(undefined, alwaysWhite), "white");
  assert.equal(resolveInitialPlayerColor("", alwaysBlack), "black");
  // …and the resolver itself defaults to the client's historical roll, which is
  // a coin toss rather than an assumption about the human's side.
  assert.ok(["white", "black"].includes(resolveInitialPlayerColor("random")));
});

test("the lobby sends the selected tier and colour, and follows the reply's seats", () => {
  // The tier the server validates, the legacy level, and the requested colour.
  assert.match(LOBBY, /difficulty: chessAiTier,/);
  assert.match(LOBBY, /difficultyLevel: aiLevel,/);
  assert.match(LOBBY, /color: aiColor,/);
  // The board's colour comes from the creation RESPONSE, not from the picker.
  assert.match(LOBBY, /const resolvedColor = data\.humanColor === "black" \? "black" : "white";/);
  assert.match(LOBBY, /color=\$\{resolvedColor\}/);
  assert.ok(
    !/color=\$\{aiColor\}/.test(LOBBY),
    "the redirect must not carry the picker's value — `random` is unresolved",
  );
  // The shared picker tier is translated into chess's vocabulary in ONE place.
  assert.match(LOBBY, /const chessAiTier = coerceChessAiDifficulty\(aiTier\);/);
});

test("no AI move generation, move authorization or finalization was touched", () => {
  // Nothing in this stage generates a move or writes one.
  for (const [name, src] of [
    ["create-ai-game", CREATE_AI],
    ["chessAiGameCreation", read("src/lib/chessAiGameCreation.ts")],
    ["chessAiSeat", read("src/lib/chessAiSeat.ts")],
  ]) {
    assert.ok(!/chessMoves/.test(src), `${name} must not write moves`);
    assert.ok(!/getChessAiMove|chessGameplayEngine/.test(src), `${name} must not run the engine`);
  }
});
