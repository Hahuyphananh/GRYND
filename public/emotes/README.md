# Emote pins

GRYND's in-match emotes. Fifteen animated **WebP** files, resolved through the
allow-listed catalog in `src/lib/emoteAssets.ts` (mirrored by the `emotes` table
seeded in migration `0138_animated_emotes.sql`), and drawn by the shared emote
layer in `src/components/game/emotes/`:

| Surface | File |
| --- | --- |
| Quick bar (one-tap pins) | `EmoteBar.tsx` |
| Full set + emote controls | `EmoteWheel.tsx` |
| Speech bubble | `EmoteBubble.tsx` |
| Artwork renderer (allow-listed) | `EmoteArtwork.tsx` |
| Per-match mount | `GameEmoteLayer.tsx` |

Missing or disabled files fail safely — the artwork is hidden instead of
showing a broken image — so code can ship before the art does.

## Budget (please keep it)

The UI draws a pin at **24–40 px** (bar, bubble, wheel) and at most ~84 px on the
profile page. The catalog is therefore shipped small on purpose:

| Rule | Value |
| --- | --- |
| Canvas | **128 × 128 px** (`fit: inside`, never upscaled past 2× the biggest draw) |
| Per file | **≤ 60 KB** |
| Whole catalog | **≤ 900 KB** |
| Frames | 12–26 · the compactor thins to ≤10 fps and keeps the loop seamless |

```bash
node scripts/compact-emote-assets.mjs            # re-encode in place
node scripts/compact-emote-assets.mjs --dry-run  # report before/after only
```

The script keeps each file's frames and name and only caps the canvas/quality,
so it is safe to run after dropping in new artwork. A first frame that reads on
its own matters: bubbles can pop before the animation has advanced.

## Art direction — brand pins, not stock emoji

Aim for a **die-cut sticker** that reads as GRYND at a glance:

- **Background:** none (transparent). The bubble/bar supplies the navy chip
  (`#071531`).
- **Rim:** a cyan edge light (`#00e5ff`) so the pin reads on dark surfaces;
  gold (`#FFD700`) reserved for win/premium moments.
- **Shape:** one strong silhouette, one focal feature; no text, no numerals.
- **Motion:** the reaction must be legible in the first 150 ms.
- **Never:** third-party characters, watermarks, photographic realism, or
  Unicode-emoji artwork copied from another set — see
  `docs/GRYND_ICON_SPEC.md` §11/§14 for the full avoid list.

## Files (15)

Every pin is owned by every player; there is no unlock track.

| key | file |
| --- | --- |
| `laugh` | `public/emotes/laugh.webp` |
| `shock` | `public/emotes/shock.webp` |
| `cry` | `public/emotes/cry.webp` |
| `angry` | `public/emotes/angry.webp` |
| `love` | `public/emotes/love.webp` |
| `cool` | `public/emotes/cool.webp` |
| `wow` | `public/emotes/wow.webp` |
| `fire` | `public/emotes/fire.webp` |
| `hype` | `public/emotes/hype.webp` |
| `victory` | `public/emotes/victory.webp` |
| `party` | `public/emotes/party.webp` |
| `skull` | `public/emotes/skull.webp` |
| `thumbsup` | `public/emotes/thumbsup.webp` |
| `clap` | `public/emotes/clap.webp` |
| `star` | `public/emotes/star.webp` |

**GG** and **NICE MOVE** are permanent *text* emotes (`PERMANENT_TEXT_EMOTES` in
`src/components/game/emotes/useEmoteLoadout.ts`). They are not part of the
catalog and need no file here.

The old unreferenced `gg.svg` / `nice-move.svg` / `laugh.svg` / `cry.svg` /
`fire.svg` leftovers have been deleted.

## Adding a new pin

1. Drop `public/emotes/<key>.webp` (lowercase key, ≤60 KB).
2. Add the key to `OFFICIAL_EMOTE_DEFINITIONS` in `src/lib/emoteAssets.ts`.
3. Add it to `EMOTE_CATALOG_KEYS` in `realtime-server/server.js` — the server
   allow-lists emote keys, so a pin the server does not know is dropped.
4. Seed the `emotes` row (a new migration; do not edit `0138` once applied) and
   grant it, otherwise the picker will not offer it.

## Renaming a key

Keep these in sync:

1. `src/lib/emoteAssets.ts` → `OFFICIAL_EMOTE_DEFINITIONS` (+ `FREE_EMOTE_KEYS`
   for the original eight).
2. `realtime-server/server.js` → `EMOTE_CATALOG_KEYS`.
3. For an already-migrated database:

   ```sql
   UPDATE emotes      SET key = 'new-key', asset_path = '/emotes/new-key.webp' WHERE key = 'old-key';
   UPDATE user_emotes SET emote_key = 'new-key' WHERE emote_key = 'old-key';
   -- users.equipped_emotes is an ordered JSON array; unknown entries are also
   -- sanitized on read, so a stale key degrades to "not equipped".
   UPDATE users
   SET equipped_emotes = (
     SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
     FROM jsonb_array_elements_text(equipped_emotes) WITH ORDINALITY AS t(elem, ord)
     WHERE elem <> 'old-key'
   )
   WHERE equipped_emotes @> '["old-key"]'::jsonb;
   ```
