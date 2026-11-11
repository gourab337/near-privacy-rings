// Shielded wallet: syncs notes from the pool contract and builds proven transactions.
// Transport-agnostic: `pool` needs only `view(method, args)`; built transactions are
// returned as { method, args, deposit } (or an ft_transfer_call spec) for any signer.
import { Buffer, Keypair, MerkleTree, Note, assetId } from './crypto.js';
import { buildProof } from './prover.js';

export const NATIVE = 'near';
/** Attached to every proof (leg) for the storage it adds; see contract STORAGE_FEE. */
export const STORAGE_FEE = 10n ** 22n; // 0.01 NEAR
/** Minimum NEAR fee of an open-ring (zero-deposit) transaction; see contract OPEN_MIN_FEE. */
export const OPEN_FEE = 2n * STORAGE_FEE;
const PAGE = 200;

export class ShieldedWallet {
  /**
   * @param {Keypair} keypair
   * @param {{ view: (method: string, args: object) => Promise<any>, contractId: string }} pool
   * @param {{ wasm: any, zkey: any }} artifacts
   */
  constructor(keypair, pool, artifacts) {
    this.keypair = keypair;
    this.pool = pool;
    this.artifacts = artifacts;
    this.tree = new MerkleTree();
    this.notes = []; // unspent owned notes (view-only wallets: every note ever received)
    this.expected = []; // notes a counterparty promised us (swaps): matched by commitment, not ciphertext
    this.synced = 0;
  }

  /** Fetch new leaves, trial-decrypt, then drop notes whose nullifier is on-chain. */
  async sync() {
    for (;;) {
      const leaves = await this.pool.view('get_leaves', { from_index: this.synced, limit: PAGE });
      for (const leaf of leaves) {
        const index = this.synced++;
        const cm = BigInt('0x' + leaf.commitment);
        this.tree.insert(cm);
        let note = Note.decrypt(this.keypair, Buffer.from(leaf.encrypted_output, 'base64'), index);
        // ignore ciphertexts that don't open to the committed note (spoofed or not ours)
        if (!(note && note.amount > 0n && note.commitment() === cm)) note = null;
        const ei = this.expected.findIndex((e) => e.commitment() === cm);
        if (ei >= 0) {
          note = this.expected[ei];
          note.index = index;
          this.expected.splice(ei, 1);
        }
        if (note) this.notes.push(note);
      }
      if (leaves.length < PAGE) break;
    }
    if (this.viewOnly) return this; // spent status needs the spending key
    const spent = await Promise.all(this.notes.map((n) => this.pool.view('is_spent', { nullifier: hex(n.nullifier()) })));
    this.notes = this.notes.filter((_, i) => !spent[i]);
    return this;
  }

  /** True for a wallet built from `Keypair.fromViewingKey`: it sees incoming notes, cannot spend. */
  get viewOnly() {
    return this.keypair.privKey === null;
  }

  balance(token) {
    const a = assetId(token);
    return this.notes.filter((n) => n.asset === a).reduce((s, n) => s + n.amount, 0n);
  }

  balances(tokens) {
    return Object.fromEntries(tokens.map((t) => [t, this.balance(t)]));
  }

  // ---------------------------------------------------------------- builders

  /**
   * Public -> shielded. Returns the calls to sign, in order.
   * Native NEAR: one `transact` (amount + storage fee). NEP-141: `prepay_storage`, then `ft_transfer_call`.
   */
  async deposit(token, amount) {
    amount = BigInt(amount);
    const asset = assetId(token);
    const out = new Note({ amount, keypair: this.keypair, asset });
    const { args, ext } = await this.#prove({ inputs: [], outputs: [out], asset, token, extAmount: amount });
    if (token === NATIVE) return [{ receiverId: this.pool.contractId, method: 'transact', args: { args, ext_data: ext }, deposit: amount + STORAGE_FEE }];
    return [
      { receiverId: this.pool.contractId, method: 'prepay_storage', args: {}, deposit: STORAGE_FEE },
      {
        receiverId: token,
        method: 'ft_transfer_call',
        args: { receiver_id: this.pool.contractId, amount: amount.toString(), msg: JSON.stringify({ args, ext_data: ext }) },
        deposit: 1n,
      },
    ];
  }

