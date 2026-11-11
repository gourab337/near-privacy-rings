# Mainnet trusted setup (Groth16 phase 2)

**Phase 1** is the PSE Perpetual Powers of Tau, `ppot_0080_15.ptau` (80+ public
contributions). We checked it with `snarkjs powersoftau verify` ("Powers of Tau Ok!").

**Phase 2** is specific to `circuits/src/transaction2x2.circom`. The key is secure if **at
least one** contributor generated their randomness honestly and then destroyed it. After
the last contribution, a public random beacon (drand quicknet) is applied. The round is
announced here before it is produced, so no one can pick it.

## Contribute (about 30 seconds, needs Node and this repo)

```bash
git clone https://github.com/gourab337/near-privacy-rings && cd near-privacy-rings
cd circuits && npm ci && cd ..
./ceremony/contribute.sh tx2x2_000N.zkey tx2x2_000M.zkey "Your name"
```

Send `tx2x2_000M.zkey` back to the coordinator and post the printed contribution hash
publicly, for example in a GitHub issue. Before accepting a contribution, the coordinator
runs `./ceremony/verify.sh` on it, so the file's transport does not need to be trusted.

## Verify the final key yourself

```bash
./scripts/build-circuits.sh                       # compiles the circuit and fetches the ptau
./ceremony/verify.sh artifacts/mainnet/transaction2x2.zkey   # lists every contribution hash
```

Then check that `contract/src/vk.rs` was generated from `artifacts/mainnet/verification_key.json`
(its sha256 is in the file header), and that the deployed code hash matches a
reproducible build of this commit (`cargo near build reproducible-wasm`).

## Transcript

| # | Contributor | Contribution hash (first 16 bytes) |
|---|---|---|
| 0 | `groth16 setup` from ppot_0080_15 | (none: deterministic) |

Beacon: drand quicknet round **TBD** (announced before it is produced).
