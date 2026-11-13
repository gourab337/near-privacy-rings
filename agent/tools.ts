// Private payments for AI agents.
//
// An agent gets a shielded balance and payment tools (core.ts). It needs no NEAR account, no gas and
// no relayer: payments are proven locally and submitted through the pool's open ring
// (published function-call keys, see README). The only secret is the shielded key.
import fs from 'node:fs';
import { initCrypto, Keypair, ShieldedWallet, OPEN_FEE } from '../sdk/src/index.ts';
import { poolClient, sendOpen } from '../sdk/src/near.ts';
import type { OpenRing, PoolClient } from '../sdk/src/near.ts';
import { createTools, toYocto, fromYocto } from './core.ts';
import type { CreateToolsOptions, SwapConfig, Tool } from './core.ts';

export interface AgentToolsOptions {
  network?: string;
  key: string;
  maxPerPayment?: string;
  maxTotal?: string;
  /** test hooks: pass all three, or none */
  pool?: CreateToolsOptions['pool'];
  submit?: CreateToolsOptions['submit'];
  gasAccount?: string;
}
type OpenRingFile = OpenRing & { pool: string; note?: string };

export { toYocto, fromYocto, OPEN_FEE };
const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Node setup of the agent tools (see core.ts for what they do).
 * @param {object} o
 * @param {string} o.network        testnet | mainnet (mainnet adds private_swap on Rhea)
 * @param {string} o.key            shielded private key (hex)
 * @param {string} [o.maxPerPayment] hard cap per payment in NEAR; the model cannot raise it
 * @param {string} [o.maxTotal]      hard cap on everything this process spends, fees included
 * @param {object} [o.pool]         test hook: { contractId, view }
 * @param {Function} [o.submit]     test hook: (call) => txHash
 * @param {string} [o.gasAccount]   test hook: the open ring's gas account
 */
export async function createAgentTools({ network = 'testnet', key, maxPerPayment = '1', maxTotal = '1', pool, submit, gasAccount }: AgentToolsOptions): Promise<{ tools: Tool[]; wallet: ShieldedWallet }> {
  await initCrypto();
  const set = network === 'mainnet' ? 'mainnet' : 'dev';
  const art = { wasm: `${ROOT}artifacts/${set}/transaction2x2.wasm`, zkey: `${ROOT}artifacts/${set}/transaction2x2.zkey` };
  let swap: SwapConfig | undefined;
  if (!pool) {
    const open = JSON.parse(fs.readFileSync(`${ROOT}open-ring/${network}.json`)) as OpenRingFile;
    pool = poolClient(open.pool, network);
    submit = (call) => sendOpen((pool as PoolClient).provider, open, call);
    gasAccount = open.account;
    if (network === 'mainnet') swap = { provider: (pool as PoolClient).provider, open };
  }
  const wallet = new ShieldedWallet(new Keypair(BigInt('0x' + key)), pool, art);
  const tools = createTools({ wallet, pool, submit: submit!, gasAccount: gasAccount!, network, maxPerPayment, maxTotal, swap });
  return { tools, wallet };
}

/** Loads the agent's shielded key from NPR_AGENT_KEY or agent/.agent-key (created on first use). */
export function loadAgentKey(): string {
  if (process.env.NPR_AGENT_KEY) return process.env.NPR_AGENT_KEY;
  const f = `${ROOT}agent/.agent-key`;
  if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(31))).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
