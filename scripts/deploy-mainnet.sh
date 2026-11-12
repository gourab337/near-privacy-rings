#!/usr/bin/env bash
# ./scripts/deploy-mainnet.sh <pool-account.near> <owner.near> [cap in NEAR, default 50]
# Creates <pool> (a subaccount of <owner>, funded with 4 NEAR) if it does not exist, deploys,
# lists NEAR and wNEAR, and sets up the open ring's gas account gas.<owner> with 0.3 NEAR.
# NPR_NET=testnet runs the same steps on testnet, as a rehearsal.
# Refuses to deploy unless contract/src/vk.rs was generated from the ceremony key in
# artifacts/mainnet (the dev key has a single known contribution and is forgeable).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/.."
POOL=$1 OWNER=$2 CAP_NEAR=${3:-50}
NET=${NPR_NET:-mainnet}
WRAP=$([ "$NET" = mainnet ] && echo wrap.near || echo wrap.testnet)
VK=artifacts/mainnet/verification_key.json
[ -f "$VK" ] || { echo "✗ $VK missing: run the ceremony first (ceremony/README.md)"; exit 1; }
want=$(shasum -a 256 "$VK" | cut -d' ' -f1)
grep -q "from mainnet/verification_key.json" contract/src/vk_mainnet.rs || { echo "✗ contract/src/vk_mainnet.rs is not built from the mainnet key"; exit 1; }
grep -q "vkey sha256: $want" contract/src/vk_mainnet.rs || { echo "✗ contract/src/vk_mainnet.rs does not match $VK"; exit 1; }
echo "✓ verifying key is the ceremony key ($want)"

(cd contract && cargo near build non-reproducible-wasm --features mainnet)
WASM=contract/target/near/near_privacy_rings.wasm
CAP=$(python3 -c "print($CAP_NEAR * 10**24)")
net=(network-config "$NET" sign-with-legacy-keychain send)
if ! near account view-account-summary "$POOL" network-config "$NET" now >/dev/null 2>&1; then
  near account create-account fund-myself "$POOL" '4 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER" "${net[@]}"
fi
near contract deploy "$POOL" use-file "$WASM" with-init-call new json-args "{\"owner\":\"$OWNER\"}" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${net[@]}"
for t in near "$WRAP"; do
  near contract call-function as-transaction "$POOL" set_token json-args "{\"token\":\"$t\",\"cap\":\"$CAP\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" "${net[@]}"
done
near contract call-function as-transaction "$WRAP" storage_deposit json-args "{\"account_id\":\"$POOL\"}" prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as "$OWNER" "${net[@]}"
node scripts/setup-open-ring.mjs "$NET" "$POOL" "gas.$OWNER" "$OWNER" 0.3 8
echo "✓ deployed $POOL on $NET (owner $OWNER, cap $CAP_NEAR NEAR per token). Code hash:"
shasum -a 256 "$WASM"
echo "Next: commit open-ring/$NET.json, then set the repo variables NPR_NETWORK=$NET and NPR_CONTRACT=$POOL and re-run the pages workflow."
