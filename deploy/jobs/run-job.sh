#!/bin/sh
# deploy/jobs/run-job.sh
#
# Invoke ONE authenticated scheduled job on the app's loopback port.
#
# Installed as /usr/local/lib/grynd/run-job.sh (root-owned, so the service
# account cannot edit the thing that runs as it) and started by
# grynd-job@<name>.service, which the grynd-job-*.timer units trigger.
# This replaces Vercel Cron for the same routes; the endpoints, the CRON_SECRET
# bearer token and the schedules are unchanged.
#
# The secret is read from the same 0600 environment file the app uses
# (EnvironmentFile= for grynd-app.service) and handed to curl on **stdin** via
# `--config -`, so it never appears in a process argument list and never in the
# journal. Only the HTTP status and a bounded response excerpt are logged.
#
# Exit codes follow sysexits: 64 = usage (an unknown job name), 78 = config
# (missing/unreadable env file or CRON_SECRET), 1 = the job ran and failed.
set -eu

JOB="${1:-}"
case "$JOB" in
  daily-reset | weekly-reset | retention | rank-snapshots | last-run-sweep) ;;
  *)
    echo "usage: run-job.sh <daily-reset|weekly-reset|retention|rank-snapshots|last-run-sweep>" >&2
    exit 64
    ;;
esac

ENV_FILE="${GRYND_ENV_FILE:-/home/ubuntu/grynd/env/app.env}"
BASE_URL="${GRYND_JOB_BASE_URL:-http://127.0.0.1:3000}"
ATTEMPTS="${GRYND_JOB_ATTEMPTS:-3}"

[ -r "$ENV_FILE" ] || {
  echo "$JOB: cannot read $ENV_FILE" >&2
  exit 78
}

# `sed` rather than sourcing: the file is a systemd EnvironmentFile, not a shell
# script, and a value may contain characters a shell would reinterpret. Values
# are quoted there (EnvironmentFile strips the quotes), so strip them here too.
SECRET=$(
  sed -n 's/^CRON_SECRET=//p' "$ENV_FILE" |
    head -n 1 |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
)
[ -n "$SECRET" ] || {
  echo "$JOB: CRON_SECRET is not configured in $ENV_FILE; refusing to invoke it" >&2
  exit 78
}

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

attempt=1
while :; do
  # A deploy restarts the app, so a connection failure at the top of the hour is
  # expected occasionally and is worth retrying; an HTTP answer (even 401/500)
  # is not retried, because repeating a 500 does not make it succeed.
  code=$(
    printf 'url = "%s/api/jobs/%s"\nheader = "Authorization: Bearer %s"\nsilent\nmax-time = 120\n' \
      "$BASE_URL" "$JOB" "$SECRET" |
      curl --config - --output "$BODY" --write-out '%{http_code}' 2>/dev/null || true
  )
  [ -n "$code" ] || code=000

  case "$code" in
    200) break ;;
    000 | 502 | 503 | 504)
      if [ "$attempt" -ge "$ATTEMPTS" ]; then break; fi
      echo "$JOB: HTTP $code (attempt $attempt/$ATTEMPTS), retrying in 10s" >&2
      sleep 10
      attempt=$((attempt + 1))
      continue
      ;;
    *) break ;;
  esac
done

echo "$JOB: HTTP $code $(head -c 400 "$BODY" 2>/dev/null)"

[ "$code" = "200" ] || {
  echo "$JOB: failed with HTTP $code" >&2
  exit 1
}

# Every route reports its own success flag: `ok` from the two resets and the
# retention sweep, `success` from the snapshot pass. A 200 without it is not a
# success.
grep -Eq '"(ok|success)"[[:space:]]*:[[:space:]]*true' "$BODY" || {
  echo "$JOB: response did not report success" >&2
  exit 1
}
