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
    "status.finishedDraw": "Match ended in a draw",
    "status.finishedWin": "You won the match",
    "status.finishedLose": "You lost the match",
    "status.cancelled": "Match cancelled",
    scoreboardLabel: "Match score",
    waitingBusted: "Waiting\u2026",
    waitingStood: "Stood \u2014 waiting for opponent",
    ready: "Ready",
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
    swap1st: "Swap card 1",
    swap2nd: "Swap card 2",
    hold: "Hold last card",
    useHeldAdd: "Use held (add)",
    useHeldDiscard: "Use held (discard)",
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
    scoreboardLabel: "Score du match",
    waitingBusted: "En attente\u2026",
    waitingStood: "Rest\u00e9 \u2014 en attente de l\u2019adversaire",
    ready: "Pr\u00eat",
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
    swap1st: "\u00c9changer carte 1",
    swap2nd: "\u00c9changer carte 2",
    hold: "Mettre la derni\u00e8re carte de c\u00f4t\u00e9",
    useHeldAdd: "Utiliser la carte r\u00e9serv\u00e9e (ajouter)",
    useHeldDiscard: "Utiliser la carte r\u00e9serv\u00e9e (d\u00e9fausser)",
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
    scoreboardLabel: "Puntuaci\u00f3n del partido",
    waitingBusted: "Esperando\u2026",
    waitingStood: "Plantado \u2014 esperando al oponente",
    ready: "Listo",
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
    swap1st: "Cambiar carta 1",
    swap2nd: "Cambiar carta 2",
    hold: "Apartar \u00faltima carta",
    useHeldAdd: "Usar carta apartada (a\u00f1adir)",
    useHeldDiscard: "Usar carta apartada (descartar)",
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
  },
};

// Flatten a (possibly nested) object into an alphabetically sorted
// array of [dottedKey, value] tuples. Serialises values to stable
// JSON so surfaces like `"He said \"hi\""` round-trip cleanly.
function flat(prefix, obj) {
  const out = [];
  for (const k of Object.keys(obj).sort()) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flat(path, v));
    } else {
      out.push([path, v]);
    }
  }
  return out;
}

function buildBlockText(payload) {
  const rows = flat("", payload);
  return rows
    .map(([k, v]) => `      "${k}": ${JSON.stringify(v)},`)
    .join("\n");
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

    // PASS 2: insert the fresh block on a new line, with a
    // trailing newline so the locale's next sibling key sits on its
    // own line.
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
