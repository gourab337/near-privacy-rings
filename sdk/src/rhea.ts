// Private swaps through Rhea (v2.ref-finance.near) on NEAR mainnet.
//
// The pool cannot call Rhea itself, so a single-use "hop" account does it:
//  1. the open ring withdraws NEAR from the user's notes to the hop, a fresh implicit account
//     (no relayer; the hop is not linked to the user's deposits),
//  2. the hop swaps on Rhea,
//  3. `sweep` deposits whatever the hop holds back into the pool as notes for the user, then
//     deletes the hop, whose leftover NEAR goes to the open ring's gas account.
// The hop's key is derived from the user's shielded key and a random index, so an interrupted
// swap can be finished with `sweep` as long as the index is kept (the app keeps it until the swap
// completes). The index must be random: reusing one would link two swaps to the same user.
// Swap amounts are public, as on any AMM; who swapped is not.
import { ed25519 } from '@noble/curves/ed25519.js';
import { actions, baseEncode } from 'near-api-js';
import type { Account, KeyPairString, Provider } from 'near-api-js';
import { Buffer, sha256, toBytes32BE } from './crypto.ts';
import type { AnyKeypair, Numeric } from './crypto.ts';
import { OPEN_FEE, STORAGE_FEE } from './wallet.ts';
import type { ShieldedWallet, TransactCall } from './wallet.ts';
import { retry, sendOpen, signerAccount, withMerge } from './near.ts';
import type { OpenRing, TxOutcome } from './near.ts';

export interface RheaToken {
  symbol: string;
  decimals: number;
  /** Rhea pool id of the token's wNEAR pair */
  pool: number;
}
export interface RheaConfig {
  exchange: string;
  wrap: string;
  /** by token contract id */
  tokens: Record<string, RheaToken>;
  usdc: string;
}
/** A hop account: implicit account id (hex public key) and its "ed25519:…" secret key. */
export interface HopKey {
  accountId: string;
  secretKey: KeyPairString;
}
/** A function call signed by the hop. */
type HopCall = { method: string; args: Record<string, unknown>; gas?: bigint; deposit?: bigint };

export interface SweepParams {
  wallet: ShieldedWallet;
  provider: Provider;
  open: OpenRing;
  hopIndex: number;
  onStep?: (step: string) => void;
}
export interface PrivateSwapParams extends SweepParams {
  /** 'near' or a token id of RHEA.tokens */
  from: string;
  to: string;
  amountIn: Numeric;
  /** minimum output (see minOut) */
  limit: Numeric;
}
export interface PrivateSwapResult {
  /** the hop's account id */
  hop: string;
  hashes: string[];
}

export const RHEA = {
  exchange: 'v2.ref-finance.near',
  wrap: 'wrap.near',
  // tokens swappable against NEAR, each through its deepest wNEAR pool on Rhea (all listed on the pool)
  tokens: {
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': { symbol: 'USDC', decimals: 6, pool: 4512 },
    'usdt.tether-token.near': { symbol: 'USDT', decimals: 6, pool: 6063 },
    'token.rhealab.near': { symbol: 'RHEA', decimals: 18, pool: 6458 },
    'zec.omft.near': { symbol: 'ZEC', decimals: 8, pool: 6065 },
    'aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near': { symbol: 'AURORA', decimals: 18, pool: 5469 },
  },
} as Omit<RheaConfig, 'usdc'> as RheaConfig; // usdc is set on the next line
RHEA.usdc = Object.keys(RHEA.tokens)[0];
/** The Rhea pool of a NEAR <-> token pair. */
const poolOf = (from: string, to: string): number => RHEA.tokens[from === 'near' ? to : from]?.pool ?? (() => { throw new Error('unsupported pair'); })();
const TGAS = 10n ** 12n;
// Gas limits, measured on mainnet with margin. To send a transaction an account must hold
// 0.001 NEAR per Tgas of limit (10x the burn price; the unused part is refunded).
const GAS = { reg: 20n * TGAS, wrap: 10n * TGAS, swap: 100n * TGAS, ftDeposit: 130n * TGAS, deposit: 85n * TGAS, withdraw: 100n * TGAS };
const hold = (gas: bigint): bigint => gas * 10n ** 9n;
/**
 * NEAR sent to the hop besides the swap amount: registrations, the pool's storage fee and the
 * gas it must hold. Most of it comes back as a NEAR note when the hop is swept.
 */
export const HOP_GAS_MONEY = 17n * 10n ** 22n; // 0.17 NEAR
export const SLIPPAGE_BPS = 50n; // 0.5%

/** A fresh random hop index (31 bits). */
export const newHopIndex = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

