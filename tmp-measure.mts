import { dealFromSeed } from "./src/lib/solitaire-duel/deck.ts";
import { initialStateFromDeal, applyMove, tableauTop, sameCard, foundationExpects } from "./src/lib/solitaire-duel/rules.ts";
import { legalMoves } from "./src/lib/solitaire-duel/ai.ts";
import type { SolitaireState, SolitaireMove } from "./src/lib/solitaire-duel/types.ts";

class Abort {}

function hiddenBelow(s: SolitaireState, m: SolitaireMove): boolean {
  if (m.kind !== "tableau-to-tableau" && m.kind !== "tableau-to-foundation") return false;
  const col = s.tableau[m.fromColumn];
  const idx = col.findIndex((p) => p.faceUp && sameCard(p.card, (m as any).card));
  return idx > 0 && !col[idx - 1].faceUp;
}
function score(s: SolitaireState, m: SolitaireMove): number {
  switch (m.kind) {
    case "tableau-to-foundation": {
      let v = 1000;
      if (hiddenBelow(s, m)) v += 200;
      if (s.tableau[m.fromColumn].length === 1) v += 150;
      return v;
    }
    case "waste-to-foundation": return 950;
    case "waste-to-tableau": return 700;
    case "tableau-to-tableau": {
      if (hiddenBelow(s, m)) return 800;
      const idx = s.tableau[m.fromColumn].findIndex((p) => p.faceUp && sameCard(p.card, m.card));
      if (idx === 0) return 600;
      return 100;
    }
    case "draw": return 250;
    case "foundation-to-tableau": return 5;
    default: return 0;
  }
}
function key(s: SolitaireState): string {
  let out = "";
  for (const col of s.tableau) {
    for (const p of col) out += (p.card ? p.card.rank + "" + p.card.suit[0] : "?") + (p.faceUp ? "U" : "D") + ",";
    out += "|";
  }
  out += "S:" + s.stock.map((c) => c.rank + c.suit[0]).join(",");
  out += "W:" + s.waste.map((c) => c.rank + c.suit[0]).join(",");
  const f = s.foundations;
  out += "F:" + f.spades.length + f.hearts.length + f.diamonds.length + f.clubs.length;
  return out;
}
function fCount(s: SolitaireState) {
  const f = s.foundations;
  return f.spades.length + f.hearts.length + f.diamonds.length + f.clubs.length;
}

function solve(deal: any, budget: number, depthCap = 2500): number | null {
  const visited = new Set<string>();
  let nodes = 0;
  let sol = -1;
  function dfs(st: SolitaireState, depth: number): boolean {
    if (st.completed) { sol = depth; return true; }
    if (nodes++ > budget || depth > depthCap) throw new Abort();
    const k = key(st);
    if (visited.has(k)) return false;
    visited.add(k);
    const moves = legalMoves(st).map((m) => ({ m, v: score(st, m) })).sort((a, b) => b.v - a.v);
    for (const { m } of moves) {
      const r = applyMove({ state: st, move: m });
      if (!r.ok) continue;
      if ((r.state as SolitaireState).completed) { sol = depth + 1; return true; }
      if (dfs(r.state as SolitaireState, depth + 1)) return true;
    }
    return false;
  }
  try { return dfs(initialStateFromDeal(deal), 0) ? sol : null; }
  catch (e) { if (e instanceof Abort) return null; throw e; }
}

const N = 150;
const SEEDS = Array.from({ length: N }, (_, i) => (i * 2654435761 + 4242) % 0xffffffff);
for (const budget of [15000, 30000]) {
  let ok = 0; let worst = 0; const mv: number[] = [];
  const t0 = Date.now();
  for (const seed of SEEDS) {
    const t1 = Date.now();
    const m = solve(dealFromSeed(seed), budget);
    worst = Math.max(worst, Date.now() - t1);
    if (m !== null) { ok++; mv.push(m); }
  }
  const dt = Date.now() - t0;
  mv.sort((a, b) => a - b);
  console.log(`budget=${budget}: solved=${ok}/${N} (${((ok / N) * 100).toFixed(1)}%) time=${dt}ms (${(dt / N).toFixed(1)}ms/deal, worst ${worst}ms) p50moves=${mv[Math.floor(mv.length * 0.5)] ?? "-"} p95=${mv[Math.floor(mv.length * 0.95)] ?? "-"}`);
}
