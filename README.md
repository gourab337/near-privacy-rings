# NEAR Privacy Rings

A zero-knowledge shielded pool for NEAR. You can hold NEAR and NEP-141 tokens in
encrypted balances, send them privately, withdraw them anonymously, and swap two tokens
atomically without revealing either side. Anonymous NEAR transactions need **no relayer**:
they are signed with a key that is published in this repo (see [Open ring](#open-ring-anonymity-without-a-relayer)). Every state change is
proven with Groth16 and verified on-chain by NEAR's `alt_bn128` host functions.
No trusted hardware or permissioned validators are involved.

It is inspired by Helius's [Solana Privacy Rings](https://github.com/helius-labs/zolana)
(launched on Solana mainnet on 2026-11-10). This repo is an independent NEAR implementation.
It is not a port of their code.

> **Status:** working end-to-end on NEAR testnet. **Unaudited.** Mainnet deployment
> is pending, with low deposit caps. See [Security](#security) before you put in funds.

## What is private

| Action | Public on-chain | Hidden |
|---|---|---|
| Deposit | depositor account, token, amount | which note (and later spend) it becomes |
| Confidential transfer (you submit) | your account submitted *a* transaction | token, amount, recipient |
| Anonymous transfer / withdraw, open ring (NEAR; signed with a published key) | the shared gas account, a NEAR fee; for withdraw: recipient + amount | who spent, which notes |
| Anonymous transfer / withdraw, relayer (any listed token) | relayer account, fee and its token; for withdraw: recipient + amount | who spent, which notes |
| Private swap | that *a* swap happened | both tokens, both amounts, both parties (when relayed) |

## Try it

```bash
make install      # JS deps
make test         # SDK tests, contract unit tests with real proofs, sandbox e2e with gas
```

Testnet demo: deposit → confidential transfer → anonymous withdraw (relayer) → anonymous
withdraw (open ring, no relayer) → wNEAR deposit → private swap.

```bash
# relayer (terminal 1)
NPR_CONTRACT=npr-pool-65673.testnet RELAYER_ACCOUNT_ID=<relayer>.testnet \
RELAYER_PRIVATE_KEY=ed25519:... node relayer/server.js
# demo (terminal 2): keys from ~/.near-credentials/testnet/
NPR_CONTRACT=npr-pool-65673.testnet ALICE=<a>.testnet BOB=<b>.testnet \
RELAYER_URL=http://localhost:8787 node scripts/e2e.mjs
```

Measured gas: deposit and transfer about 63 Tgas, private swap about 123 Tgas
(the per-transaction limit is 300 Tgas). Every proof also pays a 0.01 NEAR storage fee
for the two leaves and two nullifiers it adds.

Web app: `cd app && npm ci && npm run dev`. Proofs are generated in the browser; a full
anonymous withdraw through the open ring, proof included, took about 7 s in our headless test.
Anonymous sends and withdrawals need no wallet connection. Deposits and the confidential
ring use NEAR Wallet Selector.

## Open ring: anonymity without a relayer

Helius's design, like every shielded pool on Solana or Ethereum, needs a relayer for
anonymity: somebody's account has to sign and pay for the transaction, so a third party
does it for a fee. That party must be online, and it can refuse you.

NEAR accounts can hold *function-call keys*: keys that may call only named methods on one
contract and can never transfer or attach funds. The open ring uses them like this:

1. A gas account (`gas.npr-364072.testnet` on testnet) holds a little NEAR and eight
   function-call keys limited to `transact` on the pool.
2. **The private halves of those keys are published** in [`open-ring/`](open-ring/testnet.json).
   That is intended. Anyone can sign with them; nobody can do anything with them except
   submit a proof to the pool.
3. Your browser signs the anonymous transaction with one of those keys and sends it
   straight to an RPC node. Everyone who does this looks the same on-chain.
4. The transaction carries no deposit, so the contract takes its 0.01 NEAR storage fee out
   of the proof's public fee (at least 0.02 NEAR) and pays the rest to the account that
   paid the gas. A transaction burns about 0.0068 NEAR of gas, so the gas account refills
   itself: in our testnet runs its balance went up after each use.

Because the contract pays whoever submitted, anyone can also relay for the fee with their
own account. No permission or registration is involved.

What this does not solve, stated plainly:

- **Spam can switch it off.** Anyone can sign failing transactions with the published keys
  and burn the gas account's balance, at no cost to themselves. This cannot touch the pool:
  the gas account is a separate account and holds only gas money. While it is empty, use
  the relayer or the confidential ring.
- **Shared keys collide.** Each key has one transaction counter. Two people using the same
  key in the same second collide, and one retries with another key; a spammer can cause
  this on purpose.
- **NEAR notes only.** The fee has to be NEAR, because gas is paid in NEAR. Other tokens and
  swaps still use the relayer.
- **Not a new primitive.** NEAR linkdrops already share restricted keys. This applies the
  same account feature to shielded-pool anonymity.
- **Your RPC node still sees your IP address**, as a relayer would.

## How it works

- **Notes.** `commitment = Poseidon(amount, pubKey, blinding, asset)` and
  `nullifier = Poseidon(commitment, leafIndex, Poseidon(privKey, commitment, leafIndex))`.
  This is the audited Tornado Cash Nova scheme, extended with a hidden per-note `asset`.
- **Circuit** (`circuits/src/transaction.circom`). It has 2 inputs and 2 outputs, a
  depth-20 Poseidon Merkle tree and about 27.6k constraints. All notes in a transaction
  share one private asset. `publicAsset` is 0 for hidden transfers. When value enters or
  leaves the pool, the contract forces `publicAsset` to the token's id, and the circuit
  forces every note to match it.
- **Contract** (`contract/`). It verifies the proof, checks that the root is among the
  last 100 roots, records nullifiers, appends commitments and stores ciphertexts for
  wallet sync. NEAR is paid out via transfer, NEP-141 tokens via `ft_transfer`. A failed
  payout is credited to the recipient, who can claim it (`claim_failed`). A `transact`
  sent with no deposit is an open-ring transaction (see above).
- **Swap.** Two ordinary transaction proofs settle in one call. Each commits, through
  `swap_leg`, to the exact note it must receive from the other, so neither half can be
  executed alone.
- **Wallet sync.** Each output is encrypted to the recipient's X25519 viewing key.
  Wallets page through `get_leaves` and trial-decrypt.

## Security

- **Unaudited.** The circuit follows Tornado Nova's design, but this code has not been reviewed by a third party.
- **Trusted setup.** Phase 1 is the PSE Perpetual Powers of Tau (80+ contributors; checked
  with `snarkjs powersoftau verify`). **Phase 2 of the mainnet key is single-party:** one
  contribution by the deployer, followed by a drand beacon. Anyone holding that contribution's
  randomness could forge proofs, so you must trust the deployer. The deposit caps exist for
  this reason. Production will replace this key with a multi-party ceremony; the tooling and
  runbook are in [`ceremony/`](ceremony/README.md). `artifacts/dev` (testnet) has one
  throwaway contribution.
- **Upgradeability.** The owner can list tokens, set caps and pause. It cannot move user
  notes. The deployer account keeps its key, so it can redeploy the contract. That is
  disclosed here rather than hidden. Deposits are capped.

## Hackathon disclosures

Built for [NEAR HACKATHON](https://nearhackathon.com) (tracks: `privacy`, `defi`, `open`).

- **Other submission by the same person (rule Q-015):**
  [near-intents-freeze-thesis](https://github.com/gourab337/near-intents-freeze-thesis),
  an investment-thesis entry. The two projects are independent and share no code.
- **Baseline (Q-001, Q-003):** none. Every commit in this repo was made inside the hackathon window.
- **AI-written code (Q-005):** most of the code was written with Claude Code, directed and
  reviewed by the author. The security review mentioned below was also done by an AI agent.
  No human auditor has reviewed this code.
- **Libraries and prior designs (Q-005):** circom and circomlib (Poseidon, Merkle gadgets),
  snarkjs, near-sdk, arkworks (`ark-bn254`, `ark-ff`), near-api-js, NEAR Wallet Selector,
  tweetnacl, noble-hashes, Vite. The note and nullifier scheme follows Tornado Cash Nova.
  The product shape follows Helius's Solana Privacy Rings; no Helius code is used.
  Phase 1 of the trusted setup is the PSE Perpetual Powers of Tau.
- **Earlier work on NEAR:** hideyour.cash (Opact) deployed a Groth16 mixer on NEAR around 2023.
  This project does not claim to be the first zero-knowledge pool on NEAR.

## License

Apache-2.0
