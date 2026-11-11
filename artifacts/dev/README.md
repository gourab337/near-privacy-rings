# Dev proving artifacts (testnet only)

Phase 2 of this key has a single throwaway contribution. Whoever made that contribution
could forge proofs, so these keys must never secure real funds. Mainnet uses
`artifacts/mainnet/`, which comes from the multi-party ceremony in `ceremony/`.

- `transaction2x2.wasm` is the witness generator, from `circuits/src/transaction2x2.circom`
- `transaction2x2.zkey` is the Groth16 proving key. Phase 1 is PSE Perpetual Powers of Tau `ppot_0080_15`
- `verification_key.json` is compiled into `contract/src/vk.rs` by `scripts/gen-vk.mjs`
