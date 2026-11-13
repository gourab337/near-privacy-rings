// Shielded wallet: syncs notes from the pool contract and builds proven transactions.
// Transport-agnostic: `pool` needs only `view(method, args)`; built transactions are
// returned as { method, args, deposit } (or an ft_transfer_call spec) for any signer.
import { Buffer, Keypair, MerkleTree, Note, assetId, encodeJson, decodeJson } from './crypto.ts';
import type { AnyKeypair, ExtData, Numeric } from './crypto.ts';
import { buildProof } from './prover.ts';
import type { ProofArgs, ProverArtifacts } from './prover.ts';

export const NATIVE = 'near';
/** Attached to every proof (leg) for the storage it adds; see contract STORAGE_FEE. */
export const STORAGE_FEE = 10n ** 22n; // 0.01 NEAR
/** Minimum NEAR fee of an open-ring (zero-deposit) transaction; see contract OPEN_MIN_FEE. */
export const OPEN_FEE = 2n * STORAGE_FEE;
const PAGE = 200;

/** What the wallet needs from the pool contract: its id and view calls. */
export interface PoolView {
  contractId: string;
  view(method: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** One leaf of the pool's tree, as `get_leaves` returns it. */
export interface Leaf {
  /** hex, 32 bytes */
  commitment: string;
  /** base64 */
  encrypted_output: string;
}

/** ExtData as JSON for the contract (see extToJson). */
export type ExtDataJson = {
  recipient: string;
  ext_amount: string;
  relayer: string;
  fee: string;
  encrypted_output1: string;
  encrypted_output2: string;
  token: string;
  swap_leg: string;
  valid_until: string;
};

/** A function call for any signer: `method(args)` on `receiverId`, attaching `deposit` yoctoNEAR. */
export type CallSpec<A extends Record<string, unknown> = Record<string, unknown>> = {
  receiverId: string;
  method: string;
  args: A;
  deposit: bigint;
  gas?: bigint;
};
/** Arguments of the pool's `transact`. */
export type TransactArgs = { args: ProofArgs; ext_data: ExtDataJson };
export type TransactCall = CallSpec<TransactArgs>;
/** A `transact` call with the sender's payment receipt (keep it; never sent to the chain). */
export type TransferCall = TransactCall & { receipt: string };
export type FtTransferCallArgs = { receiver_id: string; amount: string; msg: string };
/** Arguments of the pool's atomic `swap`. */
export type SwapArgs = { leg_a: ProofArgs; ext_a: ExtDataJson; leg_b: ProofArgs; ext_b: ExtDataJson };

/** Who submits: `relayer` is named in the proof as the payee of `fee`. */
export interface TxOptions {
  relayer?: string;
  fee?: Numeric;
}

/** See ShieldedWallet.depositMsg. */
export interface DepositMsg {
  msg: string;
  total: bigint;
  sendToken: string | null;
  receipt?: string;
}

/** A proven swap leg. */
export interface SwapLeg {
  args: ProofArgs;
  ext: ExtDataJson;
}
/** What a maker shares (createOffer). */
export interface SwapOffer {
  give: { token: string; amount: string };
  want: { token: string; amount: string; blinding: string };
  makerAddress: string;
  validUntil: string;
}
/** What the taker sends back (takeOffer). */
export interface TakerResponse {
  leg: SwapLeg;
  takerReceive: { amount: string; blinding: string; address: string };
}
/** The maker's open offer, kept until completeOffer. */
export interface PendingOffer {
  want: Note;
  giveToken: string;
  giveAmount: bigint;
  validUntil: bigint;
}
/** Serializable expected note (expectedState / restoreExpected). */
export interface ExpectedNoteState {
  amount: string;
  blinding: string;
  asset: string;
}

/** What verifyReceipt returns. */
export interface ReceiptCheck {
  valid: boolean;
  index: number;
  token: string;
  amount: bigint;
  to: string;
}

interface ProveParams {
  inputs: Note[];
  outputs: Note[];
  asset: bigint;
  token?: string;
  recipient?: string;
  extAmount?: bigint;
  relayer?: string;
  fee?: bigint;
  swapLeg?: bigint;
  validUntil?: bigint;
}

export class ShieldedWallet {
  declare keypair: AnyKeypair;
  declare pool: PoolView;
  declare artifacts: ProverArtifacts;
  declare tree: MerkleTree;
  declare notes: Note[];
  declare expected: Note[];
  declare synced: number;
  declare pendingOffer?: PendingOffer | null;
  /**
   * @param {Keypair} keypair
   * @param {{ view: (method: string, args: object) => Promise<any>, contractId: string }} pool
   * @param {{ wasm: any, zkey: any }} artifacts
   */
  constructor(keypair: AnyKeypair, pool: PoolView, artifacts: ProverArtifacts) {
    this.keypair = keypair;
    this.pool = pool;
    this.artifacts = artifacts;
    this.tree = new MerkleTree();
    this.notes = []; // unspent owned notes (view-only wallets: every note ever received)
    this.expected = []; // notes a counterparty promised us (swaps): matched by commitment, not ciphertext
    this.synced = 0;
  }

  /** Fetch new leaves, trial-decrypt, then drop notes whose nullifier is on-chain. */
  async sync(): Promise<this> {
    for (;;) {
      const leaves = (await this.pool.view('get_leaves', { from_index: this.synced, limit: PAGE })) as Leaf[];
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
  get viewOnly(): boolean {
    return this.keypair.privKey === null;
  }

  balance(token: string): bigint {
    const a = assetId(token);
    return this.notes.filter((n) => n.asset === a).reduce((s, n) => s + n.amount, 0n);
  }

  balances(tokens: string[]): Record<string, bigint> {
    return Object.fromEntries(tokens.map((t) => [t, this.balance(t)]));
  }

  // ---------------------------------------------------------------- builders

  /**
   * Public -> shielded. Returns the calls to sign, in order.
   * Native NEAR: one `transact` (amount + storage fee). NEP-141: `prepay_storage`, then `ft_transfer_call`.
   */
  async deposit(token: typeof NATIVE, amount: Numeric): Promise<[TransactCall]>;
  async deposit(token: string, amount: Numeric): Promise<[TransactCall] | [CallSpec<{}>, CallSpec<FtTransferCallArgs>]>;
  async deposit(token: string, amount: Numeric): Promise<[TransactCall] | [CallSpec<{}>, CallSpec<FtTransferCallArgs>]> {
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
   * A deposit that someone else delivers with `ft_transfer_call` (NEAR Intents, from any
   * chain): returns `{ msg, total, sendToken }` and, for another address, a `receipt`.
   * The notes go to this wallet, or to `toAddress` (a payment link).
   * NEAR: deliver `total` = amount + STORAGE_FEE as wNEAR; the pool keeps the fee, unwraps
   * the rest and creates native NEAR notes. Other tokens: deliver `total` = amount; the
   * sending account needs prepaid storage on the pool.
   */
  async depositMsg(token: string, amount: Numeric, toAddress?: string): Promise<DepositMsg> {
    amount = BigInt(amount);
    const asset = assetId(token);
    const to = toAddress ? Keypair.parseAddress(toAddress) : null;
    const out = to ? new Note({ amount, pubKey: to.pubKey, asset, viewPk: to.viewPk }) : new Note({ amount, keypair: this.keypair, asset });
    if (to) out.viewPk = to.viewPk;
    const { args, ext } = await this.#prove({ inputs: [], outputs: [out], asset, token, extAmount: amount });
    const native = token === NATIVE;
    const r: DepositMsg = { msg: native ? compactDepositMsg(args, ext) : JSON.stringify({ args, ext_data: ext }), total: native ? amount + STORAGE_FEE : amount, sendToken: native ? null : token };
    if (to) r.receipt = encodeReceipt({ token, amount, to: toAddress!, blinding: out.blinding });
    return r;
  }

  /**
   * Shielded -> shielded. Asset and amount stay hidden unless a relayer fee is paid
   * (the fee reveals the asset). `relayer` set => anonymous ring (submit via relayer).
   */
  async transfer(token: string, amount: Numeric, toAddress: string, { relayer = '', fee = 0n }: TxOptions = {}): Promise<TransferCall> {
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
    const call = this.#tx(await this.#prove({ inputs, outputs, asset, token: fee > 0n ? token : '', relayer, fee })) as TransferCall; // receipt set below
    // kept by the sender, never sent to the chain: lets them prove this one payment later
    call.receipt = encodeReceipt({ token, amount, to: toAddress, blinding: outputs[0].blinding });
    return call;
  }

  /** Shielded -> public account. Amount, asset and recipient are public. */
  async withdraw(token: string, amount: Numeric, recipient: string, { relayer = '', fee = 0n }: TxOptions = {}): Promise<TransactCall> {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const asset = assetId(token);
    const inputs = this.#select(asset, amount + fee);
    const outputs = [new Note({ amount: sum(inputs) - amount - fee, keypair: this.keypair, asset })];
    return this.#tx(await this.#prove({ inputs, outputs, asset, token, recipient, extAmount: -amount, relayer, fee }));
  }

  /** Merge two notes of `token` into one (keeps balances spendable in 2-input txs). */
  async merge(token: string, { relayer = '', fee = 0n }: TxOptions = {}): Promise<TransactCall> {
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
  createOffer(giveToken: string, giveAmount: Numeric, wantToken: string, wantAmount: Numeric, { validUntil }: { validUntil: Numeric }): SwapOffer {
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
  async takeOffer(offer: SwapOffer): Promise<TakerResponse> {
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
  async completeOffer(takerResponse: TakerResponse): Promise<CallSpec<SwapArgs>> {
    const { want, giveToken, giveAmount, validUntil } = this.pendingOffer!; // throws without an open offer
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

  #select(asset: bigint, needed: bigint): Note[] {
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
  expectedState(): ExpectedNoteState[] {
    return this.expected.map((n) => ({ amount: n.amount.toString(), blinding: n.blinding.toString(), asset: n.asset.toString() }));
  }
  restoreExpected(state: ExpectedNoteState[] = []): void {
    this.expected = state.map((e) => new Note({ amount: BigInt(e.amount), blinding: BigInt(e.blinding), asset: BigInt(e.asset), keypair: this.keypair }));
  }

  async #prove({ inputs, outputs, asset, token = '', recipient = '', extAmount = 0n, relayer = '', fee = 0n, swapLeg = 0n, validUntil = 0n }: ProveParams): Promise<SwapLeg> {
    const pad = [...outputs];
    while (pad.length < 2) pad.push(new Note({ amount: 0n, keypair: this.keypair, asset }));
    const enc = pad.map((n) => n.encrypt(n.viewPk ?? this.keypair.view.publicKey));
    const ext = { recipient, extAmount, relayer, fee, encryptedOutput1: enc[0], encryptedOutput2: enc[1], token, swapLeg, validUntil };
    const moves = extAmount !== 0n || fee !== 0n;
    const r = await buildProof({ tree: this.tree, inputs, outputs: pad, asset, ext, publicAsset: moves ? asset : 0n, artifacts: this.artifacts, changeKeypair: this.keypair });
    return { args: r.args, ext: extToJson(ext) };
  }

  #tx({ args, ext }: SwapLeg): TransactCall {
    return { receiverId: this.pool.contractId, method: 'transact', args: { args, ext_data: ext }, deposit: STORAGE_FEE };
  }
}

/**
 * The compact form of a native-NEAR deposit message (the pool's `decode_compact`): NEAR Intents
 * limits `msg` to 1024 characters. Fields the pool can derive (public amount and asset, ext-data
 * hash, and the empty recipient, relayer, fee and swap leg) are left out.
 */
function compactDepositMsg(args: ProofArgs, ext: ExtDataJson): string {
  const amount = BigInt(ext.ext_amount);
  const amt = Buffer.from(amount.toString(16).padStart(32, '0'), 'hex');
  const parts = [args.root, ...args.input_nullifiers, ...args.output_commitments].map((h) => Buffer.from(h, 'hex'));
  const bytes = Buffer.concat([...parts, Buffer.from(args.proof, 'base64'), amt, Buffer.from(ext.encrypted_output1, 'base64'), Buffer.from(ext.encrypted_output2, 'base64')]);
  return 'npr1:' + bytes.toString('base64');
}

// ---------------------------------------------------------------- payment receipts
// Selective disclosure of one payment: the opening of the note the sender created.
// Anyone holding it can check that the pool contains a note of exactly this token and
// amount for this address. Nothing else about the sender or recipient is revealed.

export function encodeReceipt({ token, amount, to, blinding }: { token: string; amount: Numeric; to: string; blinding: Numeric }): string {
  return 'nprreceipt' + encodeJson({ token, amount: amount.toString(), to, blinding: blinding.toString() });
}

/** Returns { valid, index, token, amount, to }. `valid` means the note is in the pool at `index`. */
export async function verifyReceipt(pool: PoolView, receipt: string): Promise<ReceiptCheck> {
  if (!receipt.startsWith('nprreceipt')) throw new Error('invalid receipt');
  const r = decodeJson<{ token: string; amount: string; to: string; blinding: string }>(receipt.slice(10));
  const note = new Note({ amount: BigInt(r.amount), pubKey: Keypair.parseAddress(r.to).pubKey, blinding: BigInt(r.blinding), asset: assetId(r.token) });
  const cm = hex(note.commitment());
  for (let from = 0; ; from += PAGE) {
    const leaves = (await pool.view('get_leaves', { from_index: from, limit: PAGE })) as Leaf[];
    const i = leaves.findIndex((l) => l.commitment === cm);
    if (i >= 0) return { valid: true, index: from + i, token: r.token, amount: BigInt(r.amount), to: r.to };
    if (leaves.length < PAGE) return { valid: false, index: -1, token: r.token, amount: BigInt(r.amount), to: r.to };
  }
}

export function extToJson(e: ExtData): ExtDataJson {
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

const hex = (x: Numeric): string => BigInt(x).toString(16).padStart(64, '0');
const sum = (notes: Note[]): bigint => notes.reduce((s, n) => s + n.amount, 0n);
