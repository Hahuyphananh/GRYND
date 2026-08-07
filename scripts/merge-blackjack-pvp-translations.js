// scripts/merge-blackjack-pvp-translations.js
//
// Idempotent merger for the blackjackPvp translation block.
//
// Two-pass strategy per locale:
//   1. Find every occurrence of `blackjackPvp: { ... }` BETWEEN the
//      locale opener and the *next* sibling key. Strip them all (any
//      duplicates left over from prior non-idempotent runs).
//   2. Insert ONE fresh `blackjackPvp: { ... }` block directly
//      below the locale opener, with deterministic key ordering.
//
// Post-write sanity: exactly one `blackjackPvp:` block per locale.
//
// Usage: `node scripts/merge-blackjack-pvp-translations.js`

const fs = require("fs");
const path = require("path");

const TARGET_FILE = path.join(__dirname, "..", "src", "lib", "appTextTranslations.js");

// EN is the canonical source; FR/ES are mirror translations.
const PAYLOAD = {
  en: {
    title: "\u{1F0CF} Blackjack PvP",
    stake: "Stake: {amount}",
    "seat.player1": "Player 1",
    "seat.player2": "Player 2",
    "seat.opponent": "Opponent",
    "status.loading": "Loading\u2026",
    "status.waiting": "Waiting for an opponent\u2026",
    "status.ready": "Get ready\u2026",
    "status.roundN": "Round {n} / 3",
    "status.betweenRounds": "Round {n} won \u2014 round {m} next",
    // Prompt 8 — replaces the legacy `scoreboardLabel` flat key now
    // that GameTableCenter drives the round scoreboard on the live
    // page. Kept for any unrelated call site during a transition.
    "status.finishedDraw": "Match ended in a draw",
    "status.finishedWin": "You won the match",
    "status.finishedLose": "You lost the match",
    "status.cancelled": "Match cancelled",
    "status.activePlay": "In play",
    waitingBusted: "Waiting\u2026",
    waitingStood: "Stood \u2014 waiting for opponent",
    ready: "Ready",
    resign: {
      button: "Resign & return to lobby",
      title: "Resign match?",
      body: "You will forfeit your {amount} stake — your opponent wins the match.",
      confirm: "Resign",
      cancel: "Keep playing",
      loading: "Resigning…",
      error: "Unable to resign",
    },
    historyTitle: "Round history",
    historyRow: "Round {n} \u2014 {seat}: {score} pts",
    historyDraw: "Round {n} \u2014 draw",
    historyWin: "Round {n} \u2014 won",
    historyLose: "Round {n} \u2014 lost",
    result: { win: "You won", draw: "Draw", lose: "You lost" },
    lobby: { back: "Back to lobby" },
    forbidden: {
      title: "Not allowed",
      desc: "This match is not yours to view.",
    },
    invalidId: "Invalid match id",
    heldReserved: "(reserved)",
    heldAdded: "(added to hand)",
    heldDiscarded: "(discarded)",
    // Prompt 8: removed swap1st/swap2nd/hold/swap1stHint/swap2ndHint/
    // scoreboardLabel — consolidated Swap button + Freeze rename moved
    // the surface text under `swap` / `freeze` (and the swap target
    // pill under `swapCard1st` / `swapCard2nd`).
    useHeldAdd: "Use held (add)",
    betweenRounds: {
      title: "Round {n} incoming",
      subtitle: "Round {n} of 3 \u2014 best-of-3",
      scoreCaption: "Best of 3",
      nextRoundHint: "Next round starts shortly\u2026",
      continue: "Continue",
      auto: "Auto",
    },
    priority: {
      title: "Winner priority",
      rule1: "1. Highest score \u2264 21 wins",
      rule2: "2. Bust loses automatically",
      rule3: "3. Equal score = tied round",
    },
    bustedScore: "Busted",
    bustTag: "(busted)",
    roundResultHeader: "Round {n} result",
    matchEndHeader: "Match over",
    // Redrawn PvP interface (Prompt 8) — Swap consolidation + Freeze rename.
    // (Prompt 11) — Click-any-card swap selection replaces the
    // 1st / 2nd pill. `swap` is still the button label, but
    // `swapHint` + the new `swapHintPick` / `swapHintRandom` carry
    // the parent-decided-target semantics.
    swap: "Swap",
    swapHint: "Replace your selected card with a random draw from the shoe",
    swapHintPick: "Click a card first, then press Swap",
    swapHintRandom: "Replace card #{n} with a random draw from the shoe",
    swapPickHint: "Click any card to mark it for swap",
    swapChosenHint: "Card #{n} marked \u2014 press Swap to draw a random replacement",
    swapSelectedBadge: "Swap",
    freeze: "Freeze",
    freezeHint: "Stash your most recently drawn card aside for later",
    useHeldAdd: "Use frozen card",
    useHeldDiscard: "Discard frozen",
    // (Prompt 11) — Peek action. `peek` is the button label,
    // `peekHint` is its tooltip, `peekOverlayLabel` rides the small
    // preview-strip chip that surfaces between MyHand and ActionPanel.
    peek: "Peek",
    peekHint: "Peek at the top of the shoe \u2014 the next card you\u2019d HIT",
    peekOverlayLabel: "Next card",
    scoreboard: {
      player: "Player",
      opponent: "Opponent",
      roundLabel: "Round",
      roundsUnit: "rd",
    },
    // Prompt 7 / 8 — locked-hand + simultaneous reveal text.
    lockedAfterStand: "Hand locked — both hands reveal when the round ends",
    revealTeaser: "Revealing hands\u2026",
    revealTeaserHint: "Both hands flip simultaneously",
    // Prompt 10 — 6-phase orchestrated round-end reveal: SKIP button
    // label shown during the teaser/player/opponent/scores/highlight
    // phases (the full Continue label only appears at phase 5 once
    // the AWARD header is on screen).
    skipReveal: "Skip reveal",
    awardRoundYou: "Round {n} awarded to You",
    awardRoundOpp: "Round {n} awarded to Opponent",
    awardRoundDraw: "Round {n} tied",
    ptsUnit: "pts",
  },
  fr: {
    title: "\u{1F0CF} Blackjack PvP",
    stake: "Mise\u00a0: {amount}",
    "seat.player1": "Joueur 1",
    "seat.player2": "Joueur 2",
    "seat.opponent": "Adversaire",
    "status.loading": "Chargement\u2026",
    "status.waiting": "En attente d\u2019un adversaire\u2026",
    "status.ready": "Pr\u00eat\u2026",
    "status.roundN": "Manche {n} / 3",
    "status.betweenRounds": "Manche {n} gagn\u00e9e \u2014 manche {m} suivante",
    "status.finishedDraw": "Match nul",
    "status.finishedWin": "Vous avez gagn\u00e9 le match",
    "status.finishedLose": "Vous avez perdu le match",
    "status.cancelled": "Match annul\u00e9",
    "status.activePlay": "En jeu",
    waitingBusted: "En attente\u2026",
    waitingStood: "Rest\u00e9 \u2014 en attente de l\u2019adversaire",
    ready: "Pr\u00eat",
    resign: {
      button: "Abandonner et retourner au salon",
      title: "Abandonner la partie ?",
      body: "Vous perdrez votre mise de {amount} \u2014 votre adversaire remporte la partie.",
      confirm: "Abandonner",
      cancel: "Continuer \u00e0 jouer",
      loading: "Abandon en cours\u2026",
      error: "Impossible d'abandonner",
    },
    historyTitle: "Historique des manches",
    historyRow: "Manche {n} \u2014 {seat}\u00a0: {score} pts",
    historyDraw: "Manche {n} \u2014 \u00e9galit\u00e9",
    historyWin: "Manche {n} \u2014 gagn\u00e9e",
    historyLose: "Manche {n} \u2014 perdue",
    result: { win: "Vous avez gagn\u00e9", draw: "\u00c9galit\u00e9", lose: "Vous avez perdu" },
    lobby: { back: "Retour au salon" },
    forbidden: {
      title: "Acc\u00e8s refus\u00e9",
      desc: "Ce match n\u2019est pas le v\u00f4tre.",
    },
    invalidId: "Identifiant de match invalide",
    heldReserved: "(r\u00e9serv\u00e9)",
    heldAdded: "(ajout\u00e9 \u00e0 la main)",
    heldDiscarded: "(d\u00e9fauss\u00e9)",
    // Prompt 8 — see en note above.
    useHeldAdd: "Utiliser la carte r\u00e9serv\u00e9e (ajouter)",
    betweenRounds: {
      title: "Manche {n} \u00e0 venir",
      subtitle: "Manche {n} sur 3 \u2014 meilleur des 3",
      scoreCaption: "Meilleur des 3",
      nextRoundHint: "La prochaine manche commence bient\u00f4t\u2026",
      continue: "Continuer",
      auto: "Auto",
    },
    priority: {
      title: "Priorit\u00e9 du gagnant",
      rule1: "1. Le score le plus \u00e9lev\u00e9 \u2264 21 gagne",
      rule2: "2. D\u00e9passement = perte automatique",
      rule3: "3. Score \u00e9gal = manche nulle",
    },
    bustedScore: "D\u00e9passement",
    bustTag: "(saut\u00e9)",
    roundResultHeader: "R\u00e9sultat de la manche {n}",
    matchEndHeader: "Match termin\u00e9",
    // Redrawn PvP interface (Prompt 8) — Swap consolidation + Freeze rename.
    // (Prompt 11) — Click-any-card swap selection replaces the
    // 1st / 2nd pill. See en block above for rationale.
    swap: "Permuter",
    swapHint: "Remplacer la carte s\u00e9lectionn\u00e9e par un tirage al\u00e9atoire",
    swapHintPick: "Cliquez d\u2019abord sur une carte, puis appuyez sur Permuter",
    swapHintRandom: "Remplacer la carte n\u00b0{n} par un tirage al\u00e9atoire du sabot",
    swapPickHint: "Cliquez sur une carte pour la marquer pour l\u2019\u00e9change",
    swapChosenHint: "Carte n\u00b0{n} marqu\u00e9e \u2014 appuyez sur Permuter",
    swapSelectedBadge: "Permuter",
    freeze: "Geler",
    freezeHint: "Mettre de c\u00f4t\u00e9 votre carte tir\u00e9e pour plus tard",
    useHeldAdd: "Ajouter la carte gel\u00e9e",
    useHeldDiscard: "Jeter la carte gel\u00e9e",
    // (Prompt 11) — Peek action. See en block above for rationale.
    peek: "Espionner",
    peekHint: "Voir le dessus du sabot \u2014 la prochaine carte que vous tireriez",
    peekOverlayLabel: "Prochaine carte",
    scoreboard: {
      player: "Joueur",
      opponent: "Adversaire",
      roundLabel: "Manche",
      roundsUnit: "v.",
    },
    lockedAfterStand: "Main verrouill\u00e9e \u2014 les deux mains se r\u00e9v\u00e8lent \u00e0 la fin de la manche",
    revealTeaser: "R\u00e9v\u00e9lation des mains\u2026",
    revealTeaserHint: "Les deux mains se d\u00e9couvrent simultan\u00e9ment",
    skipReveal: "Passer la r\u00e9v\u00e9lation",
    awardRoundYou: "Manche {n} remport\u00e9e par Vous",
    awardRoundOpp: "Manche {n} remport\u00e9e par l\u2019Adversaire",
    awardRoundDraw: "Manche {n} \u2014 \u00e9galit\u00e9",
    ptsUnit: "pts",
  },
  es: {
    title: "\u{1F0CF} Blackjack PvP",
    stake: "Apuesta: {amount}",
    "seat.player1": "Jugador 1",
    "seat.player2": "Jugador 2",
    "seat.opponent": "Oponente",
    "status.loading": "Cargando\u2026",
    "status.waiting": "Esperando a un oponente\u2026",
    "status.ready": "Prep\u00e1rate\u2026",
    "status.roundN": "Ronda {n} / 3",
    "status.betweenRounds": "Ronda {n} ganada \u2014 ronda {m} siguiente",
    "status.finishedDraw": "Empate",
    "status.finishedWin": "Ganaste el partido",
    "status.finishedLose": "Perdiste el partido",
    "status.cancelled": "Partido cancelado",
    "status.activePlay": "En juego",
    waitingBusted: "Esperando\u2026",
    waitingStood: "Plantado \u2014 esperando al oponente",
    ready: "Listo",
    resign: {
      button: "Abandonar y volver al salón",
      title: "¿Abandonar la partida?",
      body: "Perderás tu apuesta de {amount} — tu oponente gana la partida.",
      confirm: "Abandonar",
      cancel: "Seguir jugando",
      loading: "Abandonando…",
      error: "No se pudo abandonar",
    },
    historyTitle: "Historial de rondas",
    historyRow: "Ronda {n} \u2014 {seat}: {score} pts",
    historyDraw: "Ronda {n} \u2014 empate",
    historyWin: "Ronda {n} \u2014 ganada",
    historyLose: "Ronda {n} \u2014 perdida",
    result: { win: "Ganaste", draw: "Empatado", lose: "Perdiste" },
    lobby: { back: "Volver al sal\u00f3n" },
    forbidden: {
      title: "No permitido",
      desc: "Este partido no es tuyo.",
    },
    invalidId: "Identificador de partido no v\u00e1lido",
    heldReserved: "(reservado)",
    heldAdded: "(a\u00f1adido a la mano)",
    heldDiscarded: "(descartado)",
    // Prompt 8 — see en note above.
    useHeldAdd: "Usar carta apartada (a\u00f1adir)",
    betweenRounds: {
      title: "Ronda {n} entrante",
      subtitle: "Ronda {n} de 3 \u2014 mejor de 3",
      scoreCaption: "Mejor de 3",
      nextRoundHint: "La siguiente ronda empieza pronto\u2026",
      continue: "Continuar",
      auto: "Auto",
    },
    priority: {
      title: "Prioridad del ganador",
      rule1: "1. La puntuaci\u00f3n m\u00e1s alta \u2264 21 gana",
      rule2: "2. Pasarse pierde autom\u00e1ticamente",
      rule3: "3. Puntuaci\u00f3n igual = ronda empatada",
    },
    bustedScore: "Pasado",
    bustTag: "(pasado)",
    roundResultHeader: "Resultado de la ronda {n}",
    matchEndHeader: "Partido terminado",
    // Redrawn PvP interface (Prompt 8) — Swap consolidation + Freeze rename.
    // (Prompt 11) — Click-any-card swap selection replaces the
    // 1st / 2nd pill. See en block above for rationale.
    swap: "Cambiar",
    swapHint: "Reemplazar la carta seleccionada con un robo aleatorio del zapato",
    swapHintPick: "Primero haz clic en una carta, luego pulsa Cambiar",
    swapHintRandom: "Reemplazar la carta n.\u00b0 {n} con un robo aleatorio del zapato",
    swapPickHint: "Haz clic en cualquier carta para marcarla para el cambio",
    swapChosenHint: "Carta n.\u00b0 {n} marcada \u2014 pulsa Cambiar para sacar una carta aleatoria",
    swapSelectedBadge: "Cambiar",
    freeze: "Congelar",
    freezeHint: "Apartar la \u00faltima carta que robaste",
    useHeldAdd: "Usar carta congelada",
    useHeldDiscard: "Descartar carta congelada",
    // (Prompt 11) — Peek action. See en block above for rationale.
    peek: "Espiar",
    peekHint: "Mira la parte superior del zapato \u2014 la pr\u00f3xima carta que robar\u00edas",
    peekOverlayLabel: "Pr\u00f3xima carta",
    scoreboard: {
      player: "Jugador",
      opponent: "Oponente",
      roundLabel: "Ronda",
      roundsUnit: "r.",
    },
    lockedAfterStand: "Mano bloqueada \u2014 ambas manos se revelan al final de la ronda",
    revealTeaser: "Revelando manos\u2026",
    revealTeaserHint: "Las dos manos se descubren simult\u00e1neamente",
    skipReveal: "Saltar revelaci\u00f3n",
    awardRoundYou: "Ronda {n} adjudicada a Ti",
    awardRoundOpp: "Ronda {n} adjudicada al Oponente",
    awardRoundDraw: "Ronda {n} \u2014 empate",
    ptsUnit: "pts",
  },
};

