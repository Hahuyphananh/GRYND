/**
 * Troop-count arithmetic shared by the Hex Duel action flow
 * (`PageClient.tsx`) and its on-tile popup (`HexTroopPopup.tsx`).
 *
 * A tile must always keep one troop behind, so the most a source can send is
 * `tileTroops - 1`. That can be 0 — the engine's `getAttackSources` offers
 * every adjacent friendly tile, including one holding a lone troop — but
 * sending 0 troops is never a legal action. Everything that reads or writes a
 * send count funnels through here so the value can't leave the 1..max range.
 */

/** The true number of troops that may leave a tile (what it holds, minus the one that stays). */
export const sendableTroops = (tileTroops: number): number =>
  Number.isFinite(tileTroops) ? Math.max(0, Math.floor(tileTroops) - 1) : 0;

/** The upper bound to show for a send count — at least 1, so the UI is never empty. */
export const maxSendLimit = (maxSend: number): number =>
  Number.isFinite(maxSend) ? Math.max(1, Math.floor(maxSend)) : 1;

/** Clamp a chosen send count into the legal 1..maxSendLimit range. */
export const clampSendCount = (count: number, maxSend: number): number => {
  const limit = maxSendLimit(maxSend);
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(Math.floor(count), limit));
};
