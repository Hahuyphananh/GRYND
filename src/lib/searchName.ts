// src/lib/searchName.ts
//
// The friends-search key.
//
// `users.search_name` is a DERIVED mirror of `users.name`, not a second
// display name: it holds the same username folded into a match key —
// lowercase, whitespace removed, accents folded. Every write to `users.name`
// must write the column through `searchNameFor()` so the two can never drift,
// and /api/friends/search folds the typed query with the same function before
// comparing.
//
// Why a stored column instead of folding in SQL: Postgres has no built-in
// accent folding — it needs the `unaccent` extension, which is not installed —
// so the fold happens here, once, on write, and the SQL side compares two
// already-folded values.

import removeAccents from "remove-accents";

/** `varchar("search_name", { length: 255 })` — keep the fold inside the column. */
export const SEARCH_NAME_MAX_LENGTH = 255;

/**
 * Fold a username (or a typed search query) into the search key stored in
 * `users.search_name`.
 *
 * Accents are folded FIRST: a decomposed "é" is "e" + a combining accent, and
 * the combining mark must be gone before whitespace is stripped, otherwise it
 * survives as a stray character in the middle of the key. Whitespace is
 * removed entirely so "John Smith", "john smith" and "johnsmith" all reduce to
 * the same key.
 */
export function searchNameFor(name: unknown): string {
  return removeAccents(String(name ?? ""))
    .toLowerCase()
    .replace(/\s+/g, "")
    .slice(0, SEARCH_NAME_MAX_LENGTH);
}
