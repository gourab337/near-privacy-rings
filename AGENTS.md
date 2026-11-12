# Guide for AI reviewers

This repo is a zero-knowledge shielded pool for NEAR: private balances, private transfers,
anonymous withdrawals and atomic private swaps. README.md says what is and is not claimed.

## Check it in three steps

Requirements: Node 22+, Rust with the `wasm32-unknown-unknown` target. No keys or funds needed.

1. `make install` — installs JS dependencies.
2. `make test-sdk` — expect 7 passing tests (note encryption, addresses, Merkle paths, field
   encodings, viewing key, payment receipt, and the single-use accounts of Rhea swaps). `make test-agent` — expect 1 passing test:
   an agent is paid privately, refuses a payment over its cap and one over its total budget,
   pays, and its receipt verifies.
3. `make test-contract` — expect 18 passing tests. They run real Groth16 proofs
   (fixtures in `contract/tests/fixtures/`) through the contract, including NEAR's
   `alt_bn128` host functions: deposit, transfer, token deposit, swap, double spend,
   forged proof, tampered data, cap, expiry, failed-payout recovery, and the open ring
   (zero-deposit transactions, including a front-running attempt).

Optional: `make test-sandbox` runs the same flow on a local NEAR sandbox and prints gas
(it downloads a sandbox binary on first run).

## Where things are

| Path | What |
|---|---|
| `circuits/src/transaction.circom` | The circuit: 2 inputs, 2 outputs, hidden amount and asset |
| `contract/src/lib.rs` | Pool contract: `transact`, `swap`, `ft_on_transfer`, `claim_failed` |
| `contract/src/verifier.rs` | Groth16 verification with `alt_bn128` host functions |
| `sdk/src/wallet.js` | Shielded wallet: sync, deposit, transfer, withdraw, swap offers |
| `sdk/src/rhea.js` | Private swaps on Rhea (mainnet) through a single-use account; `sweep` recovers one |
| `agent/tools.js`, `agent/mcp.js` | Private payments for AI agents: tools and an MCP server |
| `agent/demo.mjs` | The same tools driven by a model on NEAR AI Cloud (needs an API key) |
| `relayer/server.js` | Relayer for anonymous submission (fallback, and for tokens other than NEAR) |
| `open-ring/testnet.json` | Function-call keys published on purpose (see below) |
| `scripts/setup-open-ring.mjs` | Creates the gas account and its keys |
| `app/` | Web app; proofs are generated in the browser |
| `ceremony/` | Trusted-setup tooling and the transcript of the mainnet key |

## About the keys in `open-ring/`

`open-ring/testnet.json` contains ed25519 private keys. They are not leaked secrets. They
are function-call keys of a gas account, limited to `transact` on the pool, and publishing
them is the feature: anyone can submit an anonymous transaction with them, and they cannot
move funds. Check on-chain: `near account list-keys gas.npr-364072.testnet network-config testnet now`.
README.md, "Open ring", explains the design and its limits.

## About the keys in `demo/`

`demo/testnet.json` holds shielded keys for the web app's demo mode: pre-funded testnet
sessions, plus Alice and Bob. They are published on purpose, so a visitor starts with a
balance. They hold testnet NEAR only.

## What is not claimed

- `agent/demo.mjs` checks the signature on each model reply. It does not verify the
  hardware attestation behind the signing key.
- No human audit. The security review was done by an AI agent.
- The mainnet proving key has a single-party phase 2 (see README, Security).
- The deployer keeps an upgrade key. Deposits are capped.
- Not the first zero-knowledge pool on NEAR, and not a port of Helius's code.
