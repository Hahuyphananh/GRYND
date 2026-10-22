// tests/rewards-quests-ui.test.mjs
//
// The quest experience: the /rewards page wiring, the component's states, the
// client hook's request shapes, the two API routes, the claim's server-side
// guarantees, and the corner widget + popup the home page and games hub mount.
//
// These are the assertions a browser check cannot make: the ABSENCE of a
// client-supplied amount, the order of the claim checks, the fact that the
// claim button only exists for a server-confirmed `claimable` quest, and that
// every state (signed out, loading, empty, error) is rendered as itself.
//
// Run:  node --import tsx --test tests/rewards-quests-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { DAILY_QUESTS, WEEKLY_QUESTS } from "../src/lib/quests/definitions.ts";

const read = (rel) => readFileSync(rel, "utf8");
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PAGE = "src/app/rewards/PageClient.tsx";
const BOARD = "src/components/QuestBoard.tsx";
const HOOK = "src/hooks/useQuests.ts";
const STATUS_ROUTE = "src/app/api/quests/route.ts";
const CLAIM_ROUTE = "src/app/api/quests/claim/route.ts";
const CLAIM_LIB = "src/lib/quests/claim.ts";
const TRANSLATIONS = "src/lib/appTextTranslations.js";

// ════════════════════════════════════════════════════════════════════════
// 1. The page
// ════════════════════════════════════════════════════════════════════════

test("the quest board is on /rewards, beside the daily reward", () => {
  const page = read(PAGE);
  assert.match(page, /import QuestBoard from "\.\.\/\.\.\/components\/QuestBoard"/);
  assert.match(page, /<QuestBoard \/>/);
  // The existing daily reward card is untouched and still rendered.
  assert.match(page, /import DailyRewardCard from "\.\.\/\.\.\/components\/DailyRewardCard"/);
  assert.match(page, /<DailyRewardCard \/>/);
  // The balance still comes from the one shared coin source.
  assert.match(page, /import \{ useCoinBalance \} from "\.\.\/\.\.\/hooks\/useCoinBalance"/);
});

