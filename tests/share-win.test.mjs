import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildLadderShareText,
  buildMemberShareText,
  buildWinShareText,
  ladderShareUrl,
  memberCardCopy,
  parseShareCardQuery,
  shareBadgeLabel,
  shareCardHref,
  shareDestinations,
  shareGameLabel,
  shareLocale,
  shareModeLabel,
  sharePageHref,
  sharePanelCopy,
  shareTimeLabel,
  shareWinLinks,
  winShareUrl,
  SHARE_PAGE_PATH,
} from "../src/lib/shareWin.ts";
import {
  WIN_CARD_HEIGHT,
  WIN_CARD_WIDTH,
  drawMemberCard,
  drawWinCard,
  memberCardFacts,
  winCardFacts,
} from "../src/lib/shareCard.ts";
import { readProfileSource } from "./helpers/profile-source.mjs";

const code = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** A canvas context that records what would be painted, so layout is testable. */
function recordCtx() {
  const calls = [];
  const gradient = { addColorStop() {} };
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    createLinearGradient: () => gradient,
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    fillText: (text, x, y) => calls.push(["fillText", text, x, y]),
  };
}

const textsOf = (ctx) =>
  ctx.calls.filter((call) => call[0] === "fillText").map((call) => call[1]);

// ── The post body ───────────────────────────────────────────────────────

test("the shared copy always names the time the run took", () => {
  const ranked = buildWinShareText({
    game: "duel",
    mode: "ranked",
    durationMs: 222_000,
  });
  assert.equal(
    ranked,
    "I won Solitaire Duel (Ranked) in 3:42. Think you can beat that? #GRYND",
  );

  const solo = buildWinShareText({ game: "solitaire", durationMs: 65_000, moves: 84 });
  assert.equal(
    solo,
    "I won Solitaire in 1:05 — 84 moves. Think you can beat that? #GRYND",
  );

  assert.equal(shareTimeLabel(222_000), "3:42");
});

test("an unmeasurable duration is omitted, never faked", () => {
  assert.equal(shareTimeLabel(0), null);
  assert.equal(shareTimeLabel(null), null);
  assert.equal(shareTimeLabel(undefined), null);
  assert.equal(shareTimeLabel(Number.NaN), null);

  const text = buildWinShareText({ game: "duel", mode: "ranked", durationMs: null });
  assert.equal(text, "I won Solitaire Duel (Ranked). Think you can beat that? #GRYND");
  assert.doesNotMatch(text, /NaN|undefined|0:00/);
});

test("the time survives a race longer than an hour", () => {
  assert.equal(shareTimeLabel(3_723_000), "1:02:03");
  assert.match(buildWinShareText({ game: "solitaire", durationMs: 3_723_000 }), /in 1:02:03/);
});

