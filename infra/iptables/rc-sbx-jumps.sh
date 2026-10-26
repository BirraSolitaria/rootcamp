#!/usr/bin/env bash
# rootcamp: inserts the jumps into the RC-SBX-* chains (rc-sbx.rules, rc-sbx6.rules) exactly once.
# Run by rc-sbx-firewall.service (ExecStartPost) after iptables-restore has created the chains.
# Idempotent: `-C` first, `-I <chain> 1` only when the jump is missing. The INPUT jump has to sit
# above ufw's chains (ufw accepts ssh from anywhere), hence position 1.
set -euo pipefail

BRIDGE=rc-sbx0
SUBNET=172.30.0.0/24

ensure_jump() {
  local bin=$1 chain=$2
  shift 2
  if ! "$bin" -C "$chain" "$@" 2>/dev/null; then
    "$bin" -I "$chain" 1 "$@"
  fi
}

ensure_jump /usr/sbin/iptables INPUT -i "$BRIDGE" -j RC-SBX-INPUT
ensure_jump /usr/sbin/iptables DOCKER-USER -s "$SUBNET" -j RC-SBX-FORWARD
ensure_jump /usr/sbin/iptables DOCKER-USER -o "$BRIDGE" -j RC-SBX-FORWARD
ensure_jump /usr/sbin/iptables DOCKER-USER -i "$BRIDGE" -j RC-SBX-FORWARD

ensure_jump /usr/sbin/ip6tables INPUT -i "$BRIDGE" -j RC-SBX-INPUT
ensure_jump /usr/sbin/ip6tables DOCKER-USER -o "$BRIDGE" -j RC-SBX-FORWARD
ensure_jump /usr/sbin/ip6tables DOCKER-USER -i "$BRIDGE" -j RC-SBX-FORWARD
