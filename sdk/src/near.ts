// NEAR transport for Node (CLI, relayer, tests). Browser apps can use wallet-selector instead.
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';
import type { KeyPairString, Provider } from 'near-api-js';
import type { PoolView, ShieldedWallet, TransactCall, TxOptions } from './wallet.ts';

export const RPC = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
};
const GAS_300 = 300_000_000_000_000n;
// gas limit of an open-ring transaction (one uses about 69 Tgas). The gas account must hold
// 0.001 NEAR per Tgas of limit to send it (refunded), so keep this tight.
const GAS_OPEN = 100_000_000_000_000n;

export type Network = keyof typeof RPC;

/** The pool contract over RPC: what ShieldedWallet needs, plus the provider. */
export interface PoolClient extends PoolView {
  provider: JsonRpcProvider;
}

/** A function call `send` can sign (ShieldedWallet call specs fit). */
export interface SendableCall {
  receiverId: string;
  method: string;
  args: Record<string, unknown>;
  deposit?: bigint;
  gas?: bigint;
}

type CallArgs = Parameters<JsonRpcProvider['callFunction']>[0];

/** The parts of a transaction outcome that failure checks read. A status is a string or an object. */
type Status = { Failure?: unknown } | undefined;
export interface TxOutcome {
  status?: Status;
  receipts_outcome?: { outcome: { status?: Status } }[];
}

/** The open ring of a network (open-ring/<network>.json): the gas account and its published keys. */
export interface OpenRing {
  account: string;
  keys: string[];
}

/**
 * Retries `fn` when the RPC rate-limits us (HTTP 429 on the free public endpoints), backing
 * off 1.5 s, 3 s, 4.5 s... A rate-limited request was rejected, not executed, so a retry is safe.
 */
export async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/429|rate limit/i.test(String((e as Error | undefined)?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/** `network` picks the default RPC; with another name, pass `rpcUrl`. */
export function poolClient(contractId: string, network: string = 'testnet', rpcUrl: string = RPC[network as Network]): PoolClient {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    contractId,
    provider,
    // near-api-js reads `blockQuery`, not `finality`: see the cast (and the report on it)
    view: (method: string, args: Record<string, unknown> = {}) => retry(() => provider.callFunction({ contractId, method, args, finality: 'final' } as CallArgs)),
  };
}

export async function blockHeight(provider: Provider): Promise<bigint> {
  return BigInt((await provider.viewBlock({ finality: 'final' })).header.height);
}

/** `secretKey` is "ed25519:…" (from a JSON file or env); KeyPairSigner rejects anything else. */
export function signerAccount(accountId: string, secretKey: string, provider: Provider): Account {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as KeyPairString));
}

/** Sends a call spec produced by ShieldedWallet ({ receiverId, method, args, deposit }). */
export async function send(account: Account, call: SendableCall): Promise<string> {
  const res = await retry(() => account.callFunctionRaw({
    contractId: call.receiverId,
    methodName: call.method,
    args: call.args,
    deposit: call.deposit ?? 0n,
    gas: call.gas ?? GAS_300,
    waitUntil: 'FINAL',
  }));
  const failure = findFailure(res as TxOutcome);
  if (failure) throw new Error(`${call.method} failed: ${JSON.stringify(failure)}`);
  return res.transaction.hash;
}

/**
 * Open ring: submit a shielded call with one of the pool's published function-call keys.
 * No relayer and no wallet: `open` is { account, keys } from open-ring/<network>.json.
 * The proof must have been built with `{ relayer: open.account, fee: OPEN_FEE }`.
 * The keys are shared by everyone, so a nonce can collide; then another key is tried.
 */
export async function sendOpen(provider: Provider, open: OpenRing, call: SendableCall): Promise<string> {
  const keys = [...open.keys].sort(() => Math.random() - 0.5).slice(0, 4);
  let last: unknown;
  for (const key of keys) {
    try {
      return await send(signerAccount(open.account, key, provider), { ...call, deposit: 0n, gas: GAS_OPEN });
    } catch (e) {
      last = e;
      if (!/nonce/i.test(String((e as Error | undefined)?.message ?? e))) throw e;
    }
  }
  throw last;
}

/**
 * Builds a call with `build()`. A proof spends at most two notes, so if the balance is split
 * across more, merges the two smallest through `submit` (paying the route's fee, `opts`) and
 * retries, up to `tries` merges. `onMerge` is called before each merge.
 */
export async function withMerge<T>(
  wallet: ShieldedWallet,
  token: string,
  opts: TxOptions,
  submit: (call: TransactCall) => Promise<unknown>,
  build: () => Promise<T>,
  { tries = 4, onMerge }: { tries?: number; onMerge?: () => void } = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    await wallet.sync();
    try {
      return await build();
    } catch (e) {
      if (i >= tries || !/run merge first/.test(String((e as Error | undefined)?.message))) throw e;
      onMerge?.();
      await submit(await wallet.merge(token, opts));
    }
  }
}

function findFailure(res: TxOutcome): unknown {
  if (res.status?.Failure) return res.status.Failure;
  for (const r of res.receipts_outcome ?? []) if (r.outcome.status?.Failure) return r.outcome.status.Failure;
  return null;
}
