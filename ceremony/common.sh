# shared by the ceremony scripts
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
R1CS="$ROOT/circuits/build/transaction2x2.r1cs"
PTAU="$ROOT/circuits/ptau/ppot_0080_15.ptau"
SNARKJS="npx --prefix $ROOT/circuits snarkjs"
need_r1cs() { [ -f "$R1CS" ] || "$ROOT/scripts/build-circuits.sh"; }
