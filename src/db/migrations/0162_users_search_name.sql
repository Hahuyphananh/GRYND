-- Friends search — make `users.search_name` a real folded match key.
--
-- `users.search_name` is meant to be the folded form of `users.name`
-- (lowercase, whitespace removed, accents folded) — the value
-- /api/friends/search compares a folded query against. In practice it holds a
-- raw copy of the display name: nothing ever wrote it on rename, so it went
-- stale the moment a player changed their username, and because it kept its
-- accents, an account like "Alexandre Thériault" was unreachable by anyone
-- searching "theriault" (the query is folded, the column was not).
--
-- Fold: lower → map the Latin-1 accented range → strip whitespace. Postgres
-- cannot fold accents without the `unaccent` extension (not installed here),
-- so the accented range is mapped explicitly. src/lib/searchName.ts
-- (remove-accents) is the source of truth for new writes and produces the same
-- key for every Latin-1 letter.
--
-- `name` is authoritative and `search_name` is a derived key, so every row
-- whose stored value is not already the fold of its name is rewritten — that
-- is what repairs both the accent misses and the renamed-account staleness.
-- Re-running is a no-op: the fold is deterministic, so already-folded rows
-- compare equal and are skipped.

ALTER TABLE users ADD COLUMN IF NOT EXISTS search_name varchar(255);

UPDATE users
   SET search_name = left(
         regexp_replace(
           translate(
             lower(name),
             'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
             'aaaaaaceeeeiiiinooooouuuuyy'
           ),
           '[[:space:]]+',
           '',
           'g'
         ),
         255
       )
 WHERE name IS NOT NULL
   AND search_name IS DISTINCT FROM left(
         regexp_replace(
           translate(
             lower(name),
             'àáâãäåçèéêëìíîïñòóôõöùúûüýÿ',
             'aaaaaaceeeeiiiinooooouuuuyy'
           ),
           '[[:space:]]+',
           '',
           'g'
         ),
         255
       );
