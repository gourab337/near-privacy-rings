#!/usr/bin/env bash
# Anyone: ./ceremony/verify.sh <zkey>
# Checks that the key belongs to this exact circuit and phase-1 file and lists every
# contribution hash in the chain.
source "$(dirname "$0")/common.sh"
need_r1cs
$SNARKJS zkey verify "$R1CS" "$PTAU" "$1"
