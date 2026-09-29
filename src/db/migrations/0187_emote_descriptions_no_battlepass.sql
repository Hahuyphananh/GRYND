-- 0187: Rewrite the emote descriptions that still named a Battle Pass level.
--
-- Migration 0138 seeded descriptions like "Get hyped. Battle Pass Level 6
-- reward." for the seven non-free emotes. Those are user-visible — the profile
-- emote manager renders `description` straight from the catalog — and the pass
-- no longer exists (0185), so the copy had to go with it.
--
-- Text only, by `key`, so renames/parity with src/lib/emoteAssets.ts (the
-- client-safe mirror of this seed) stay in one place. Idempotent: a re-run
-- rewrites the same values.

UPDATE "emotes" SET "description" = 'Get hyped.'                      WHERE "key" = 'hype';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'You win.'                        WHERE "key" = 'victory';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'Let the party begin.'            WHERE "key" = 'party';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'Too soon.'                       WHERE "key" = 'skull';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'Respect.'                        WHERE "key" = 'thumbsup';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'Slow clap to standing ovation.'  WHERE "key" = 'clap';
--> statement-breakpoint

UPDATE "emotes" SET "description" = 'Legend status.'                  WHERE "key" = 'star';
