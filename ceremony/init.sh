#!/usr/bin/env bash
# Coordinator: create contribution 0000 from the circuit and PSE Perpetual Powers of Tau.
source "$(dirname "$0")/common.sh"
need_r1cs
mkdir -p "$ROOT/ceremony/zkeys"
$SNARKJS groth16 setup "$R1CS" "$PTAU" "$ROOT/ceremony/zkeys/tx2x2_0000.zkey"
echo "created ceremony/zkeys/tx2x2_0000.zkey"
