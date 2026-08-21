# Security fixes — pending items (from the audit)

Three of the four remaining audit items are prepared here as **review-before-apply**
artifacts. They are intentionally NOT wired into the drizzle migration chain
(`src/db/migrations`) — they change production data semantics and need a human
review + staging test first. The fourth item (SRI on the Tawk script) is already
implemented in `src/components/TawkProvider.tsx`.

| File | Fix | Risk | Needs |
|------|-----|------|-------|
| `DNS_AUDIT.md` | Dangling DNS records pointing at deleted Render/Vercel services | Low | Your DNS provider / dedyn.io console |
| `RLS_MIGRATION.sql` | Row Level Security + `SECURITY DEFINER` functions | **High** | App-side actor-context change + staging test |
| `UUID_MIGRATION.sql` | Serial → UUID primary keys (18 tables + FK children) | **High** | Staging test; verify no integer-id assumptions in app code |

**How to apply:**
- DNS: follow `DNS_AUDIT.md` — you need access to the DNS provider (I cannot delete records).
- SQL files: review, then run in a **transaction on a staging DB first**, then production.
  If you want them in the drizzle chain later, copy the reviewed SQL into
  `src/db/migrations/<next-number>_<name>.sql` AND add the matching entry to
  `src/db/migrations/meta/_journal.json` (or re-run `drizzle-kit generate` so the
  snapshot stays consistent) — hand-editing the journal is error-prone, so prefer
  `drizzle-kit generate` after updating `src/db/schema.ts`.