test("the post is written in the player's own language", () => {
  const fr = buildWinShareText(
    { game: "duel", mode: "ranked", durationMs: 222_000, moves: 84 },
    "fr",
  );
  assert.equal(
    fr,
    "J'ai gagné Solitaire Duel (Classé) en 3:42 — 84 coups. Tu fais mieux ? #GRYND",
  );

  const es = buildWinShareText(
    { game: "duel", mode: "ranked", durationMs: 222_000, moves: 84 },
    "es",
  );
  assert.equal(
    es,
    "Gané Duelo de Solitario (Clasificatoria) en 3:42 — 84 jugadas. ¿Puedes superarlo? #GRYND",
  );

  // Solo has no mode to name, and the daily is its own game key.
  assert.match(buildWinShareText({ game: "daily", durationMs: 60_000 }, "fr"), /^J'ai gagné Solitaire quotidien en 1:00\./);
  assert.equal(shareGameLabel("unknown-game", "fr"), "unknown-game");
  assert.equal(shareModeLabel(null, "es"), null);
  assert.equal(shareLocale("FR"), "fr");
  assert.equal(shareLocale("de"), "en");
});

test("the badge is server-resolved, validated and localized into the sentence", () => {
  assert.equal(shareBadgeLabel("FOUNDER"), "GRYND Founder");
  assert.equal(shareBadgeLabel("pro"), "GRYND PRO");
  assert.equal(shareBadgeLabel("ADMIN"), null);
  assert.equal(shareBadgeLabel(null), null);

  const founder = buildWinShareText({
    game: "duel",
    mode: "ranked",
    durationMs: 222_000,
    badge: "FOUNDER",
  });
  assert.equal(
    founder,
    "I won Solitaire Duel (Ranked) in 3:42 (GRYND Founder). Think you can beat that? #GRYND",
  );

  assert.match(
    buildWinShareText({ game: "solitaire", durationMs: 60_000, badge: "PRO" }, "fr"),
    /en 1:00 \(GRYND PRO\)\./,
  );
});

// ── Destinations ────────────────────────────────────────────────────────

test("every destination is a plain compose link carrying the text and the URL", () => {
  const url = "https://www.grynd.dedyn.io/share/win?g=solitaire";
  const links = shareWinLinks({ game: "solitaire", mode: "practice", durationMs: 60_000 }, url);

  assert.deepEqual(
    links.map((link) => link.id),
    ["x", "whatsapp", "facebook", "telegram", "reddit"],
  );

  const encodedUrl = encodeURIComponent(url);
  const encodedText = encodeURIComponent("I won Solitaire (Play vs AI) in 1:00");
  for (const link of links) {
    assert.match(link.href, /^https:\/\//);
    assert.ok(link.href.includes(encodedUrl), `${link.id} carries the page`);
    if (link.id !== "facebook") {
      assert.ok(link.href.includes(encodedText), `${link.id} carries the copy`);
    }
  }

  assert.equal(shareDestinations("hi", url).length, 5);
});

// ── The share page and its card ─────────────────────────────────────────

test("a share points at the generated page, and the query survives a round trip", () => {
  const input = {
    game: "duel",
    mode: "ranked",
    durationMs: 222_000,
    moves: 84,
    badge: "FOUNDER",
  };

  assert.equal(
    sharePageHref(input, "fr"),
    `${SHARE_PAGE_PATH}?g=duel&m=ranked&t=222000&mv=84&b=FOUNDER&l=fr`,
  );
  assert.equal(shareCardHref(input), "/api/share/win-card?g=duel&m=ranked&t=222000&mv=84&b=FOUNDER");
  // Absolute in a browser (origin + page); the test process has no `window`,
  // so it falls back to the configured canonical origin. Either way the page
  // and its query are the same.
  assert.ok(winShareUrl(input).endsWith(sharePageHref(input)));
  assert.ok(winShareUrl(input).startsWith("http"));
  assert.equal(winShareUrl({ ...input, url: "https://example.test/x" }), "https://example.test/x");
  assert.equal(winShareUrl({ game: "solitaire" }, "https://grynd.test"), "https://grynd.test/share/win?g=solitaire");

  const parsed = parseShareCardQuery(new URLSearchParams("g=duel&m=ranked&t=222000&mv=84&b=FOUNDER&l=fr"));
  assert.deepEqual(parsed.input, input);
  assert.equal(parsed.locale, "fr");
});

test("an untrusted query is narrowed before it reaches the card", () => {
  const parsed = parseShareCardQuery(
    new URLSearchParams("g=%3Cscript%3E&m=evil&t=999999999999&mv=-4&b=ADMIN&l=de"),
  );
  assert.equal(parsed.input.game, "solitaire");
  assert.equal(parsed.input.mode, null);
  assert.equal(parsed.input.durationMs, 24 * 60 * 60 * 1000);
  assert.equal(parsed.input.moves, null);
  assert.equal(parsed.input.badge, null);
  assert.equal(parsed.locale, "en");

  assert.equal(parseShareCardQuery(null).input.game, "solitaire");
  assert.equal(parseShareCardQuery({ g: ["daily", "x"] }).input.game, "daily");
});

test("the card draws the same numbers the post names, in the same language", () => {
  const ctx = recordCtx();
  const facts = drawWinCard(
    ctx,
    { game: "duel", mode: "ranked", durationMs: 222_000, moves: 84, badge: "FOUNDER" },
    "fr",
  );

  assert.equal(facts.time, "3:42");
  assert.equal(facts.headline, "SOLITAIRE DUEL  ·  CLASSÉ");
  assert.equal(facts.badge, "GRYND Founder");
  assert.equal(facts.detail, "84 COUPS");

  const texts = textsOf(ctx);
  assert.ok(texts.includes("3:42"), "the hero time is painted");
  assert.ok(texts.includes("GRYND"), "the wordmark is painted");
  assert.ok(texts.includes("GRYND Founder"), "the badge is painted");
  assert.ok(texts.includes("84 COUPS"));
  assert.ok(texts.some((text) => text.includes("#GRYND")));

  // The layout is fixed, so nothing can be painted outside the frame.
  for (const [, , x, y] of ctx.calls.filter((call) => call[0] === "fillText")) {
    assert.ok(x >= 0 && x <= WIN_CARD_WIDTH, `x ${x} inside the card`);
    assert.ok(y >= 0 && y <= WIN_CARD_HEIGHT, `y ${y} inside the card`);
  }
});

test("a card with no measured time shows a win, not a fake 0:00", () => {
  const ctx = recordCtx();
  const facts = drawWinCard(ctx, { game: "solitaire", durationMs: null, moves: 84 }, "es");

  assert.equal(facts.time, null);
  assert.equal(facts.headline, "SOLITARIO  ·  RESUELTO");
  assert.equal(facts.detail, "84 JUGADAS");

  const texts = textsOf(ctx);
  assert.ok(texts.includes("WIN"));
  assert.ok(!texts.some((text) => text.includes("0:00")));
});

test("the member's card carries the mark, and only for a member", () => {
  assert.equal(memberCardFacts(null, "en"), null);
  assert.equal(buildMemberShareText(null, "en"), null);
  assert.equal(memberCardCopy("ADMIN", "en"), null);

  const facts = memberCardFacts("FOUNDER", "fr");
  assert.equal(facts.role, "FONDATEUR");
  assert.match(facts.tagline, /je soutiens le jeu compétitif indépendant/i);

  const ctx = recordCtx();
  drawMemberCard(ctx, "FOUNDER", "fr");
  const texts = textsOf(ctx);
  assert.ok(texts.includes("GRYND PRO"));
  assert.ok(texts.includes("FONDATEUR"));

  assert.equal(
    buildMemberShareText("PRO", "en"),
    "I'm a GRYND PRO member — supporting independent competitive gaming. #GRYND",
  );
  assert.match(buildMemberShareText("FOUNDER", "es"), /Soy fundador de GRYND PRO/);
});

// ── Wiring ──────────────────────────────────────────────────────────────

test("the panel previews the post and builds the card in the player's language", () => {
  const cmp = code("src/components/share/ShareWinButton.tsx");
  assert.match(cmp, /const \{ language \} = useLanguage\(\)/);
  assert.match(cmp, /const text = buildWinShareText\(\{ \.\.\.input, badge \}, locale\)/);
  assert.match(cmp, /createWinCardDataUrl\(\s*\{ game, mode, durationMs, moves, url, badge: nextBadge \},\s*locale,?\s*\)/);
  assert.match(cmp, /const href = winShareUrl\(\{ \.\.\.input, badge \}\)/);
  assert.ok(cmp.includes("data-testid={`${testId}-panel`}"));
  assert.ok(cmp.includes("data-testid={`${testId}-text`}"));
  assert.match(cmp, /rel="noopener noreferrer"/);
  assert.match(cmp, /download=\{winCardFilename\(\)\}/);
  assert.match(cmp, /typeof navigator\.share === "function"/);
});

test("all four surfaces share wins, and only on a win", () => {
  const solo = code("src/components/solitaire-duel/SoloSolitaireGame.tsx");
  assert.match(solo, /<ShareWinButton/);
  assert.match(solo, /game=\{mode === "daily" \? "daily" : "solitaire"\}/);
  assert.match(solo, /durationMs=\{elapsedMs\}/);
  assert.match(solo, /<ShareWinButton\s+\n?\s*compact/);
  assert.match(solo, /testId=\{`solitaire-history-share-\$\{row\.id\}`\}/);

  const result = code("src/components/result/PvpResultScreen.jsx");
  assert.match(result, /shareWin && outcome === "win"/);
  assert.match(result, /game=\{shareWin\.game \?\? "duel"\}/);
  assert.equal((result.match(/<ShareWinButton/g) || []).length, 1);

  const match = code("src/app/casino/solitaire-duel/[matchId]/PageClient.tsx");
  assert.match(match, /shareWin=\{\{ mode: isPractice \? "practice" : "ranked" \}\}/);

  const offline = code("src/components/solitaire-duel/OfflineSolitaireMatch.tsx");
  assert.match(offline, /outcome === "win" \? \(\s*<div className="mt-3 flex justify-center">/);
  assert.match(offline, /mode="practice"/);
});

test("the share page carries the card as its social image", () => {
  const page = code("src/app/share/win/page.tsx");
  assert.match(page, /ogImageUrl\(shareCardHref\(input, locale\)\)/);
  assert.match(page, /card: "summary_large_image"/);
  assert.match(page, /images: \[\{ url: image, width: 1200, height: 630/);
  // Generated per query: previewed, never indexed.
  assert.match(page, /robots: \{ index: false, follow: true \}/);
  assert.match(page, /src=\{shareCardHref\(input, locale\)\}/);

  const route = code("src/app/api/share/win-card/route.tsx");
  assert.match(route, /import \{ ImageResponse \} from "next\/og"/);
  assert.match(route, /parseShareCardQuery\(new URL\(request\.url\)\.searchParams\)/);
  assert.match(route, /width: 1200,\s*height: 630/);
  assert.match(route, /Cache-Control/);
  // A card is a picture of a claim, not a verification of one.
  assert.doesNotMatch(route, /from "@clerk|drizzle|db\//);
});

test("every panel label is translated, and no component hardcodes one", () => {
  const en = sharePanelCopy("en");
  const fr = sharePanelCopy("fr");
  const es = sharePanelCopy("es");

  for (const key of Object.keys(en)) {
    assert.equal(typeof en[key], "string", `en.${key}`);
    assert.ok(fr[key] && fr[key].trim(), `fr.${key} exists`);
    assert.ok(es[key] && es[key].trim(), `es.${key} exists`);
    assert.notEqual(fr[key], en[key], `fr.${key} is translated`);
    assert.notEqual(es[key], en[key], `es.${key} is translated`);
  }

  // The same locale fallback the post uses.
  assert.equal(sharePanelCopy(shareLocale("de")).shareWin, en.shareWin);
  assert.equal(sharePanelCopy(shareLocale("FR")).saveCard, fr.saveCard);

  const win = code("src/components/share/ShareWinButton.tsx");
  const badge = code("src/components/share/ShareProBadgeButton.tsx");
  for (const cmp of [win, badge]) {
    assert.match(cmp, /const copy = sharePanelCopy\(locale\)/);
    assert.match(cmp, /\{copy\.saveCard\}/);
    assert.match(cmp, /\{copy\.shareImage\}/);
    assert.match(cmp, /\{copy\.copy\}/);
    // No English control text left behind.
    assert.doesNotMatch(cmp, />\s*Save card\s*</);
    assert.doesNotMatch(cmp, />\s*Share image\s*</);
    assert.doesNotMatch(cmp, />\s*Copy\s*</);
    assert.doesNotMatch(cmp, /aria-label="Share/);
  }
  assert.match(win, /\{compact \? copy\.share : copy\.shareWin\}/);
  assert.match(badge, /\{copy\.shareBadge\}/);
});

test("the podium shares the viewer's own standing, in their language", () => {
  assert.equal(
    buildLadderShareText({ rank: 2, score: 1450 }, "en"),
    "I'm #2 on the GRYND leaderboard with 1,450 points. Think you can climb higher? #GRYND",
  );
  assert.equal(
    buildLadderShareText({ rank: 1 }, "fr"),
    "Je suis n°1 du classement GRYND. Tu peux faire mieux ? #GRYND",
  );
  assert.match(buildLadderShareText({ rank: 3, score: 900 }, "es"), /^Soy n\.º 3 en la clasificación de GRYND con 900 puntos\./);

  // No rank, no post — and a dishonest rank is refused, not clamped.
  assert.equal(buildLadderShareText({ rank: 0 }), null);
  assert.equal(buildLadderShareText({ rank: -2 }), null);
  assert.equal(buildLadderShareText({ rank: Number.NaN }), null);
  assert.ok(ladderShareUrl("https://grynd.test").endsWith("/classement"));

  const cmp = code("src/components/share/ShareLadderButton.tsx");
  assert.match(cmp, /buildLadderShareText\(\{ rank, score \}, locale\)/);
  assert.match(cmp, /\{copy\.share\}/);
  assert.match(cmp, /if \(!text\) return null;/);

  const board = code("src/app/classement/PageClient.jsx");
  assert.match(board, /import ShareLadderButton from "\.\.\/\.\.\/components\/share\/ShareLadderButton"/);
  // The viewer's own card only, outside the profile link.
  assert.match(board, /\{isMe && \(\s*<div className="mt-1\.5 flex justify-center">\s*<ShareLadderButton/);
  assert.match(board, /score=\{shareScoreForPodium\(item, category\)\}/);
  // The share entry is a sibling of the anchor, never inside it.
  const podium = board.slice(board.indexOf("function Podium"), board.indexOf("function rankStatus"));
  assert.match(podium, /<div key=\{`\$\{item\.clerk_id\}-\$\{item\.rank\}`\} className="relative flex flex-col">/);
  assert.ok(
    podium.indexOf("</Link>") < podium.indexOf("<ShareLadderButton"),
    "the share button follows the closing Link tag",
  );
});

test("the profile can share the PRO badge, for members only", () => {
  const cmp = code("src/components/share/ShareProBadgeButton.tsx");
  assert.match(cmp, /fetch\("\/api\/membership\/badge"/);
  assert.match(cmp, /if \(!loaded \|\| !badge\) return null;/);
  assert.match(cmp, /createMemberCardDataUrl\(label, locale\)/);
  assert.match(cmp, /buildMemberShareText\(badge, locale\)/);
  assert.match(cmp, /memberShareUrl\(\)/);

  const profile = readProfileSource();
  assert.match(profile, /import ShareProBadgeButton from "\.\.\/\.\.\/components\/share\/ShareProBadgeButton"/);
  assert.match(profile, /<ShareProBadgeButton \/>/);

  const route = code("src/app/api/membership/badge/route.ts");
  assert.match(route, /getProBadgeFor\(userId\)/);
  assert.match(route, /badge: null/);
});