  /**
   * Shielded -> shielded. Asset and amount stay hidden unless a relayer fee is paid
   * (the fee reveals the asset). `relayer` set => anonymous ring (submit via relayer).
   */
  async transfer(token, amount, toAddress, { relayer = '', fee = 0n } = {}) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const asset = assetId(token);
    const to = Keypair.parseAddress(toAddress);
    const inputs = this.#select(asset, amount + fee);
    const change = sum(inputs) - amount - fee;
    const outputs = [
      new Note({ amount, pubKey: to.pubKey, asset, viewPk: to.viewPk }),
      new Note({ amount: change, keypair: this.keypair, asset }),
    ];
    outputs[0].viewPk = to.viewPk;
    const call = this.#tx(await this.#prove({ inputs, outputs, asset, token: fee > 0n ? token : '', relayer, fee }));
    // kept by the sender, never sent to the chain: lets them prove this one payment later
    call.receipt = encodeReceipt({ token, amount, to: toAddress, blinding: outputs[0].blinding });
    return call;
  }

  /** Shielded -> public account. Amount, asset and recipient are public. */
  async withdraw(token, amount, recipient, { relayer = '', fee = 0n } = {}) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const asset = assetId(token);
    const inputs = this.#select(asset, amount + fee);
    const outputs = [new Note({ amount: sum(inputs) - amount - fee, keypair: this.keypair, asset })];
    return this.#tx(await this.#prove({ inputs, outputs, asset, token, recipient, extAmount: -amount, relayer, fee }));
  }

  /** Merge two notes of `token` into one (keeps balances spendable in 2-input txs). */
  async merge(token, { relayer = '', fee = 0n } = {}) {
    fee = BigInt(fee);
    const asset = assetId(token);
    const inputs = this.notes.filter((n) => n.asset === asset).sort((a, b) => (a.amount < b.amount ? -1 : 1)).slice(0, 2);
    const outputs = [new Note({ amount: sum(inputs) - fee, keypair: this.keypair, asset })];
    return this.#tx(await this.#prove({ inputs, outputs, asset, token: fee > 0n ? token : '', relayer, fee }));
  }

  // ---------------------------------------------------------------- swap (P2P, atomic)

  /**
   * Maker: describe the note we want to receive. Share the returned offer with a taker.
   * `validUntil` (block height) bounds both legs, so neither side holds a free option.
   */
  createOffer(giveToken, giveAmount, wantToken, wantAmount, { validUntil }) {
    const want = new Note({ amount: BigInt(wantAmount), keypair: this.keypair, asset: assetId(wantToken) });
    this.pendingOffer = { want, giveToken, giveAmount: BigInt(giveAmount), validUntil: BigInt(validUntil) };
    this.expected.push(want);
    return {
      give: { token: giveToken, amount: String(giveAmount) },
      want: { token: wantToken, amount: String(wantAmount), blinding: want.blinding.toString() },
      makerAddress: this.keypair.address(),
      validUntil: String(validUntil),
    };
  }

  /** Taker: prove our leg (pay the maker exactly the note they asked for). */
  async takeOffer(offer) {
    const maker = Keypair.parseAddress(offer.makerAddress);
    const payAsset = assetId(offer.want.token);
    const pay = new Note({ amount: BigInt(offer.want.amount), pubKey: maker.pubKey, blinding: BigInt(offer.want.blinding), asset: payAsset });
    pay.viewPk = maker.viewPk;
    const receive = new Note({ amount: BigInt(offer.give.amount), keypair: this.keypair, asset: assetId(offer.give.token) });
    const inputs = this.#select(payAsset, pay.amount);
    const change = new Note({ amount: sum(inputs) - pay.amount, keypair: this.keypair, asset: payAsset });
    const leg = await this.#prove({ inputs, outputs: [pay, change], asset: payAsset, swapLeg: receive.commitment(), validUntil: BigInt(offer.validUntil) });
    this.expected.push(receive);
    return { leg, takerReceive: { amount: receive.amount.toString(), blinding: receive.blinding.toString(), address: this.keypair.address() } };
  }

  /** Maker: prove our leg against the taker's, and return the atomic `swap` call. */
  async completeOffer(takerResponse) {
    const { want, giveToken, giveAmount, validUntil } = this.pendingOffer;
    const taker = Keypair.parseAddress(takerResponse.takerReceive.address);
    const giveAsset = assetId(giveToken);
    const pay = new Note({ amount: giveAmount, pubKey: taker.pubKey, blinding: BigInt(takerResponse.takerReceive.blinding), asset: giveAsset });
    pay.viewPk = taker.viewPk;
    const inputs = this.#select(giveAsset, giveAmount);
    const change = new Note({ amount: sum(inputs) - giveAmount, keypair: this.keypair, asset: giveAsset });
    const mine = await this.#prove({ inputs, outputs: [pay, change], asset: giveAsset, swapLeg: want.commitment(), validUntil });
    return {
      receiverId: this.pool.contractId,
      method: 'swap',
      args: { leg_a: mine.args, ext_a: mine.ext, leg_b: takerResponse.leg.args, ext_b: takerResponse.leg.ext },
      deposit: 2n * STORAGE_FEE,
    };
  }

  // ---------------------------------------------------------------- internals

  #select(asset, needed) {
    const mine = this.notes.filter((n) => n.asset === asset).sort((a, b) => (a.amount > b.amount ? -1 : 1));
    const picked = mine.slice(0, 2);
    if (sum(picked) < needed) {
      throw new Error(
        mine.length > 2 && sum(mine) >= needed
          ? 'balance is split across more than 2 notes: run merge first'
          : 'insufficient shielded balance',
      );
    }
    return picked;
  }

  /** Serializable copy of expected notes, for apps to persist across reloads. */
  expectedState() {
    return this.expected.map((n) => ({ amount: n.amount.toString(), blinding: n.blinding.toString(), asset: n.asset.toString() }));
  }
  restoreExpected(state = []) {
    this.expected = state.map((e) => new Note({ amount: BigInt(e.amount), blinding: BigInt(e.blinding), asset: BigInt(e.asset), keypair: this.keypair }));
  }

  async #prove({ inputs, outputs, asset, token = '', recipient = '', extAmount = 0n, relayer = '', fee = 0n, swapLeg = 0n, validUntil = 0n }) {
    const pad = [...outputs];
    while (pad.length < 2) pad.push(new Note({ amount: 0n, keypair: this.keypair, asset }));
    const enc = pad.map((n) => n.encrypt(n.viewPk ?? this.keypair.view.publicKey));
    const ext = { recipient, extAmount, relayer, fee, encryptedOutput1: enc[0], encryptedOutput2: enc[1], token, swapLeg, validUntil };
    const moves = extAmount !== 0n || fee !== 0n;
    const r = await buildProof({ tree: this.tree, inputs, outputs: pad, asset, ext, publicAsset: moves ? asset : 0n, artifacts: this.artifacts, changeKeypair: this.keypair });
    return { args: r.args, ext: extToJson(ext) };
  }

  #tx({ args, ext }) {
    return { receiverId: this.pool.contractId, method: 'transact', args: { args, ext_data: ext }, deposit: STORAGE_FEE };
  }
}

