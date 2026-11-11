// Private payments for AI agents.
//
// An agent gets a shielded balance and four tools. It needs no NEAR account, no gas and
// no relayer: payments are proven locally and submitted through the pool's open ring
// (published function-call keys, see README). The only secret is the shielded key.
import fs from 'node:fs';
import { initCrypto, Keypair, ShieldedWallet, OPEN_FEE, verifyReceipt } from '../sdk/src/index.js';
import { poolClient, sendOpen } from '../sdk/src/near.js';

const ROOT = new URL('..', import.meta.url).pathname;
const YOCTO = 10n ** 24n;
export function toYocto(near) {
  if (!/^\d+(\.\d{1,24})?$/.test(String(near))) throw new Error('amount must be a decimal number of NEAR, e.g. "0.05"');
  const [i, f = ''] = String(near).split('.');
  return BigInt(i) * YOCTO + BigInt(f.padEnd(24, '0'));
}
export const fromYocto = (y) => `${y / YOCTO}.${(y % YOCTO).toString().padStart(24, '0').slice(0, 6)}`;

/**
 * @param {object} o
 * @param {string} o.network        testnet | mainnet
 * @param {string} o.key            shielded private key (hex)
 * @param {string} [o.maxPerPayment] hard cap per payment in NEAR; the model cannot raise it
 * @param {object} [o.pool]         test hook: { contractId, view }
 * @param {Function} [o.submit]     test hook: (call) => txHash
 */
export async function createAgentTools({ network = 'testnet', key, maxPerPayment = '1', pool, submit }) {
  await initCrypto();
  const set = network === 'mainnet' ? 'mainnet' : 'dev';
  const art = { wasm: `${ROOT}artifacts/${set}/transaction2x2.wasm`, zkey: `${ROOT}artifacts/${set}/transaction2x2.zkey` };
  if (!pool) {
    const open = JSON.parse(fs.readFileSync(`${ROOT}open-ring/${network}.json`));
    pool = poolClient(open.pool, network);
    submit = (call) => sendOpen(pool.provider, open, call);
  }
  const wallet = new ShieldedWallet(new Keypair(BigInt('0x' + key)), pool, art);
  const cap = toYocto(maxPerPayment);
  const explorer = (h) => `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${h}`;

  // builds a proof, merging notes first if the balance is split across more than two
  async function pay(amountNear, build) {
    const amount = toYocto(amountNear);
    if (amount === 0n) throw new Error('amount must be positive');
    if (amount > cap) throw new Error(`refused: ${amountNear} NEAR is above the per-payment cap of ${maxPerPayment} NEAR set by the operator`);
    await wallet.sync();
    let call;
    try {
      call = await build(amount);
    } catch (e) {
      if (!/run merge first/.test(e.message)) throw e;
      await submit(await wallet.merge('near', { fee: OPEN_FEE }));
      await wallet.sync();
      call = await build(amount);
    }
    const tx = await submit(call);
    return { tx, explorer: explorer(tx), fee_near: fromYocto(OPEN_FEE), receipt: call.receipt };
  }

  const tools = [
    {
      name: 'shielded_address',
      description: 'The shielded address of this agent. Give it to anyone who should pay the agent privately.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => ({ address: wallet.keypair.address() }),
    },
    {
      name: 'shielded_balance',
      description: 'The private NEAR balance of this agent. Nobody else can see it.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        await wallet.sync();
        return { near: fromYocto(wallet.balance('near')), fee_per_payment_near: fromYocto(OPEN_FEE), max_per_payment_near: maxPerPayment };
      },
    },
    {
      name: 'private_send',
      description: 'Pay NEAR privately to a shielded address (starts with "npr"). The chain shows neither the payer, the recipient nor the amount. Returns a receipt that proves this one payment to whoever you show it to.',
      inputSchema: { type: 'object', required: ['to', 'amount_near'], properties: { to: { type: 'string', description: 'shielded address' }, amount_near: { type: 'string', description: 'decimal NEAR, e.g. "0.05"' } } },
      run: ({ to, amount_near }) => pay(amount_near, (a) => wallet.transfer('near', a, to, { fee: OPEN_FEE })),
    },
    {
      name: 'private_withdraw',
      description: 'Pay NEAR from the private balance to a normal NEAR account. The chain shows the recipient and the amount, not who paid.',
      inputSchema: { type: 'object', required: ['recipient', 'amount_near'], properties: { recipient: { type: 'string', description: 'NEAR account id' }, amount_near: { type: 'string' } } },
      run: ({ recipient, amount_near }) => pay(amount_near, (a) => wallet.withdraw('near', a, recipient, { fee: OPEN_FEE })),
    },
    {
      name: 'verify_receipt',
      description: 'Check a payment receipt (starts with "nprreceipt") against the chain: was this exact amount paid to this shielded address?',
      inputSchema: { type: 'object', required: ['receipt'], properties: { receipt: { type: 'string' } } },
      run: async ({ receipt }) => {
        const r = await verifyReceipt(pool, receipt);
        return { valid: r.valid, token: r.token, amount_near: fromYocto(r.amount), to: r.to };
      },
    },
  ];
  return { tools, wallet };
}

/** Loads the agent's shielded key from NPR_AGENT_KEY or agent/.agent-key (created on first use). */
export function loadAgentKey() {
  if (process.env.NPR_AGENT_KEY) return process.env.NPR_AGENT_KEY;
  const f = `${ROOT}agent/.agent-key`;
  if (!fs.existsSync(f)) fs.writeFileSync(f, Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(31))).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}