/** The hop account of a shielded keypair for index n: { accountId, secretKey }. */
export function hopKey(keypair: AnyKeypair, n: number): HopKey {
  const i = Buffer.alloc(4);
  i.writeUInt32BE(n);
  const seed = sha256(Buffer.concat([Buffer.from('npr-rhea-hop'), toBytes32BE(keypair.privKey as bigint), i])); // a view-only keypair (null) throws here
  const pub = ed25519.getPublicKey(new Uint8Array(seed));
  return { accountId: Buffer.from(pub).toString('hex'), secretKey: ('ed25519:' + baseEncode(Buffer.concat([seed, Buffer.from(pub)]))) as KeyPairString };
}

const ftId = (t: string): string => (t === 'near' ? RHEA.wrap : t);
const view = (provider: Provider, contractId: string, method: string, args: Record<string, unknown> = {}) => retry(() => provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } }));

/** Rhea's on-chain quote for `amountIn` of `from` ('near' or a token id) into `to`. */
export async function quote(provider: Provider, from: string, to: string, amountIn: Numeric): Promise<bigint> {
  return BigInt((await view(provider, RHEA.exchange, 'get_return', { pool_id: poolOf(from, to), token_in: ftId(from), amount_in: BigInt(amountIn).toString(), token_out: ftId(to) })) as string);
}
export const minOut = (q: bigint): bigint => (q * (10_000n - SLIPPAGE_BPS)) / 10_000n;

async function nearBalance(provider: Provider, accountId: string): Promise<{ amount: bigint; storage: bigint } | null> {
  try {
    const a = await retry(() => provider.viewAccount({ accountId, blockQuery: { finality: 'final' } }));
    return { amount: BigInt(a.amount), storage: BigInt(a.storage_usage) * 10n ** 19n };
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCOUNT/i.test(String((e as Error | undefined)?.message ?? e))) return null;
    throw e;
  }
}
const ftBalance = async (provider: Provider, token: string, accountId: string): Promise<bigint> => BigInt((await view(provider, token, 'ft_balance_of', { account_id: accountId })) as string);
const register = async (provider: Provider, token: string, accountId: string): Promise<HopCall> => ({
  method: 'storage_deposit',
  args: { account_id: accountId, registration_only: true },
  gas: GAS.reg,
  deposit: BigInt(((await view(provider, token, 'storage_balance_bounds')) as { min: string }).min),
});

async function waitFor(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 1500))) if (await check()) return;
  throw new Error(`timed out waiting for ${what}`);
}

/** Signs one transaction of function calls from the hop; throws if any receipt failed. */
async function hopTx(acct: Account, receiverId: string, calls: HopCall[]): Promise<string> {
  const res = await retry(() => acct.signAndSendTransaction({
    receiverId,
    actions: calls.map((c) => actions.functionCall(c.method, c.args, c.gas ?? 30n * TGAS, c.deposit ?? 0n)),
    waitUntil: 'FINAL',
  }));
  const failed = [(res as TxOutcome).status, ...((res as TxOutcome).receipts_outcome ?? []).map((r) => r.outcome.status)].find((s) => s?.Failure);
  if (failed) throw new Error(`${calls.map((c) => c.method).join('+')} failed: ${JSON.stringify(failed.Failure)}`);
  return res.transaction.hash;
}

/**
 * Swaps `amountIn` of `from` for `to` ('near' or RHEA.usdc) privately, through hop number `hopIndex`.
 * `limit` is the minimum output (see `minOut`). Runs `sweep` at the end, also after a failure,
 * so funds always return to the user's private balance. Returns { hop, hashes }.
 */
export async function privateSwap({ wallet, provider, open, from, to, amountIn, limit, hopIndex, onStep = () => {} }: PrivateSwapParams): Promise<PrivateSwapResult> {
  amountIn = BigInt(amountIn);
  const hop = hopKey(wallet.keypair, hopIndex);
  const acct = signerAccount(hop.accountId, hop.secretKey, provider);
  const hashes: string[] = [];
  const fund = async (amount: bigint) => {
    onStep('Funding a single-use account through the open ring');
    const opts = { relayer: open.account, fee: OPEN_FEE };
    const submit = (c: TransactCall) => sendOpen(provider, open, c);
    const call = await withMerge(wallet, 'near', opts, submit, () => wallet.withdraw('near', amount, hop.accountId, opts), { onMerge: () => onStep('Merging notes first') });
    hashes.push(await submit(call));
    await waitFor(async () => ((await nearBalance(provider, hop.accountId))?.amount as bigint) >= amount, 'the single-use account'); // undefined >= amount is false
  };
  const swapMsg = JSON.stringify({ force: 0, actions: [{ pool_id: poolOf(from, to), token_in: ftId(from), token_out: ftId(to), amount_in: amountIn.toString(), min_amount_out: BigInt(limit).toString() }] });
  try {
    if (from === 'near') {
      await fund(amountIn + HOP_GAS_MONEY);
      onStep('Swapping on Rhea');
      hashes.push(await hopTx(acct, to, [await register(provider, to, hop.accountId)]));
      hashes.push(await hopTx(acct, RHEA.wrap, [
        await register(provider, RHEA.wrap, hop.accountId),
        { method: 'near_deposit', args: {}, gas: GAS.wrap, deposit: amountIn },
      ]));
      hashes.push(await hopTx(acct, RHEA.wrap, [{ method: 'ft_transfer_call', args: { receiver_id: RHEA.exchange, amount: amountIn.toString(), msg: swapMsg }, gas: GAS.swap, deposit: 1n }]));
    } else {
      await fund(HOP_GAS_MONEY);
      onStep(`Taking ${RHEA.tokens[from]?.symbol ?? from} out of the pool`);
      for (const t of [from, RHEA.wrap]) hashes.push(await hopTx(acct, t, [await register(provider, t, hop.accountId)]));
      await wallet.sync();
      const w = await wallet.withdraw(from, amountIn, hop.accountId);
      hashes.push(await hopTx(acct, w.receiverId, [{ ...w, gas: GAS.withdraw }]));
      onStep('Swapping on Rhea');
      hashes.push(await hopTx(acct, from, [{ method: 'ft_transfer_call', args: { receiver_id: RHEA.exchange, amount: amountIn.toString(), msg: swapMsg }, gas: GAS.swap, deposit: 1n }]));
    }
  } finally {
    // also after a failed or partial swap: whatever the hop holds goes back to the user
    hashes.push(...(await sweep({ wallet, provider, open, hopIndex, onStep })));
  }
  return { hop: hop.accountId, hashes };
}

