# Animated Emotes

Drop the 15 animated **Noto** emoji files here as **animated WebP** with the
exact lowercase filenames below. The game picker, emote bubbles, profile
Emotes manager, and Battle Pass rewards all resolve artwork from
`/emotes/<key>.webp` through the allow-listed catalog in
`src/lib/emoteAssets.ts` (mirrored by the `emotes` table seeded in
migration `0138_animated_emotes.sql`).

Missing files fail safely (a hidden/placeholder tile is shown instead of a
broken image), so you can ship the code before dropping the artwork.

## Expected files (15)

### FREE — owned + equipped by every user automatically
| key | file | Noto emoji |
| --- | --- | --- |
| `laugh` | `public/emotes/laugh.webp` | 😂 Laughing / Tears of Joy |
| `shock` | `public/emotes/shock.webp` | 😱 Shocked / Face Screaming |
| `cry` | `public/emotes/cry.webp` | 😭 Crying / Loudly Crying |
| `angry` | `public/emotes/angry.webp` | 😡 Angry |
| `love` | `public/emotes/love.webp` | 😍 Love Hearts / Smiling with Hearts |
| `cool` | `public/emotes/cool.webp` | 😎 Cool / Sunglasses |
| `wow` | `public/emotes/wow.webp` | 😮 Wow / Astonished |
| `fire` | `public/emotes/fire.webp` | 🔥 Fire |

### BATTLE PASS — granted at levels 6 / 13 / 22 / 31 / 42 / 56 / 81
| key | file | Unlock level |
| --- | --- | --- |
| `hype` | `public/emotes/hype.webp` | Battle Pass 6 |
| `victory` | `public/emotes/victory.webp` | Battle Pass 13 |
| `party` | `public/emotes/party.webp` | Battle Pass 22 |
| `skull` | `public/emotes/skull.webp` | Battle Pass 31 |
| `thumbsup` | `public/emotes/thumbsup.webp` | Battle Pass 42 |
| `clap` | `public/emotes/clap.webp` | Battle Pass 56 |
| `star` | `public/emotes/star.webp` | Battle Pass 81 |

> GG and NICE MOVE are permanent **text** system emotes — they are NOT part
> of the animated catalog and never need an asset here. The old
> `gg.svg` / `nice-move.svg` / `laugh.svg` / `cry.svg` / `fire.svg` /
> `wow.svg` files in this folder are unreferenced legacy leftovers and can be
> deleted once the WebP files are in place.

## Changing keys / filenames

If your downloaded files use different names, easiest path: rename the files
to match the table above. If you prefer different **keys**, update all of
these together (one row each):

1. `src/lib/emoteAssets.ts` → `OFFICIAL_EMOTE_DEFINITIONS` (and
   `FREE_EMOTE_KEYS` for the 8 free ones),
2. `src/db/migrations/0138_animated_emotes.sql` → the `emotes` INSERT + the
   `user_emotes` backfill + the `equipped_emotes` default (only needed if the
   migration has not run yet),
3. `src/lib/battlepassRewards.js` → the 7 `emote` reward rows,
4. For an already-applied database, remap rows:
   ```sql
   UPDATE emotes      SET key = 'new-key', asset_path = '/emotes/new-key.webp' WHERE key = 'old-key';
   UPDATE user_emotes SET emote_key = 'new-key' WHERE emote_key = 'old-key';
   -- users.equipped_emotes stores an ordered JSON array of keys; drop the old
   -- key from every array (the app also sanitizes unknown entries on read):
   UPDATE users
   SET equipped_emotes = (
     SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
     FROM jsonb_array_elements_text(equipped_emotes) WITH ORDINALITY AS t(elem, ord)
     WHERE elem <> 'old-key'
   )
   WHERE equipped_emotes @> '["old-key"]'::jsonb;
   ```
