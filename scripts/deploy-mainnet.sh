#!/usr/bin/env bash
# ./scripts/deploy-mainnet.sh <pool-account.near> <owner.near> [cap in NEAR, default 50]
# Refuses to deploy unless contract/src/vk.rs was generated from the ceremony key in
# artifacts/mainnet (the dev key has a single known contribution and is forgeable).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."
POOL=$1 OWNER=$2 CAP_NEAR=${3:-50}
VK=artifacts/mainnet/verification_key.json
[ -f "$VK" ] || { echo "✗ $VK missing: run the ceremony first (ceremony/README.md)"; exit 1; }
want=$(shasum -a 256 "$VK" | cut -d' ' -f1)
grep -q "from mainnet/verification_key.json" contract/src/vk_mainnet.rs || { echo "✗ contract/src/vk_mainnet.rs is not built from the mainnet key"; exit 1; }
grep -q "vkey sha256: $want" contract/src/vk_mainnet.rs || { echo "✗ contract/src/vk_mainnet.rs does not match $VK"; exit 1; }
echo "✓ verifying key is the ceremony key ($want)"

(cd contract && cargo near build non-reproducible-wasm --features mainnet)
WASM=contract/target/near/near_privacy_rings.wasm
CAP=$(python3 -c "print($CAP_NEAR * 10**24)")
net=(network-config mainnet sign-with-legacy-keychain send)
near contract deploy "$POOL" use-file "$WASM" with-init-call new json-args "{\"owner\":\"$OWNER\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${net[@]}"
for t in near wrap.near; do
  near contract call-function as-transaction "$POOL" set_token json-args "{\"token\":\"$t\",\"cap\":\"$CAP\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" "${net[@]}"
done
near contract call-function as-transaction wrap.near storage_deposit json-args "{\"account_id\":\"$POOL\"}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER" "${net[@]}"
echo "✓ deployed $POOL (owner $OWNER, cap $CAP_NEAR NEAR per token). Code hash:"
shasum -a 256 "$WASM"