test("the gift-card teasers and the redemption tease are gone", () => {
  const page = read(PAGE);
  const code = stripComments(page);

  // No teaser cards, no "Coming Soon" badges, no example rewards.
  assert.doesNotMatch(code, /Coming Soon/);
  assert.doesNotMatch(code, /GIFT_CARD_TEASERS|gift-card-/);
  assert.doesNotMatch(code, /Amazon gift card|Steam gift card|prepaid card/i);
  // No rewards provider, no payments, no redemption system.
  assert.doesNotMatch(code, /giftbit|tremendous|stripe|checkout|payment/i);

  // The page itself still fetches nothing and owns no button: the quest
  // component owns its own interactions and its own read.
  assert.doesNotMatch(code, /fetch\(/);
  assert.doesNotMatch(code, /<button/);
});

test("the page says what counts and that coins have no cash value", () => {
  const page = read(PAGE);
  assert.match(page, /completed matches against real players/i);
  assert.match(page, /no cash value/i);
  assert.match(page, /cannot be\s+withdrawn/i);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The component
// ════════════════════════════════════════════════════════════════════════

test("daily and weekly quests are rendered as two clearly separated sections", () => {
  const board = read(BOARD);
  assert.match(board, /renderSection\(\s*"daily"/);
  assert.match(board, /renderSection\(\s*"weekly"/);
  assert.match(board, /t\("quests\.dailyTitle"\)/);
  assert.match(board, /t\("quests\.weeklyTitle"\)/);
  assert.match(board, /data-testid={`quests-list-\$\{key\}`}/);
});

test("each quest shows its objective, progress, target, reward and status", () => {
  const board = read(BOARD);
  assert.match(board, /quest\.title/);
  assert.match(board, /quest\.description/);
  assert.match(board, /formatCoins\(quest\.reward\)/);
  assert.match(board, /formatCoins\(quest\.progress\)/);
  assert.match(board, /formatCoins\(quest\.target\)/);
  // The bar is a real, accessible progress indicator derived from server data.
  assert.match(board, /role="progressbar"/);
  assert.match(board, /aria-valuenow=\{percent\}/);
  assert.match(board, /percentOf\(quest\)/);
  assert.match(board, /Math\.round\(\(progress \/ target\) \* 100\)/);
});

test("the claim button exists only for a complete, unclaimed quest", () => {
  const board = read(BOARD);
  const claimBranch = board.indexOf("quest.claimable ? (");
  const button = board.indexOf("<button", claimBranch);
  const nextBranch = board.indexOf(") : (", claimBranch);

  assert.ok(claimBranch > 0, "the claimable branch must exist");
  assert.ok(button > claimBranch, "the claim button lives in the claimable branch");
  assert.ok(button < nextBranch, "it must not leak into the in-progress branch");
  assert.match(board, /quest\.claimed \? \(/);
  assert.match(board, /void claim\(id\)/);
  assert.match(board, /disabled=\{claiming\}/);
});

test("signed-out, loading, empty and error states are all rendered", () => {
  const board = read(BOARD);
  assert.match(board, /data-testid="quests-signed-out"/);
  assert.match(board, /data-testid="quests-loading"/);
  assert.match(board, /data-testid="quests-empty"/);
  assert.match(board, /data-testid="quests-error"/);
  assert.match(board, /data-testid="quests-retry"/);
  assert.match(board, /t\("quests\.signIn"\)/);
  assert.match(board, /t\("quests\.loadError"\)/);
  // A signed-out visitor never gets a fabricated board.
  assert.match(board, /!isSignedIn \?/);
});

test("the board states that progress needs real human opponents", () => {
  const board = read(BOARD);
  assert.match(board, /t\("quests\.requiresHumanPvp"\)/);
});

test("quest text is translated through the existing translation hook", () => {
  const board = read(BOARD);
  assert.match(board, /import \{ useTranslation \} from "\.\.\/hooks\/useTranslation"/);
  assert.match(board, /const \{ t \} = useTranslation\(\)/);
  // Localised title/description with the server's text as the fallback.
  assert.match(board, /quests\.defs\.\$\{quest\.definitionId\}\.title/);
  assert.match(board, /quests\.defs\.\$\{quest\.definitionId\}\.description/);
});

// ════════════════════════════════════════════════════════════════════════
// 3. The client hook
// ════════════════════════════════════════════════════════════════════════

test("the hook reads the server board without caching and never invents progress", () => {
  const hook = read(HOOK);
  assert.match(hook, /fetch\("\/api\/quests", \{ cache: "no-store" \}\)/);
  // No local rule engine: progress/target/reward/claimed arrive from the server.
  assert.doesNotMatch(hook, /progress \+=|reward =|claimed = true/);
  // Only the quest id is ever sent, and no user identity is ever in the body.
  assert.match(hook, /JSON\.stringify\(\{ questId \}\)/);
  assert.doesNotMatch(hook, /userId|clerkId/);
});

test("a successful claim refreshes the shared balance readers", () => {
  const hook = read(HOOK);
  assert.match(hook, /import \{ notifyCoinBalanceChanged \} from "\.\/useCoinBalance"/);
  assert.match(hook, /notifyCoinBalanceChanged\(\)/);
  assert.match(hook, /Number\(json\.credited \?\? 0\)/);
});

test("a signed-out visitor fires no authenticated request", () => {
  const hook = read(HOOK);
  assert.match(hook, /if \(!isSignedIn\) \{\s*setLoading\(false\)/);
  assert.match(hook, /if \(!isLoaded\) return;/);
});

test("a refused claim re-reads the board and surfaces the reason", () => {
  const hook = read(HOOK);
  assert.match(hook, /typeof json\?\.error === "string"/);
  assert.match(hook, /await load\(\);\s*\n\s*setError\(\(previous\) => previous \?\? message\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 4. The API routes
// ════════════════════════════════════════════════════════════════════════

test("the status route authenticates and refuses a signed-out read", () => {
  const route = read(STATUS_ROUTE);
  assert.match(route, /import \{ auth \} from "@clerk\/nextjs\/server"/);
  assert.match(route, /const \{ userId \} = await auth\(\)/);
  assert.match(route, /if \(!userId\)[\s\S]*?status: 401/);
  assert.match(route, /getQuestStatus\(\{ clerkId: userId \}\)/);
  assert.match(route, /daily: result\.daily[\s\S]*?weekly: result\.weekly/);
  assert.match(route, /balance: result\.balance/);
});

test("the claim route reads the user from the session and only the quest id from the body", () => {
  const route = read(CLAIM_ROUTE);
  assert.match(route, /\(\{ userId \} = await auth\(\)\)/);
  // The `userId` used for the claim always comes from that destructuring and
  // is never read from the request.
  assert.doesNotMatch(route, /req.*userId/);
  assert.match(route, /claimQuestReward\(\{ clerkId: userId, questId \}\)/);
  assert.match(route, /const questId = \(body as \{ questId\?: unknown \}\)\?\.questId/);
  // The body never supplies the user, the amount or the state.
  assert.doesNotMatch(route, /body\.(userId|clerkId|reward|amount|progress|claimed)/);
  assert.match(route, /credited: result\.credited/);
  assert.match(route, /balance: result\.balance/);
  assert.match(route, /\{ status: result\.status \}/);
});

// ════════════════════════════════════════════════════════════════════════
// 5. The claim's server-side guarantees
// ════════════════════════════════════════════════════════════════════════

test("the claim locks the player's own row and validates the active period", () => {
  const lib = read(CLAIM_LIB);
  assert.match(lib, /WHERE id = \$\{id\} AND user_id = \$\{player\.id\}/);
  assert.match(lib, /FOR UPDATE/);
  // The stored period key is compared with the period containing "now", so a
  // previous period can never pay late.
  assert.match(lib, /row\.periodKey !== periodKeyFor\(row\.periodType/);
  assert.match(lib, /status: 409,\s*\n\s*reason: "expired"/);
  // Complete + unclaimed is the only state that may pay.
  assert.match(lib, /if \(!isQuestComplete\(row\) \|\| !canClaimQuest\(row\)\)/);
});

test("the claim marks the row conditionally and credits the stored reward once", () => {
  const lib = read(CLAIM_LIB);
  // Conditional write: the second caller of a double-click writes nothing.
  assert.match(lib, /SET claimed = true\s*\n\s*WHERE id = \$\{id\} AND claimed = false\s*\n\s*RETURNING id/);
  // One ledger row per (period, key, quest) — the durable audit key.
  assert.match(lib, /referenceId = `\$\{row\.periodType\}:\$\{row\.periodKey\}:\$\{id\}`/);
  assert.match(lib, /QUEST_REWARD_REFERENCE/);
  // The amount is the stored reward, never a request value.
  assert.match(lib, /const reward = Math\.floor\(Number\(row\.reward\)\)/);
  // Same atomic credit + peak-balance mark every other payout uses.
  assert.match(lib, /balance = balance \+ \$\{reward\}/);
  assert.match(lib, /GREATEST\(peak_balance, balance \+ \$\{reward\}\)/);
  // No wallet ceiling may block a legitimate reward.
  assert.doesNotMatch(lib, /WALLET_HARD_CAP|wallet is full|MAX_BALANCE/);
});

test("the claim is a transaction over the caller's executor", () => {
  const lib = read(CLAIM_LIB);
  assert.match(lib, /return tx \? run\(tx\) : db\.transaction\(run\)/);
});

// ════════════════════════════════════════════════════════════════════════
// 6. Translations (en / fr / es)
// ════════════════════════════════════════════════════════════════════════

test("every supported locale carries the quest strings", () => {
  const required = [
    "title",
    "available",
    "requiresHumanPvp",
    "claimedNow",
    "loading",
    "signIn",
    "signedOutHint",
    "loadError",
    "retry",
    "empty",
    "dailyTitle",
    "dailyResets",
    "weeklyTitle",
    "weeklyResets",
    "progressLabel",
    "progressOf",
    "progressBarLabel",
    "claimed",
    "claim",
    "claiming",
    "inProgress",
  ];

  for (const lang of ["en", "fr", "es"]) {
    const bundle = APP_TEXT_TRANSLATIONS[lang];
    assert.ok(bundle?.quests, `${lang} must carry quests.*`);
    for (const key of required) {
      assert.equal(
        typeof bundle.quests[key],
        "string",
        `${lang}.quests.${key} must be a string`,
      );
      assert.ok(bundle.quests[key].length > 0, `${lang}.quests.${key} must not be empty`);
    }
    // Every definition the catalog ships has a localised title + description.
    for (const definition of [...DAILY_QUESTS, ...WEEKLY_QUESTS]) {
      const entry = bundle.quests.defs?.[definition.id];
      assert.ok(entry, `${lang}.quests.defs.${definition.id} must exist`);
      assert.ok(entry.title, `${lang}.quests.defs.${definition.id}.title`);
      assert.ok(entry.description, `${lang}.quests.defs.${definition.id}.description`);
    }
  }

  // Spot-check that the bundles are genuinely translated, not English copies.
  assert.equal(APP_TEXT_TRANSLATIONS.fr.quests.title, "Quêtes");
  assert.equal(APP_TEXT_TRANSLATIONS.es.quests.title, "Misiones");
  assert.match(read(TRANSLATIONS), /requiresHumanPvp:/);
});

test("interpolation placeholders used by the UI exist in the strings", () => {
  const board = read(BOARD);
  for (const key of ["available", "claimedNow", "progressOf", "progressBarLabel", "claim"]) {
    assert.match(board, new RegExp(`quests\\.${key}`), `the UI must use quests.${key}`);
  }
  for (const lang of ["en", "fr", "es"]) {
    const quests = APP_TEXT_TRANSLATIONS[lang].quests;
    assert.match(quests.available, /\{amount\}/);
    assert.match(quests.claimedNow, /\{amount\}/);
    assert.match(quests.progressOf, /\{progress\}/);
    assert.match(quests.progressOf, /\{target\}/);
    assert.match(quests.progressBarLabel, /\{title\}/);
    assert.match(quests.claim, /\{reward\}/);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 7. The daily reward is untouched
// ════════════════════════════════════════════════════════════════════════

test("the daily reward keeps its own route and its own claim path", () => {
  const daily = read("src/app/api/rewards/daily/route.ts");
  assert.match(daily, /claimDailyReward\(userId\)/);
  assert.match(daily, /getDailyRewardStatus\(userId\)/);
  // Quests did not take over the daily endpoint.
  assert.doesNotMatch(daily, /quest/i);

  const card = read("src/components/DailyRewardCard.tsx");
  assert.match(card, /useDailyReward/);
  assert.match(card, /\/rewards\/daily/);
});

// ════════════════════════════════════════════════════════════════════════
// 8. The corner quest widget (home page + games hub) and its popup
// ════════════════════════════════════════════════════════════════════════

const WIDGET = "src/components/QuestWidget.tsx";
const POPUP = "src/components/QuestPopup.tsx";

for (const page of ["src/app/PageClient.jsx", "src/app/casino/PageClient.jsx"]) {
  test(`${page} mounts the quest widget beside the daily reward`, () => {
    const source = read(page);
    assert.match(
      source,
      /import QuestWidget from "[\.\/]+components\/QuestWidget"/,
      "the widget must be mounted from the shared component",
    );
    const daily = source.indexOf("<DailyRewardWidget />");
    const quests = source.indexOf("<QuestWidget />");
    assert.ok(daily > -1, "the daily reward still renders");
    assert.ok(quests > daily, "the quest widget renders beside it, not instead of it");
  });
}

test("the widget is the top-left twin of the daily reward, inline on phones", () => {
  const widget = read(WIDGET);
  // Pinned left (fixed only from `md` up, below the fixed navbar), never right.
  assert.match(widget, /md:fixed md:left-4 md:top-\[104px\] md:z-30/);
  assert.doesNotMatch(widget, /md:right-4/);
  assert.match(widget, /mt-3 px-4 md:mt-0 md:px-0/);
  assert.match(widget, /data-testid="quest-widget"/);
});

test("the widget summarises the server board and never claims on its own", () => {
  const widget = read(WIDGET);
  // One read path: the shared hook, the same one /rewards uses.
  assert.match(widget, /import \{ useQuests \} from "\.\.\/hooks\/useQuests"/);
  assert.match(widget, /const quests = useQuests\(\)/);
  assert.doesNotMatch(widget, /fetch\(/, "the widget must not fetch behind the hook's back");
  // Progress, targets, completion and claimability are the server's numbers.
  assert.match(widget, /quest\.claimable \? sum \+ \(Number\(quest\.reward\) \|\| 0\)/);
  assert.match(widget, /quest\.completed/);
  assert.match(widget, /formatCoins\(nextQuest\.progress\)/);
  assert.match(widget, /formatCoins\(nextQuest\.target\)/);
  assert.doesNotMatch(widget, /progress \+=|reward =|claimed = true/);
  // It opens the board; the only claim button lives in the popup.
  assert.match(widget, /data-testid="quest-widget-open"/);
  assert.match(widget, /<QuestPopup open=\{open\} onClose=\{\(\) => setOpen\(false\)\} quests=\{quests\} \/>/);
  assert.doesNotMatch(widget, /void claim\(/);
  // A signed-out visitor gets no corner at all.
  assert.match(widget, /if \(!isLoaded \|\| !isSignedIn\) return null;/);
});

test("the popup lists both periods with the shared progress and one claim path", () => {
  const popup = read(POPUP);
  assert.match(popup, /renderSection\(\s*"daily"/);
  assert.match(popup, /renderSection\(\s*\n?\s*"weekly"/);
  assert.match(popup, /t\("quests\.dailyTitle"\)/);
  assert.match(popup, /t\("quests\.weeklyTitle"\)/);
  // Every card carries the server's progress and an accessible bar.
  assert.match(popup, /data-testid={`quest-widget-progress-\$\{id\}`}/);
  assert.match(popup, /role="progressbar"/);
  assert.match(popup, /aria-valuenow=\{percent\}/);
  assert.match(popup, /t\("quests\.progressOf", \{/);
  // A claim button ONLY for a server-confirmed claimable quest, and it sends
  // nothing but the quest id (the hook owns the request).
  assert.match(popup, /quest\.claimed \? \(/);
  assert.match(popup, /quest\.claimable \? \(/);
  assert.match(popup, /void claim\(id\)/);
  assert.match(popup, /disabled=\{claiming\}/);
  assert.doesNotMatch(popup, /fetch\(/);
  // The same shared state, handed down — a claim updates the widget's counter.
  assert.match(popup, /quests: UseQuests/);
});

test("the popup is a real dialog: portalled, escapable, focus managed", () => {
  const popup = read(POPUP);
  assert.match(popup, /import \{ createPortal \} from "react-dom"/);
  assert.match(popup, /createPortal\(/);
  assert.match(popup, /document\.body,/);
  assert.match(popup, /role="dialog"/);
  assert.match(popup, /aria-modal="true"/);
  assert.match(popup, /event\.key === "Escape"/);
  assert.match(popup, /document\.body\.style\.overflow = "hidden"/);
  assert.match(popup, /previous\.focus\(\)/);
  // The honest states are rendered as themselves.
  assert.match(popup, /data-testid="quest-widget-loading"/);
  assert.match(popup, /data-testid="quest-widget-error"/);
  assert.match(popup, /data-testid="quest-widget-empty"/);
  assert.match(popup, /data-testid="quest-widget-retry"/);
  // Quest text is translated, with the server's copy as the fallback.
  assert.match(popup, /useQuestText\(\)/);
  assert.match(popup, /quests\.defs\.\$\{quest\.definitionId\}\.title/);
});

test("the games hub nav link carries a badge while quests are claimable", () => {
  const nav = read("src/components/navigation-bar.jsx");
  assert.match(nav, /import QuestNavBadge from "\.\/QuestNavBadge"/);
  // Both nav surfaces: the desktop row and the mobile menu.
  const mounts = nav.split("<QuestNavBadge />").length - 1;
  assert.equal(mounts, 2, "the badge must be in the desktop row and the mobile menu");
  // It hangs off the /games entry, not every link.
  assert.equal(
    nav.split('path === "/games" ? (').length - 1,
    2,
    "the badge must gate on the Games hub path in both lists",
  );

  const badge = read("src/components/QuestNavBadge.tsx");
  // Same read as the board: the server's `claimable` flag decides.
  assert.match(badge, /import \{ useQuests \} from "\.\.\/hooks\/useQuests"/);
  assert.match(badge, /quest\.claimable/);
  assert.match(badge, /if \(claimable === 0\) return null;/);
  // A signed-out visitor gets nothing.
  assert.match(badge, /if \(!isLoaded \|\| !isSignedIn \|\| !board\) return null;/);
  // It never fetches or credits on its own.
  assert.doesNotMatch(badge, /fetch\(|credited|progress \+=/);
  // The nav mounts on every page, so this instance opts out of the per-focus
  // re-read and refreshes on the shared balance event (a claim announces it).
  assert.match(badge, /useQuests\(\{ autoRefresh: false \}\)/);
  assert.match(badge, /window\.addEventListener\(COIN_BALANCE_EVENT, refresh\)/);
  assert.match(badge, /data-testid="quest-nav-badge"/);
  assert.match(badge, /t\("quests\.badgeLabel", \{ count: claimable \}\)/);
});

test("the nav badge's label is translated and interpolated everywhere", () => {
  for (const lang of ["en", "fr", "es"]) {
    const label = APP_TEXT_TRANSLATIONS[lang]?.quests?.badgeLabel;
    assert.equal(typeof label, "string", `${lang}.quests.badgeLabel`);
    assert.match(label, /\{count\}/, `${lang}.quests.badgeLabel needs {count}`);
  }
});

test("the widget's own copy exists in all three locales", () => {
  const required = ["viewAll", "nextUp", "doneOf", "allDone", "close"];
  for (const lang of ["en", "fr", "es"]) {
    const quests = APP_TEXT_TRANSLATIONS[lang]?.quests;
    assert.ok(quests, `${lang} must carry quests.*`);
    for (const key of required) {
      assert.equal(typeof quests[key], "string", `${lang}.quests.${key}`);
      assert.ok(quests[key].length > 0, `${lang}.quests.${key} must not be empty`);
    }
    assert.match(quests.nextUp, /\{title\}/, `${lang}.quests.nextUp needs {title}`);
    assert.match(quests.doneOf, /\{done\}/, `${lang}.quests.doneOf needs {done}`);
    assert.match(quests.doneOf, /\{total\}/, `${lang}.quests.doneOf needs {total}`);
  }
  // The UI actually uses them, so a rename would fail here rather than on screen.
  const widget = read(WIDGET);
  const popup = read(POPUP);
  assert.match(widget, /t\("quests\.viewAll"\)/);
  assert.match(widget, /t\("quests\.nextUp", \{/);
  assert.match(widget, /t\("quests\.doneOf", \{ done, total: all\.length \}\)/);
  assert.match(widget, /t\("quests\.allDone"\)/);
  assert.match(popup, /t\("quests\.close"\)/);
});
