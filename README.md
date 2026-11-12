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

**Try it:** https://gourab337.github.io/near-privacy-rings/ — opens on testnet with a
pre-funded demo wallet; no wallet or setup needed. Switch to **Mainnet** at the top right for
real NEAR and private swaps on Rhea. **Demo video (2 min, narrated):**
[`media/demo.mp4`](media/demo.mp4).

> **Status: live on NEAR mainnet** at [`rings.primeis.near`](https://nearblocks.io/address/rings.primeis.near),
> capped at about 50 NEAR's worth per token (NEAR, wNEAR, USDC, USDT, RHEA, ZEC, AURORA). **Unaudited**, with a single-party trusted setup:
> see [Security](#security) before you put in funds. First mainnet transactions: a
> [deposit](https://nearblocks.io/txns/2scAudWHbQxYGseswRQavy97ZMiHzvCvz1396rREtfsg), an anonymous
> [open-ring withdrawal](https://nearblocks.io/txns/FDViaBXjrYoYkPCBXqVpjSQdj1K47CqAut4NHFSeGx4u) signed with a
> published key, and private swaps on Rhea (see [below](#private-swaps-on-rhea)).

## What is private

| Action | Public on-chain | Hidden |
|---|---|---|
| Deposit | depositor account, token, amount | which note (and later spend) it becomes |
| Confidential transfer (you submit) | your account submitted *a* transaction | token, amount, recipient |
| Anonymous transfer / withdraw, open ring (NEAR; signed with a published key) | the shared gas account, a NEAR fee; for withdraw: recipient + amount | who spent, which notes |
| Anonymous transfer / withdraw, relayer (any listed token) | relayer account, fee and its token; for withdraw: recipient + amount | who spent, which notes |
| Private swap (peer to peer) | that *a* swap happened | both tokens, both amounts, both parties (when relayed) |
| Private swap on Rhea (mainnet) | a single-use account swapped token A for token B on Rhea, and both amounts | who swapped, which notes paid, which notes received |

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
Anonymous sends and withdrawals need no wallet connection; deposits use NEAR Wallet Selector.
Every form shows its fee and total before you submit. The Swap tab has two modes: Market
(private swaps on Rhea, mainnet) and Peer to peer (atomic swaps by offer code). The Prove tab
shows your viewing key and checks payment receipts. The network switcher (top right) keeps a
separate wallet per network.

## Try the demo

Open https://gourab337.github.io/near-privacy-rings/. Do this, and see that:

1. Choose **Try a demo wallet**: the page picks a pre-funded wallet (0.5 testnet NEAR). No
   NEAR wallet connection. (Or **Create private wallet** for your own key, encrypted in the
   browser with your password; then deposit testnet NEAR into it.)
2. **Send → Alice → 0.05 NEAR → Send privately.** About 8 seconds later the payment appears in
   the **Ring explorer**.
3. **Public** tab: the transaction read back from the chain. Sender, recipient and amount are
   hidden; it was signed by the shared gas account.
4. **Alice** tab: the page decrypts the payment with Alice's key, as her wallet would. She sees
   0.05 NEAR, and cannot tell who sent it.
5. **Withdraw → Bob → 0.05 NEAR.** The Public tab now shows Bob's account and the amount, but
   not whose balance paid.
6. **Prove** tab: paste the receipt from step 2 (in the explorer's **You** tab) and check it.

The demo keys (sessions, Alice, Bob) are published on purpose in
[`demo/testnet.json`](demo/testnet.json), seeded by `scripts/seed-demo.mjs`. They hold
testnet NEAR only, and anyone can spend them. There is no mainnet demo wallet.

**Your own wallet** is a private key kept in the browser, encrypted with AES-256-GCM under a
key derived from your password (PBKDF2-SHA256, 600,000 iterations). While unlocked, the plain
key is in the tab's session storage, which the browser clears when the tab closes. Showing
the key asks for the password again. On mainnet, a new wallet shows its key once and asks you to
confirm you saved it; "Restore from a saved key" brings it back in any browser. Without the
key, a forgotten password or cleared browser data loses the balance.

## Open ring: anonymity without a relayer

Helius's design on Solana needs a relayer for anonymity: somebody's account has to sign
and pay for the transaction, so a third party does it for a fee. That party must be online,
and it can refuse you. On Solana a fee-paying key can spend everything its account holds,
so it cannot be shared. (Ethereum can get close with ERC-4337 paymasters, which still rely
on bundlers.)

NEAR accounts can hold *function-call keys*: keys that may call only named methods on one
contract and can never transfer or attach funds. The open ring uses them like this:

1. A gas account (`gas.primeis.near` on mainnet, `gas.npr-364072.testnet` on testnet) holds
   a little NEAR and eight function-call keys limited to `transact` on the pool.
2. **The private halves of those keys are published** in [`open-ring/`](open-ring/):
   [`mainnet.json`](open-ring/mainnet.json) and [`testnet.json`](open-ring/testnet.json).
   That is intended. Anyone can sign with them; nobody can do anything with them except
   submit a proof to the pool.
3. Your browser signs the anonymous transaction with one of those keys and sends it
   straight to an RPC node. Everyone who does this looks the same on-chain.
4. The transaction carries no deposit, so the contract takes its 0.01 NEAR storage fee out
   of the proof's public fee (at least 0.02 NEAR) and pays the rest to the gas account.
   A transaction burns about 0.0068 NEAR of gas, so the gas account refills itself: on
   mainnet it started with 0.3 NEAR and went up after each use.
5. The proof names the gas account as the fee's payee, and the contract only accepts a
   zero-deposit transaction from the account it names. So nobody can copy a pending
   transaction, submit it first and take the fee. (An earlier version paid whoever
   submitted; an adversarial review found that front-running hole, and
   `open_ring_cannot_be_front_run` now tests for it.)

What this does not solve, stated plainly:

- **Spam can switch it off.** Anyone can sign failing transactions with the published keys
  and burn the gas account's balance, at no cost to themselves. This cannot touch the pool:
  the gas account is a separate account and holds only gas money. NEAR also requires it to
  hold 0.001 NEAR per Tgas of gas limit to send (0.1 NEAR for our 100 Tgas limit, refunded),
  so it stops below that. Anyone can top it up; meanwhile a relayer or your own account can
  still submit.
- **Shared keys collide.** Each key has one transaction counter. Two people using the same
  key in the same second collide, and one retries with another key; a spammer can cause
  this on purpose.
- **NEAR notes only.** The fee has to be NEAR, because gas is paid in NEAR. Other tokens need
  a relayer (none runs on mainnet yet), or a private swap back to NEAR on Rhea first.
- **Not a new primitive.** NEAR linkdrops already share restricted keys. This applies the
  same account feature to shielded-pool anonymity.
- **Your RPC node still sees your IP address**, as a relayer would.
- **Spam still costs nothing to send.** The front-running fix stops anyone profiting, not
  anyone wasting the gas account's balance.

## Private swaps on Rhea

The Swap tab swaps NEAR privately for USDC, USDT, RHEA, ZEC or AURORA, and back, against
[Rhea](https://app.rhea.finance)'s liquidity on `v2.ref-finance.near`: for each token, its
deepest wNEAR pool (#4512, #6063, #6458, #6065 and #5469). The pool contract cannot call Rhea itself,
so a single-use account does it, all from the browser:

1. The open ring withdraws NEAR from your notes to a fresh implicit account (no relayer).
2. That account swaps on Rhea. The price comes from Rhea's contract (`get_return`), with a
   0.5% slippage limit.
3. It deposits the result back into the pool as a note for you, and any spare NEAR as
   another note. Then it deletes itself; its last gas money goes to the open ring's gas account.

It needs no contract change and no server: each token is listed with `set_token`, like any
NEP-141, and the token logos come from each token's on-chain metadata.
Tested on mainnet both ways: 0.3 NEAR to 1.076461 USDC
([funding](https://nearblocks.io/txns/FFzsGU6wPG9QqWveQFMRWzsH3hEqSLPq3ztk4zZ9bfU2),
[swap](https://nearblocks.io/txns/8QauC74j2WsyWog761LP5rMeJ1c4MSGLeAbfQoBbTu2C)), and back to 0.2982 NEAR
([funding](https://nearblocks.io/txns/AaqZXsysX3kb3cms6kHQzu1kUbhD2des5MBNeefj8Ebh),
[swap](https://nearblocks.io/txns/q1QxuCyeYvzw8EdzsstUu7s1sK982EgPC8NauFBM9a9)).
Also round trips through USDT (0.3 NEAR to 1.062065 USDT, [swap](https://nearblocks.io/txns/5xGgioAKzu9rdLUauLTLEy95yQUYuqxjrZAw9WSo253V))
and ZEC (0.3 NEAR to 0.00108222 ZEC, [swap](https://nearblocks.io/txns/6C1qyEuAEfhKfKSCUbB7Qqf6ihJQYh4GHjUikfHaGrrE), and back
to 0.3003 NEAR, [swap](https://nearblocks.io/txns/Aih2sJRE5C4jVm1zNxNxtEtxre2bWhjV2WuK5nQ4n4wb)).
Code: [`sdk/src/rhea.js`](sdk/src/rhea.js).

Limits:

- **Amounts are public**, as on any AMM, and the steps of one swap are visibly linked to each
  other (not to you). A distinctive amount right after your deposit can still give you away.
- **About 0.14 NEAR per swap**: the open-ring fee (0.02), the pool's storage fees, token
  registrations, gas, and about 0.07 NEAR of gas money the single-use account must hold to
  send its last transaction (NEAR requires an account to hold 0.001 NEAR per Tgas of gas
  limit). That last part tops up the shared gas account. Worth it for a few NEAR or more.
- **Your browser keeps the swap's random index until it completes.** If the tab closes
  mid-swap, the funds wait in the single-use account and the app offers "Recover". If this
  browser's data is also lost in those seconds, the funds cannot be found automatically.
  The index is random so that restoring your key elsewhere never reuses an account and
  links two of your swaps.
- **Public RPC rate limits.** A swap makes about 30 RPC calls. The free endpoint can
  rate-limit a burst; the SDK backs off and retries, and an interrupted swap is finished
  with "Recover". In testing, one sweep was cut off this way and recovered.
- **Stablecoins can be frozen by their issuers.** Circle (USDC) and Tether (USDT) can
  blacklist accounts, including the pool. ZEC and AURORA are bridged tokens and depend on
  their bridges.
- Mainnet only (Rhea's liquidity is there). Each swap is NEAR to a token or back, through
  one pool; no token-to-token routes yet.

## Private payments for AI agents

An AI agent that pays for things on a public chain shows everyone what it buys, from whom
and for how much. Giving it a normal account also means giving it gas and a key that can
spend everything.

[`agent/`](agent/) gives an agent a shielded balance instead. Because of the open ring, the
agent needs **no NEAR account, no gas and no relayer**: its only secret is a shielded key.

- **MCP server** (`agent/mcp.js`): works with any MCP client. Tools: `shielded_address`,
  `shielded_balance`, `private_send`, `private_withdraw`, `verify_receipt`.
- **Spending limits outside the model**: `NPR_MAX_PAYMENT` (per payment) and `NPR_MAX_TOTAL`
  (everything the process spends, fees included) are enforced by the tool code. A confused
  or prompt-injected model can still make bad payments within those limits, but cannot go
  past them. The total resets when the process restarts.
- **Receipts**: every `private_send` returns a receipt the agent can hand to the payee or an
  auditor (see Disclosure below).
- **NEAR AI Cloud demo** (`agent/demo.mjs`): a model hosted in a TEE on NEAR AI Cloud drives
  the tools, and the script checks NEAR AI Cloud's signature over each model reply.
  It does not verify the hardware attestation behind that signature.

```bash
# as an MCP server (testnet; the shielded key is created in agent/.agent-key on first run)
NPR_MAX_PAYMENT=0.05 node agent/mcp.js
# driven by a NEAR AI Cloud model
NEAR_AI_API_KEY=... node agent/demo.mjs "What is your shielded address and balance?"
```

A real run of `agent/demo.mjs` on testnet with the model `z-ai/glm-5.3-flash` on NEAR AI
Cloud, given the task "A data seller sent this invoice: 0.01 NEAR to npr2fdc…. Pay it
privately, then check the receipt":

```text
[model reply b6bdc47f…] signed by provider_tee key 5a0210f2442c7935… over these exact bytes
[tool] shielded_balance({}) -> {"near":"0.050000","fee_per_payment_near":"0.020000","max_per_payment_near":"0.05"}
[model reply df9da8b1…] signed by provider_tee key 5a0210f2442c7935… over these exact bytes
[tool] private_send({"amount_near":"0.01","to":"npr2fdc…"}) -> {"tx":"GNK1kVmVD1YMU6kwRQWg42QnvNjUsCVrjg9CiuGU6UB8", …}
[model reply e2246bef…] signed by provider_tee key 5a0210f2442c7935… over these exact bytes
[tool] verify_receipt({"receipt":"nprreceipt…"}) -> {"valid":true, …}
I privately paid the seller's shielded address 0.01 NEAR plus a 0.02 NEAR privacy fee.
The returned receipt verifies as valid on-chain.
```

The payment is [this transaction](https://testnet.nearblocks.io/txns/GNK1kVmVD1YMU6kwRQWg42QnvNjUsCVrjg9CiuGU6UB8):
signed by the shared gas account, with no trace of the agent. `provider_tee` is NEAR AI
Cloud's label for a reply signed by the model's serving key; the script checked each
signature against the exact request and response bytes. It did not verify the hardware
attestation that ties that key to a TEE, so the check shows the replies are consistent with
one signing key, not that a TEE produced them.

Also tested on testnet through an MCP client: the agent was paid 0.1 NEAR privately, refused a
0.06 NEAR payment (cap 0.05), paid 0.03 NEAR privately
([transaction](https://testnet.nearblocks.io/txns/EK6ZJeV3EHhidxM6ccnuN43JtHRKLHbxCYZQZrzssYGc)),
and its receipt verified. Payments are NEAR only, since the open ring is.

## Disclosure: private by default, provable on request

- **Viewing key** (`Keypair.viewingKey()`, starts with `nprview`). Hand it to an auditor and
  they can decrypt every note you receive: deposits, payments and your own change. It
  cannot spend. Limit: it cannot tell which notes you later spent, because nullifiers need
  the spending key. A full viewing key needs a circuit change (see Roadmap).
- **Payment receipt** (starts with `nprreceipt`). The sender of a private payment keeps the
  opening of the note they created. Anyone given the receipt can check against the chain
  (`verifyReceipt`) that a note of exactly that token and amount exists for that shielded
  address. It reveals that one payment and nothing else. It does not say who paid, so
  whoever holds it can present it; treat it as proof that the payment happened.
- Viewing keys cannot be revoked. Once shared, the holder can read every future note to
  that address until you move to a new key.

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
  last 1000 roots, records nullifiers, appends commitments and stores ciphertexts for
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
- **Small anonymity set.** Privacy comes from the crowd. With few users, a deposit and a
  later withdrawal can be linked by timing and amount. Wait, and use common amounts.
- **Your RPC provider can link your notes.** The wallet asks the RPC whether each of your
  notes is spent, so the provider can tie your notes to your IP address before you spend
  them. Use your own node or Tor for strong privacy.
- **Browser key storage.** The web app keeps your shielded key in this site's local
  storage, encrypted with your password. GitHub Pages sites under one account
  (`gourab337.github.io`) share that storage, so another page there could copy the ciphertext
  and try to guess a weak password offline. Use a strong password and back the key up; a
  build served from its own domain avoids this.
- **Storage fee margin.** Each proof adds about 900 bytes (0.009 NEAR at current prices)
  and pays 0.01 NEAR. If storage costs rose above the fee, new transactions would fail
  until the pool account is topped up.
- **Token issuer controls.** Circle (USDC) and Tether (USDT) can freeze tokens held by any
  account, including the pool; bridged tokens (ZEC, AURORA) depend on their bridges. NEAR and
  wNEAR notes are unaffected.
- **Upgradeability.** The owner can list tokens, set caps and pause. It cannot move user
  notes. The deployer account keeps its key, so it can redeploy the contract. That is
  disclosed here rather than hidden. Deposits are capped.

## Roadmap

Not done for the hackathon, and needed before this holds meaningful value:

1. **Multi-party trusted setup.** Replace the single-party mainnet key with a public
   ceremony. The scripts and runbook are in [`ceremony/`](ceremony/README.md).
2. **Immutable pool.** Remove the deployer's upgrade key and make pause stop deposits only,
   so nobody can change the contract or block withdrawals.
3. **Independent audit** of the circuit and the contract.
4. **Full viewing keys.** A separate nullifier key in the circuit, so an auditor can see
   spends as well as receipts; and auditor-bound rings like Helius's policy rings.
5. **Open ring hardening.** Several gas accounts, and NEAR's newer gas keys, to reduce
   spam and key collisions. Fees in tokens other than NEAR.
6. **An indexer**, so wallets do not scan every leaf.
7. **Rhea swaps inside the contract**, settling the swap and the new note in one transaction,
   to drop the single-use account and most of its 0.14 NEAR cost.

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
  the MCP TypeScript SDK, tweetnacl, noble-hashes and noble-curves, Vite, Geist fonts,
  Phosphor icons, Simple Icons (NEAR mark). Private swaps route through Rhea's
  `v2.ref-finance.near` pools; token logos are read from each token's on-chain metadata. The note and nullifier scheme follows Tornado Cash Nova.
  The product shape follows Helius's Solana Privacy Rings; no Helius code is used.
  Phase 1 of the trusted setup is the PSE Perpetual Powers of Tau.
- **Earlier work on NEAR:** hideyour.cash (Opact) deployed a Groth16 mixer on NEAR around 2023.
  This project does not claim to be the first zero-knowledge pool on NEAR.

## License

Apache-2.0
