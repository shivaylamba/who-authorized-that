#!/usr/bin/env bash
# Puts the VM into the stage starting state. Run ~15 minutes before the talk.
#   ./presenter/prepare.sh            # logins + ungated profile + reset + doctor
#   ./presenter/prepare.sh --batch    # also records live-model batches (~4 min)
set -euo pipefail
source "$(dirname "$0")/config.sh"
echo "== Local services (Postgres, Dex)"
vm "docker compose --env-file .env up -d --wait >/dev/null 2>&1 && echo up"
echo "== Backend (gated) for logins"
vm "yarn demo:stop >/dev/null 2>&1; yarn demo:start:gated | tail -1"
echo "== Fresh logins (native Backstage OAuth via the CLI; tokens last 1 hour, refresh after)"
for u in alice bob mig42-agent; do
  vm "fuser -k 8055/tcp >/dev/null 2>&1; npx tsx scripts/login.ts $u | tail -1"
done
if [ "${1:-}" = "--batch" ]; then
  echo "== Live model batches (Reflection Beam on Nebius), gated then ungated"
  vm "yarn demo:live:batch 2>&1 | sed -n '/=== Batch/,/checkout-preview retired/p'"
  vm "yarn demo:stop >/dev/null; yarn demo:start:ungated | tail -1"
  vm "yarn demo:live:batch 2>&1 | sed -n '/=== Batch/,/checkout-preview retired/p'"
fi
echo "== Measurements for the 'Backstage today' tab (yarn demo:findings)"
vm "yarn demo:findings 2>&1 | grep -E '^F[0-9]' | cut -c1-110"
echo "== Starting state: UNGATED lab, fixtures reset"
vm "yarn demo:stop >/dev/null 2>&1; yarn demo:start:ungated | tail -1; yarn demo:reset --label stage-start | tail -1"
echo "== Doctor"
vm "yarn demo:doctor | grep -vE '^ OK   (node|yarn|backstage release|\.env)'"
echo
echo "Ready. Next: ./presenter/tunnel.sh (own tab), then open $DEMO_URL and sign in as alice (./presenter/password.sh alice)"
