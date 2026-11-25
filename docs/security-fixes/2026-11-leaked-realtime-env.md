# Leaked `realtime-server/.env` — rotation and history purge

**Status:** open. The secret values must be rotated; the repository fix (file
removed from the working tree, `.gitignore` rule, `tests/secret-hygiene.test.mjs`)
is in place but does not un-leak anything.

## What leaked

`realtime-server/.env` was committed in `4ef30112` and `cb8b9731`, then removed
from tracking in `c9ee6dcf`. The removal does not remove it from:

- this repository's history (blob `56af4ce4b4a26643651971f437f2c69aa6c49911`),
- any clone, fork, backup, CI cache or GitHub-side dangling object,
- the working tree of anyone who pulled those commits.

Values that must be treated as compromised:

| Variable | What it grants |
| --- | --- |
| `CLERK_SECRET_KEY` | Full Clerk Backend API access: mint sessions for any user, read/modify users, bypass the app. |
| `REALTIME_INTERNAL_SECRET` | `x-internal-secret` on the realtime server's `/emit`, i.e. broadcast any event to any room (including `admin:notifications`). |
| `PORT`, `CLIENT_URL` | Not secret. |

## 1. Rotate (do this first — it is the actual fix)

1. **Clerk** → the instance that issued the key (`sk_test_…`) → *API keys* →
   roll the secret key. Update the server env (`env/app.env` / the realtime
   host's `realtime-server/.env`) and every deployment that uses it, then
   redeploy. Old key is dead the moment it is rolled.
2. **Realtime internal secret** — generate a new one and set it on **both**
   sides, which read the same variable:
   ```bash
   openssl rand -hex 32
   ```
   - realtime server: `REALTIME_INTERNAL_SECRET` in its env file;
   - Next.js: `REALTIME_INTERNAL_SECRET` in `env/app.env` (it is sent as
     `x-internal-secret` by `src/lib/adminNotify.ts` and the rooms store).
   Restart both. Until both sides match, admin live notifications and room
   `rooms:changed` pushes silently stop.
3. Recreate the local file from the placeholder (never from the old copy):
   ```bash
   cp realtime-server/.env.example realtime-server/.env
   # fill in the NEW values, keep it mode 600
   chmod 600 realtime-server/.env
   ```
4. Check CI/Vercel/host secrets for the same values and replace them there too.

## 2. Purge the history (after rotation)

The repository is `origin https://github.com/Hahuyphananh/GRYND.git`, branch
`solitaire-first`. This rewrites every commit id, so it must be coordinated:
every clone must be re-cloned (not pulled), and open PRs need re-targeting.

```bash
# one-time tool
pip install git-filter-repo

# from a FRESH clone, with no uncommitted work
git clone https://github.com/Hahuyphananh/GRYND.git grynd-purge
cd grynd-purge
git filter-repo --invert-paths --path realtime-server/.env --force

# verify the path is gone from every commit
git log --all --oneline -- realtime-server/.env   # expected: no output
git rev-list --all --objects | grep 'realtime-server/.env$' || echo "clean"

# publish the rewritten history
git push origin --force --all
git push origin --force --tags
```

After the force-push:

- delete and recreate any fork, or ask its owner to re-clone;
- GitHub keeps unreachable objects reachable through cached commit URLs for a
  while — open a support request to run `git gc --prune=now` on the repo if the
  secret must disappear immediately;
- anyone with an old clone still has the secret: rotation in step 1 is why that
  is acceptable.

## 3. Prevention (in place)

- `.gitignore`: `**/.env`, `**/.env.*`, with only `*.example` re-included.
- `tests/secret-hygiene.test.mjs` fails if a real env file is tracked, if a
  credential-shaped string (Stripe/Clerk-style secret, Resend key, AWS key id,
  PEM private key, Postgres URL with a real password) appears in a tracked
  file, or if the ignore rules regress.
- `realtime-server/.env` has been deleted from this working tree.

Run the guard with:

```bash
node --test tests/secret-hygiene.test.mjs
```
