/**
 * Pure helpers for the chat message list in the ChatWidget.
 *
 * Messages enter the list from three sources:
 *   1. The snapshot fetch (initial open / manual Refresh) — full enriched
 *      rows from /api/chat/messages (includes iconKey, premium, equippedTitle,
 *      streakTitle, chatColor, ...).
 *   2. Socket.IO `chat:updated` broadcasts — the full enriched row from the
 *      sender's POST response, forwarded verbatim by the realtime server's
 *      generic `room_event` handler. Moderation broadcasts a patch row
 *      (`{ id, isDeleted: true }`).
 *   3. Supabase Realtime Postgres-Changes — PARTIAL rows: the WAL row only
 *      carries the chat_messages columns, not the join-computed fields the
 *      GET route adds.
 *
 * `upsertChatMessage` merges by id with two guarantees:
 *   - A partial row never clobbers richer fields already in the list
 *     (`undefined` values are skipped).
 *   - A full row always upgrades a partial row already in the list.
 *
 * The list stays sorted oldest→newest (render order) and capped at 75 rows,
 * matching the snapshot `limit=75`.
 */

const MAX_MESSAGES = 75;

export function upsertChatMessage(list, incoming) {
  if (!incoming || incoming.id == null) return list;

  const idx = list.findIndex((msg) => msg.id === incoming.id);

  let next;
  if (idx === -1) {
    next = [...list, incoming];
  } else {
    const merged = { ...list[idx] };
    for (const [key, value] of Object.entries(incoming)) {
      if (value !== undefined) merged[key] = value;
    }
    next = list.slice();
    next[idx] = merged;
  }

  return next
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-MAX_MESSAGES);
}