# Official Grynd Icons

This directory is the source of truth for **official GRYND cosmetic icon artwork**.

Users no longer upload profile pictures or provide avatar URLs. An avatar is an
official icon resolved purely by its catalog key (see `src/db/schema.ts` →
`icons` table and `src/lib/icons.ts`). The application renders only assets
referenced by the official catalog — never user-supplied media.

## Asset naming convention

An icon with catalog key `K` must be placed at:

```
/public/icons/K.webp
```

`src/lib/iconAssets.ts` resolves every icon to `/icons/<key>.webp` and enforces
a strict safe-key format so an attacker-supplied key can never produce an
arbitrary URL.

## The default icon

`default` → `/icons/default.webp` must exist in production. Every user owns and
is equipped with the default icon (granted on account creation and by migration
`0128`).

## Artwork status

Icon artwork is generated separately (ComfyUI-based development pipeline, **not**
part of the app's runtime). Until `default.webp` is produced, the app continues
to work: `src/components/IconAvatar.tsx` falls back to a letter avatar via its
`onError` handler when an asset file is missing. **No placeholder artwork should
be committed here** — add real artwork only when it is available.

## Adding an icon (architecture-ready, purchases not yet implemented)

1. Add the official asset at `/public/icons/<key>.webp`.
2. Insert a catalog row (`icons` table) via migration or admin tooling:
   `key`, `name`, `description`, `asset_path = '/icons/<key>.webp'`, `rarity`
   (`Common` / `Rare` / `Epic` / `Legendary` / `Limited` / `Grynd+`), optional
   `price_tokens` (reserved for the future shop), `enabled`, `is_default=false`,
   `sort_order`.
3. Optional: grant ownership (`user_icons`) — the future shop will do this.