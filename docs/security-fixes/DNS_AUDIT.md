# DNS audit — dangling records

The app previously ran on Vercel + Render (per `docs/PROD_REALTIME_AND_NEON_TASKS.md`)
and now runs on Replit (`grynd.dedyn.io`, see `.replit`). The old deployment
hostnames are still referenced in docs and **still resolve** (checked
2026-08-20), so any DNS record pointing at them is a candidate dangling record.

## Old hosts that still resolve

| Host | Resolved IP (sample) | Used for (per docs) |
|------|----------------------|---------------------|
| `casino-app-2wnk.onrender.com` | `216.24.57.15` | Socket.io realtime server (`NEXT_PUBLIC_SOCKET_URL`) |
| `casino-app-9ajh.onrender.com` | `216.24.57.15` | Older socket.io host (`/socket.io/` path in docs) |
| `casino-app-sandy.vercel.app` | `216.198.79.131` | Old web app host |

Resolving ≠ alive: Render/Vercel keep serving DNS (or reallocate the name) long
after the app is deleted. "Dangling" means the name no longer serves YOUR
service — delete the DNS record either way.

## Where to look

1. **dedyn.io console** — `grynd.dedyn.io` is a dedyn.io dynamic-DNS host.
   Log in and inspect every record; delete any that target the old hosts.
2. **DNS provider / registrar** — if a custom domain (e.g. `grynd.com`) has
   records, check the whole zone. Also check **subdomains** like `socket.`,
   `api.`, `www.`, `app.`.
3. **Env vars** — verify the running deployment no longer points at the old
   hosts: `NEXT_PUBLIC_SOCKET_URL`, `CLIENT_URL`, `SOCKET_URL`.

## Record types to hunt

- `CNAME` → any of the three old hosts (classic dangling)
- `A` / `AAAA` → stale IPs
- `SRV` → old socket endpoints

## Verify commands

```bash
# What does the zone actually point at?
dig +short grynd.dedyn.io
dig +short socket.grynd.dedyn.io
dig +short www.grynd.dedyn.io

# Does a record point at a deleted service? Check for 404/410 at the target:
curl -sI https://casino-app-2wnk.onrender.com/health | head -3   # expect non-200 if deleted
curl -sI https://casino-app-sandy.vercel.app/ | head -3

# After deleting records, confirm they no longer resolve:
dig +short casino-app-2wnk.onrender.com   # (the old host may still resolve itself —
                                          #  what matters is YOUR zone no longer references it)
```

## Definition of done

- No record in your zone (dedyn.io + registrar) references
  `casino-app-2wnk.onrender.com`, `casino-app-9ajh.onrender.com`, or
  `casino-app-sandy.vercel.app`.
- `NEXT_PUBLIC_SOCKET_URL` points at the current realtime deployment.
- `dig` for your subdomains returns only current, in-use targets.
