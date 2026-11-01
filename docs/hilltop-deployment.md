# HilltopAds banner — Oracle Cloud runbook

The banner is **disabled by default**. Deploying this code changes nothing a
visitor sees until the three switches below are opted in, and no provider code
is ever sent to a browser before that.

See `deploy/README.md` for the release layout itself; this file only covers the
HilltopAds-specific parts.

## 1. Where the configuration lives

All three runtime-deployable values go in the app's env file, which
`grynd-app.service` loads with `EnvironmentFile=`:

```
/home/ubuntu/grynd/env/app.env        (0600, outside releases/)
```

Editing that file requires a **service restart** (the unit reads it at start),
never a rebuild.

| Variable | Scope | Needs a rebuild? |
|---|---|---|
| `NEXT_PUBLIC_HILLTOP_BANNER_ENABLED` | **build-time** — `NEXT_PUBLIC_*` is inlined into the bundle | **Yes** |
| `NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL` | **build-time** (optional override) | **Yes** |
| `HILLTOP_BANNER_ENABLED` | server, read per request | No — restart only |
| `HILLTOP_BANNER_PROVIDER_ATTESTED` | server, read per request | No — restart only |

Everything is opt-in: only `true` or `1` turns a switch on. Any other value,
including an absent line, leaves the banner off.

## 2. Enabling it

Only after HilltopAds has confirmed **in writing** that the zone cannot enable
its `fullscreen`/`blur` modes, cannot force a popunder or top-window navigation
from a creative, and serves creatives in an iframe GRYND can keep out of
gameplay:

```bash
# 1. build with the build-time switch on
NEXT_PUBLIC_HILLTOP_BANNER_ENABLED=true npm run build

# 2. add the two server switches to the env file (chmod stays 600)
sudo -u grynd-deploy sh -c 'cat >> /home/ubuntu/grynd/env/app.env' <<'EOF'
HILLTOP_BANNER_ENABLED=true
HILLTOP_BANNER_PROVIDER_ATTESTED=true
EOF

# 3. restart the app through the operations path (not by hand)
node deploy/ops.mjs plan restart.app --actor=ops
node deploy/ops.mjs apply restart.app --token=<token> \
  --confirm "restart grynd-app.service" --actor=ops
```

The realtime unit does **not** need restarting: this feature ships no
`realtime-server` code.

### The CSP host

`src/proxy.ts` names `https://juvenilechoice.com` in `frame-src`, so the
creative's iframe is allowed once the banner is switched on. `frame-src` stays
an explicit per-host allow-list rather than `https:`: it is the directive that
also stops third parties from framing our own pages.

If a deploy ever ships a header without that host, the banner does not break the
page — it reserves its space, takes a `securitypolicyviolation`, and collapses
quietly instead of leaving a blank box.

## 3. Disabling it fast

Fastest, **no rebuild**, effective on the next request:

```bash
# set HILLTOP_BANNER_ENABLED=false (any value other than true/1 works)
sudo -u grynd-deploy sh -c \
  "sed -i 's/^HILLTOP_BANNER_ENABLED=.*/HILLTOP_BANNER_ENABLED=false/' \
   /home/ubuntu/grynd/env/app.env"
node deploy/ops.mjs plan restart.app --actor=ops     # then apply as above
```

The server gate returns `null` before any provider markup is written, so no
script, no container and no ad request reach a visitor after the restart.

If the restart path is unavailable, roll the release back instead — also no
rebuild:

```bash
node deploy/release.mjs status
node deploy/release.mjs rollback <previous-id> --confirm <previous-id> \
  --reason="hilltop banner behaviour"
```

Notes:

- A tab that already loaded the tag keeps its banner until it is reloaded; the
  switch stops new page loads.
- Clearing `NEXT_PUBLIC_HILLTOP_BANNER_SCRIPT_URL` or pointing it at anything
  other than `juvenilechoice.com` fails closed and renders nothing — that one
  does need a rebuild.

## 4. Post-deploy verification

```bash
# enabled: the four approved routes carry the container …
for p in / /games /classement /profil; do
  curl -s "https://<host>$p" | grep -c 'grynd-hilltop-banner' ; done

# … and a lobby, a board and a match never do
for p in /casino/uno /casino/chess/ai /casino/uno/game/x /settings; do
  curl -s "https://<host>$p" | grep -c 'grynd-hilltop-banner' ; done   # all 0

# a GRYND PRO session sees none of the four carry it either
```

A signed-out (free) request is the only case that should ever contain the
marker.

## 5. What this feature does NOT control

- The creative itself, inside a cross-origin iframe the loader creates with no
  `sandbox` attribute.
- The provider's per-zone `fullscreen`/`blur` modes.
- Impression frequency: the tag exposes no frequency setting, so GRYND's only
  lever is that it loads the tag at most once per browser session.
