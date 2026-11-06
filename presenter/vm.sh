#!/usr/bin/env bash
# Run any demo command on the VM, e.g.:  ./presenter/vm.sh demo:replay
set -euo pipefail
source "$(dirname "$0")/config.sh"
vm "yarn $*"