// Serialise a (possibly nested) object into a deterministic JS literal
// at the given indent. Recurses into plain objects so the output
// matches the nested-object shape that the rest of
// `appTextTranslations.js` uses and that `t()`'s dotted-path resolver
// navigates. Keys that aren't safe identifiers (contain dots, spaces,
// etc.) are JSON.stringified so they round-trip as a literal-string
// property name — those are still flat under the affected child.
function buildBlockText(payload, indent = 6) {
  const pad = " ".repeat(indent);
  const innerPad = " ".repeat(indent + 2);
  return Object.keys(payload)
    .sort()
    .map((k) => {
      const v = payload[k];
      const keyRepr =
        /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return (
          innerPad +
          keyRepr +
          ": {\n" +
          buildBlockText(v, indent + 2) +
          "\n" +
          innerPad +
          "}"
        );
      }
      return innerPad + keyRepr + ": " + JSON.stringify(v);
    })
    .join(",\n");
}

// Locates the matching `}` for an opening `{` starting at index
// `start` inside `src`, respecting nested braces and string literals.
// Returns the index of the matching `}`, or -1 if unbalanced.
function findClosingBrace(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
    }
    i++;
  }
  return -1;
}

// Find every `blackjackPvp:` opener between the locale opener and
// the locale's matching closing `}`. Returns absolute `{"start": N,
// "end": M}` ranges (inclusive of `}`) within `src`.
function findAllBlackjackPvpBlocks(src, localeOpenIdx) {
  const ranges = [];
  const fromLocaleStart = localeOpenIdx;
  // Find the locale's matching closing brace so we don't accidentally
  // walk into another locale's block.
  const localeBraceOpen = src.indexOf("{", localeOpenIdx);
  if (localeBraceOpen === -1) return ranges;
  const localeClose = findClosingBrace(src, localeBraceOpen);
  if (localeClose === -1) return ranges;

  const sub = src.slice(fromLocaleStart, localeClose + 1);
  const re = /blackjackPvp\s*:\s*\{/g;
  let m;
  while ((m = re.exec(sub)) !== null) {
    const braceOpenRel = sub.indexOf("{", m.index + m[0].length - 1);
    if (braceOpenRel === -1) continue;
    const closeRel = findClosingBrace(sub, braceOpenRel);
    if (closeRel === -1) continue;
    ranges.push({
      start: fromLocaleStart + m.index, // index of `b` of `blackjackPvp`
      end: fromLocaleStart + closeRel, // index of matching `}`
    });
  }
  return ranges;
}

function main() {
  let src = fs.readFileSync(TARGET_FILE, "utf8");

  for (const locale of Object.keys(PAYLOAD)) {
    // Locale opener without leading whitespace ambiguity: it's the
    // canonical `<indent>${locale}: {`.
    const openerRegex = new RegExp(`(^|\\n)( {2})${locale}: \\{`);
    const openerMatch = openerRegex.exec(src);
    if (!openerMatch) {
      throw new Error(`Locale opener not found: '${locale}: {'`);
    }
    const localeOpenIdx = openerMatch.index + openerMatch[1].length;

    // PASS 1: strip ALL existing blackjackPvp blocks.
    let ranges = findAllBlackjackPvpBlocks(src, localeOpenIdx);
    if (ranges.length > 0) {
      // Sort descending so we can splice without shifting later
      // indices.
      ranges.sort((a, b) => b.start - a.start);
      for (const r of ranges) {
        // Also strip the optional trailing comma if there is one.
        let endIdx = r.end + 1; // exclusive index past `}`
        if (src[endIdx] === ",") endIdx += 1;
        // Trim a single trailing newline so we don't leave a blank line.
        if (src[endIdx] === "\n" && src[endIdx + 1] === "\n") {
          endIdx += 1;
        }
        src = src.slice(0, r.start) + src.slice(endIdx);
      }
    }

    // Re-locate the locale opener inside the (possibly mutated) src.
    const openerMatch2 = openerRegex.exec(src);
    if (!openerMatch2) throw new Error(`Locale opener vanished after edits: ${locale}`);
    const localeOpenIdx2 = openerMatch2.index + openerMatch2[1].length;
    const localeBlockStart = localeOpenIdx2 + `  ${locale}: {`.length;

    // PASS 2: insert the fresh block on a new line, hard-coding a
    // trailing comma after `}` so the next sibling key (e.g. `nav:`)
    // parses regardless of the consumer being strict (tsc) or
    // lenient (node ASI).
    const freshBlock = `\n    blackjackPvp: {\n${buildBlockText(PAYLOAD[locale])}\n    },`;
    src =
      src.slice(0, localeBlockStart) +
      freshBlock +
      src.slice(localeBlockStart);
  }

  fs.writeFileSync(TARGET_FILE, src, "utf8");

  // Sanity: exactly N `blackjackPvp:` openers present (N = locales).
  const openerCount = (src.match(/(^|\n)    blackjackPvp\s*:\s*\{/g) || []).length;
  if (openerCount !== Object.keys(PAYLOAD).length) {
    throw new Error(
      `Expected ${Object.keys(PAYLOAD).length} blackjackPvp blocks, found ${openerCount}.`,
    );
  }

  // JSON.parse the file via a tiny audit import would be ideal, but
  // Node syntax check is sufficient to catch unbalanced braces.
  // `node -c` is run by the developer outside this script.
  console.log(
    `Merged blackjackPvp translation block into ${Object.keys(PAYLOAD).length} locales (clean).`,
  );
}

main();
