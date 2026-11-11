#!/usr/bin/env bash
# Contributor: ./ceremony/contribute.sh <previous.zkey> <next.zkey> "<your name>"
# Mixes OS randomness with whatever you type. Your secret is never written to disk;
# the ceremony is safe if at least ONE contributor's randomness is gone for good.
source "$(dirname "$0")/common.sh"
[ $# -eq 3 ] || { echo "usage: $0 <previous.zkey> <next.zkey> \"<name>\""; exit 1; }
read -r -s -p "Type some random characters, then Enter: " typed; echo
entropy="$(head -c 64 /dev/urandom | xxd -p | tr -d '\n')$typed"
$SNARKJS zkey contribute "$1" "$2" --name="$3" -e="$entropy" | grep -A4 "Contribution Hash"
unset entropy typed
echo "wrote $2. Send it back to the coordinator and publish the contribution hash above."