/**
 * Moves everything hop `hopIndex` holds (NEAR, wNEAR, any Rhea token, and any pool payout to it
 * that failed) back into the pool as the user's notes, then deletes the hop. Safe to re-run;
 * does nothing if the hop does not exist. Keeps the hop if anything could not be moved.
 */
export async function sweep({ wallet, provider, open, hopIndex, onStep = () => {} }: SweepParams): Promise<string[]> {
  const hop = hopKey(wallet.keypair, hopIndex);
  const acct = signerAccount(hop.accountId, hop.secretKey, provider);
  const hashes: string[] = [];
  if (!(await nearBalance(provider, hop.accountId))) return hashes;
  onStep('Returning funds to your private balance');
  const wnear = await ftBalance(provider, RHEA.wrap, hop.accountId).catch(() => 0n);
  if (wnear > 0n) hashes.push(await hopTx(acct, RHEA.wrap, [{ method: 'near_withdraw', args: { amount: wnear.toString() }, gas: GAS.reg, deposit: 1n }]));
  const tokens = Object.keys(RHEA.tokens);
  const pool = wallet.pool.contractId;
  for (const t of tokens) {
    // a pool payout to the hop that failed (e.g. out of gas) is owed to it: claim it first
    if (BigInt((await wallet.pool.view('get_failed', { account_id: hop.accountId, token: t })) as string) > 0n) {
      hashes.push(await hopTx(acct, pool, [{ method: 'claim_failed', args: { account_id: hop.accountId, token: t }, gas: GAS.withdraw }]));
    }
    const bal = await ftBalance(provider, t, hop.accountId).catch(() => 0n);
    if (bal === 0n) continue;
    await wallet.sync();
    const [prepay, transfer] = await wallet.deposit(t, bal);
    hashes.push(await hopTx(acct, prepay.receiverId, [{ ...prepay, gas: GAS.reg }]));
    hashes.push(await hopTx(acct, transfer!.receiverId, [{ ...transfer!, gas: GAS.ftDeposit }])); // a token deposit is two calls
  }
  const b = (await nearBalance(provider, hop.accountId))!; // exists: checked above
  const spare = b.amount - b.storage - hold(GAS.deposit) - STORAGE_FEE - 10n ** 21n;
  if (spare >= 10n ** 22n) {
    // worth re-depositing (at least 0.01 NEAR after the pool's storage fee)
    await wallet.sync();
    const [dep] = await wallet.deposit('near', spare);
    hashes.push(await hopTx(acct, dep.receiverId, [{ ...dep, gas: GAS.deposit }]));
  }
  // nothing of value is left: delete the hop, its dust tops up the open ring's gas account
  let left = false;
  for (const t of [RHEA.wrap, ...tokens]) left ||= (await ftBalance(provider, t, hop.accountId).catch(() => 0n)) > 0n;
  for (const t of tokens) left ||= BigInt((await wallet.pool.view('get_failed', { account_id: hop.accountId, token: t })) as string) > 0n;
  if (left) throw new Error(`the single-use account ${hop.accountId} still holds tokens; try Recover again`);
  {
    const res = await retry(() => acct.signAndSendTransaction({ receiverId: hop.accountId, actions: [actions.deleteAccount(open.account)], waitUntil: 'FINAL' }));
    hashes.push(res.transaction.hash);
  }
  return hashes;
}

/** Which of these hop indexes still exist (an interrupted swap). */
export async function findHops(keypair: AnyKeypair, provider: Provider, indexes: number[]): Promise<number[]> {
  const found: number[] = [];
  for (const n of indexes) if (await nearBalance(provider, hopKey(keypair, n).accountId)) found.push(n);
  return found;
}

