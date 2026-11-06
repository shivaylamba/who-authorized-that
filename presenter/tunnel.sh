#!/usr/bin/env bash
# Opens the SSH tunnel: http://localhost:7007 (Backstage) and :5556 (Dex sign-in).
# Leave this running in its own terminal tab for the whole talk.
set -euo pipefail
source "$(dirname "$0")/config.sh"
for port in 7007 5556; do
  if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use on this laptop (an old tunnel?). Close it first:"
    lsof -nP -iTCP:$port -sTCP:LISTEN
    exit 1
  fi
done
echo "Tunnel open: $DEMO_URL  (Ctrl+C to close)"
exec ssh -i "$VM_KEY" -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -L 7007:127.0.0.1:7007 -L 5556:127.0.0.1:5556 "$VM_HOST"
