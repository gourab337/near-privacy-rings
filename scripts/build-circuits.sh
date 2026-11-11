#!/usr/bin/env bash
# Compiles the circuit and checks that it matches the committed artifacts.
# A fresh key setup is NOT done here: keys come from the ceremony (ceremony/README.md).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd "$(dirname "$0")/../circuits"
[ -d node_modules ] || npm ci --silent
mkdir -p build
circom src/transaction2x2.circom --r1cs --wasm -o build >/dev/null
echo "circuit compiled: $(snarkjs r1cs info build/transaction2x2.r1cs 2>/dev/null | grep -E '# of Constraints' | sed 's/.*Constraints: //') constraints"
mkdir -p ptau
PTAU=ptau/ppot_0080_15.ptau
[ -f "$PTAU" ] || curl -sSfL -o "$PTAU" https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_15.ptau
for set in dev mainnet; do
  z=../artifacts/$set/transaction2x2.zkey
  [ -f "$z" ] || continue
  # proves the committed proving key belongs to this exact circuit + phase-1 file
  snarkjs zkey verify build/transaction2x2.r1cs "$PTAU" "$z" | grep -q "ZKey Ok" && echo "artifacts/$set: zkey matches circuit ✓"
done
