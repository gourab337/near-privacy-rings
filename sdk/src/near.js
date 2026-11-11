// NEAR transport for Node (CLI, relayer, tests). Browser apps can use wallet-selector instead.
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

export const RPC = {
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
};
const GAS_300 = 300_000_000_000_000n;

export function poolClient(contractId, network = 'testnet', rpcUrl = RPC[network]) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return {
    contractId,
    provider,
    view: (method, args = {}) => provider.callFunction({ contractId, method, args, finality: 'final' }),
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
  const res = await account.callFunctionRaw({
    contractId: call.receiverId,
    methodName: call.method,
    args: call.args,
    deposit: call.deposit ?? 0n,
    gas: GAS_300,
    waitUntil: 'FINAL',
  });
  const failure = findFailure(res);
  if (failure) throw new Error(`${call.method} failed: ${JSON.stringify(failure)}`);
  return res.transaction.hash;
}

function findFailure(res) {
  if (res.status?.Failure) return res.status.Failure;
  for (const r of res.receipts_outcome ?? []) if (r.outcome.status?.Failure) return r.outcome.status.Failure;
  return null;
}
