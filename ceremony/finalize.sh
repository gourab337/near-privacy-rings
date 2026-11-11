#!/usr/bin/env bash
# Coordinator: ./ceremony/finalize.sh <last.zkey> <drand quicknet round>
# The round number must be published in ceremony/README.md BEFORE it is produced, so
# nobody (including the coordinator) can choose the beacon.
source "$(dirname "$0")/common.sh"
QUICKNET=52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971
beacon=$(curl -sSf "https://api.drand.sh/$QUICKNET/public/$2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["randomness"])')
echo "drand quicknet round $2 randomness: $beacon"
out="$ROOT/artifacts/mainnet"
mkdir -p "$out"
$SNARKJS zkey beacon "$1" "$out/transaction2x2.zkey" "$beacon" 10 -n="drand quicknet round $2"
$SNARKJS zkey verify "$R1CS" "$PTAU" "$out/transaction2x2.zkey" | tail -3
$SNARKJS zkey export verificationkey "$out/transaction2x2.zkey" "$out/verification_key.json"
cp "$ROOT/circuits/build/transaction2x2_js/transaction2x2.wasm" "$out/transaction2x2.wasm"
node "$ROOT/scripts/gen-vk.mjs" "$out/verification_key.json" "$ROOT/contract/src/vk.rs"
echo "mainnet artifacts in artifacts/mainnet; contract/src/vk.rs regenerated"