// ---------------------------------------------------------------- payment receipts
// Selective disclosure of one payment: the opening of the note the sender created.
// Anyone holding it can check that the pool contains a note of exactly this token and
// amount for this address. Nothing else about the sender or recipient is revealed.

export function encodeReceipt({ token, amount, to, blinding }) {
  return 'nprreceipt' + Buffer.from(JSON.stringify({ token, amount: amount.toString(), to, blinding: blinding.toString() })).toString('base64url');
}

/** Returns { valid, index, token, amount, to }. `valid` means the note is in the pool at `index`. */
export async function verifyReceipt(pool, receipt) {
  if (!receipt.startsWith('nprreceipt')) throw new Error('invalid receipt');
  const r = JSON.parse(Buffer.from(receipt.slice(10), 'base64url').toString());
  const note = new Note({ amount: BigInt(r.amount), pubKey: Keypair.parseAddress(r.to).pubKey, blinding: BigInt(r.blinding), asset: assetId(r.token) });
  const cm = hex(note.commitment());
  for (let from = 0; ; from += PAGE) {
    const leaves = await pool.view('get_leaves', { from_index: from, limit: PAGE });
    const i = leaves.findIndex((l) => l.commitment === cm);
    if (i >= 0) return { valid: true, index: from + i, token: r.token, amount: BigInt(r.amount), to: r.to };
    if (leaves.length < PAGE) return { valid: false, index: -1, token: r.token, amount: BigInt(r.amount), to: r.to };
  }
}

export function extToJson(e) {
  return {
    recipient: e.recipient,
    ext_amount: e.extAmount.toString(),
    relayer: e.relayer,
    fee: e.fee.toString(),
    encrypted_output1: Buffer.from(e.encryptedOutput1).toString('base64'),
    encrypted_output2: Buffer.from(e.encryptedOutput2).toString('base64'),
    token: e.token,
    swap_leg: hex(e.swapLeg ?? 0n),
    valid_until: String(e.validUntil ?? 0n),
  };
}

const hex = (x) => BigInt(x).toString(16).padStart(64, '0');
const sum = (notes) => notes.reduce((s, n) => s + n.amount, 0n);
