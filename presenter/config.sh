# Shared settings for the presenter helper scripts (run from your laptop).
# Your VM details live in presenter/local.sh (gitignored); see local.example.sh.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/local.sh" ] && source "$here/local.sh"
: "${VM_HOST:?Set VM_HOST (e.g. root@203.0.113.10) in presenter/local.sh}"
VM_KEY="${VM_KEY:-$HOME/.ssh/id_ed25519}"
VM_DIR="${VM_DIR:-/root/who-authorized-that}"
DEMO_URL="http://localhost:7007/identity-boundary-demo"
CATALOG_URL="http://localhost:7007/catalog"

# Run a shell command inside the repo on the VM. Uses a TTY when we have one.
vm() {
  local tty=()
  [ -t 0 ] && tty=(-t)
  ssh -i "$VM_KEY" "${tty[@]}" -o LogLevel=ERROR "$VM_HOST" "cd $VM_DIR && $*"
}
