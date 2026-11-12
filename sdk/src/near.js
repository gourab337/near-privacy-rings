// NEAR transport for Node (CLI, relayer, tests). Browser apps can use wallet-selector instead.
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

export const RPC = {
  testnet: 'https://rpc.testnet.fastnear.com',
  mainnet: 'https://rpc.mainnet.fastnear.com',
};
const GAS_300 = 300_000_000_000_000n;
// gas limit of an open-ring transaction (one uses about 69 Tgas). The gas account must hold
// 0.001 NEAR per Tgas of limit to send it (refunded), so keep this tight.
const GAS_OPEN = 100_000_000_000_000n;

/**
 * Retries `fn` when the RPC rate-limits us (HTTP 429 on the free public endpoints), backing
 * off 1.5 s, 3 s, 4.5 s... A rate-limited request was rejected, not executed, so a retry is safe.
 */
export async function retry(fn, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/429|rate limit/i.test(String(e?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

export function poolClient(contractId, network = 'testnet', rpcUrl = RPC[network]) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    contractId,
    provider,
    view: (method, args = {}) => retry(() => provider.callFunction({ contractId, method, args, finality: 'final' })),
  };
}

export async function blockHeight(provider) {
  return BigInt((await provider.viewBlock({ finality: 'final' })).header.height);
}

export function signerAccount(accountId, secretKey, provider) {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey));
}

/** Sends a call spec produced by ShieldedWallet ({ receiverId, method, args, deposit }). */
export async function send(account, call) {
  const res = await retry(() => account.callFunctionRaw({
    contractId: call.receiverId,
    methodName: call.method,
    args: call.args,
    deposit: call.deposit ?? 0n,
    gas: call.gas ?? GAS_300,
    waitUntil: 'FINAL',
  }));
  const failure = findFailure(res);
  if (failure) throw new Error(`${call.method} failed: ${JSON.stringify(failure)}`);
  return res.transaction.hash;
}

/**
 * Open ring: submit a shielded call with one of the pool's published function-call keys.
 * No relayer and no wallet: `open` is { account, keys } from open-ring/<network>.json.
 * The proof must have been built with `{ relayer: open.account, fee: OPEN_FEE }`.
 * The keys are shared by everyone, so a nonce can collide; then another key is tried.
 */
export async function sendOpen(provider, open, call) {
  const keys = [...open.keys].sort(() => Math.random() - 0.5).slice(0, 4);
  let last;
  for (const key of keys) {
    try {
      return await send(signerAccount(open.account, key, provider), { ...call, deposit: 0n, gas: GAS_OPEN });
    } catch (e) {
      last = e;
      if (!/nonce/i.test(String(e?.message ?? e))) throw e;
    }
  }
  throw last;
}

function findFailure(res) {
  if (res.status?.Failure) return res.status.Failure;
  for (const r of res.receipts_outcome ?? []) if (r.outcome.status?.Failure) return r.outcome.status.Failure;
  return null;
}
