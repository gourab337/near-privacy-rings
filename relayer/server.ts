// Anonymous-ring relayer: submits shielded transactions from its own NEAR account so the
// user's account never appears on-chain. Paid by the public `fee` in the proof's ext data.
//
//   NPR_NETWORK=testnet NPR_CONTRACT=pool.x.testnet RELAYER_ACCOUNT_ID=relayer.x.testnet \
//   RELAYER_PRIVATE_KEY=ed25519:... node relayer/server.ts
import http from 'node:http';
import { poolClient, signerAccount, send } from '../sdk/src/near.ts';
import { STORAGE_FEE } from '../sdk/src/wallet.ts';

/** A call spec as a client posts it to /relay (untrusted JSON). */
interface RelayCall {
  receiverId?: string;
  method?: string;
  args?: { ext_data?: { ext_amount: string; relayer: string; token: string; fee: string } } & Record<string, unknown>;
}

const { NPR_NETWORK = 'testnet', NPR_CONTRACT, RELAYER_ACCOUNT_ID, RELAYER_PRIVATE_KEY, PORT = 8787 } = process.env;
// minimum fee per token in its smallest unit; tokens absent here are refused when a fee is due
// default 0.02 NEAR: covers the 0.01 NEAR storage fee the relayer attaches plus ~64 Tgas
const MIN_FEE: Record<string, string> = JSON.parse(process.env.RELAYER_MIN_FEE ?? '{"near":"20000000000000000000000","wrap.near":"20000000000000000000000","wrap.testnet":"20000000000000000000000"}');
// swaps hide the asset, so they cannot pay a fee; the operator sponsors them (or disables)
const SPONSOR_SWAPS = process.env.RELAYER_SPONSOR_SWAPS !== 'false';

if (!NPR_CONTRACT || !RELAYER_ACCOUNT_ID || !RELAYER_PRIVATE_KEY) {
  console.error('set NPR_CONTRACT, RELAYER_ACCOUNT_ID, RELAYER_PRIVATE_KEY');
  process.exit(1);
}
const pool = poolClient(NPR_CONTRACT, NPR_NETWORK);
const account = signerAccount(RELAYER_ACCOUNT_ID, RELAYER_PRIVATE_KEY, pool.provider);

/** Returns an error string, or null if the relayer is willing to submit `call`. */
export function checkCall(call: RelayCall): string | null {
  if (call?.receiverId !== NPR_CONTRACT) return 'wrong contract';
  if (call.method === 'swap') return SPONSOR_SWAPS ? null : 'swaps are not sponsored';
  if (call.method !== 'transact') return 'only transact and swap are relayed';
  const ext = call.args?.ext_data;
  if (!ext) return 'missing ext_data';
  if (BigInt(ext.ext_amount) > 0n) return 'deposits cannot be relayed';
  if (ext.relayer !== RELAYER_ACCOUNT_ID) return `ext_data.relayer must be ${RELAYER_ACCOUNT_ID}`;
  const min = MIN_FEE[ext.token];
  if (min === undefined || BigInt(ext.fee) < BigInt(min)) return `fee below minimum (${min ?? 'token not accepted'})`;
  return null;
}

const server = http.createServer(async (req, res) => {
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') return reply(204, {});
  if (req.method === 'GET' && req.url === '/info') return reply(200, { relayer: RELAYER_ACCOUNT_ID, contract: NPR_CONTRACT, minFee: MIN_FEE, sponsorSwaps: SPONSOR_SWAPS });
  if (req.method !== 'POST' || req.url !== '/relay') return reply(404, { error: 'not found' });
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64 * 1024) return reply(413, { error: 'too large' });
  }
  try {
    const call = JSON.parse(body) as RelayCall;
    const err = checkCall(call);
    if (err) return reply(400, { error: err });
    // the relayer pays the storage fee itself (recovered from `fee`; sponsored for swaps)
    const deposit = call.method === 'swap' ? 2n * STORAGE_FEE : STORAGE_FEE;
    const txHash = await send(account, { receiverId: call.receiverId!, method: call.method!, args: call.args!, deposit });
    console.log(new Date().toISOString(), call.method, txHash);
    reply(200, { txHash });
  } catch (e) {
    reply(500, { error: String((e as Error).message ?? e).slice(0, 500) });
  }
});
server.listen(PORT, () => console.log(`relayer ${RELAYER_ACCOUNT_ID} -> ${NPR_CONTRACT} on :${PORT}`));
