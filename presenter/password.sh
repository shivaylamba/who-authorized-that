#!/usr/bin/env bash
# Prints the sign-in for the presenter page (synthetic demo user, local Dex only).
set -euo pipefail
source "$(dirname "$0")/config.sh"
user="${1:-alice}"
key="DEMO_$(echo "$user" | tr 'a-z-' 'A-Z_')_PASSWORD"
echo "email:    $user@demo.example.com"
echo "password: $(vm "grep '^$key=' .env | cut -d= -f2-")"
