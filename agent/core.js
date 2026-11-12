// Private payment tools for AI agents, over a shielded wallet. Runs in Node (tools.js, the
// MCP server) and in the browser (the app's Agent tab).
//
// The tools hold the shielded key and enforce the spending caps, so a confused or
// prompt-injected model cannot spend more than the operator allows. Payments go through the
// open ring (no NEAR account, no gas, no relayer); swaps go through Rhea (sdk/src/rhea.js).
import { OPEN_FEE, verifyReceipt } from '../sdk/src/index.js';
import { RHEA, quote, minOut, privateSwap, newHopIndex } from '../sdk/src/rhea.js';

const YOCTO = 10n ** 24n;
export function toYocto(near) {
  return toUnits(near, 24, 'NEAR');
}
function toUnits(v, decimals, symbol) {
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(String(v))) throw new Error(`amount must be a decimal number of ${symbol}, e.g. "0.05"`);
  const [i, f = ''] = String(v).split('.');
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
const fmt = (v, decimals, shown = 6) => `${v / 10n ** BigInt(decimals)}.${(v % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, shown)}`;
export const fromYocto = (y) => fmt(y, 24);
/** What a private swap costs on top of the pool fee (README, Private swaps on Rhea). */
export const SWAP_COST = 14n * 10n ** 22n;

// tokens the swap tool knows, by symbol
const SWAP_TOKENS = { NEAR: { id: 'near', decimals: 24 }, ...Object.fromEntries(Object.entries(RHEA.tokens).map(([id, t]) => [t.symbol, { id, decimals: t.decimals }])) };

/**
 * @param {object} o
 * @param {object} o.wallet          ShieldedWallet of the agent
 * @param {object} o.pool            { contractId, view }
 * @param {Function} o.submit        (call) => txHash, through the open ring
 * @param {string} o.gasAccount      the open ring's gas account (named as the fee's payee)
 * @param {string} [o.network]
 * @param {string} [o.maxPerPayment] hard cap per payment or swap, in NEAR
 * @param {string} [o.maxTotal]      hard cap on everything spent, fees included, in NEAR
 * @param {object} [o.swap]          mainnet only: { provider, open, onHop(index, done) } enables private_swap
 */
export function createTools({ wallet, pool, submit, gasAccount, network = 'testnet', maxPerPayment = '1', maxTotal = '1', swap }) {
  // the proof names the gas account as the fee's payee, so a copied transaction pays nobody else
  const fee = { relayer: gasAccount, fee: OPEN_FEE };
  const cap = toYocto(maxPerPayment);
  const budget = toYocto(maxTotal);
  let spent = 0n; // amounts and fees paid so far
  const explorer = (h) => `https://${network === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${h}`;
  const check = (amount, extra, what) => {
    if (amount > cap) throw new Error(`refused: ${what} is above the per-payment cap of ${maxPerPayment} NEAR set by the operator`);
    if (spent + amount + extra > budget) throw new Error(`refused: total spending budget of ${maxTotal} NEAR set by the operator would be exceeded (spent ${fromYocto(spent)})`);
  };

  // builds a proof, merging notes first if the balance is split across more than two
  async function pay(amountNear, build) {
    const amount = toYocto(amountNear);
    if (amount === 0n) throw new Error('amount must be positive');
    check(amount, 2n * OPEN_FEE, `${amountNear} NEAR`); // worst case includes a merge
    await wallet.sync();
    let call;
    try {
      call = await build(amount);
    } catch (e) {
      if (!/run merge first/.test(e.message)) throw e;
      await submit(await wallet.merge('near', fee));
      spent += OPEN_FEE;
      await wallet.sync();
      call = await build(amount);
    }
    const tx = await submit(call);
    spent += amount + OPEN_FEE;
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
      description: 'The private balances of this agent (NEAR and any swapped tokens). Nobody else can see them.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        await wallet.sync();
        const tokens = Object.fromEntries(Object.entries(SWAP_TOKENS).filter(([s, t]) => s !== 'NEAR' && wallet.balance(t.id) > 0n).map(([s, t]) => [s, fmt(wallet.balance(t.id), t.decimals)]));
        return { near: fromYocto(wallet.balance('near')), ...tokens, fee_per_payment_near: fromYocto(OPEN_FEE), max_per_payment_near: maxPerPayment, budget_left_near: fromYocto(budget - spent) };
      },
    },
    {
      name: 'private_send',
      description: 'Pay NEAR privately to a shielded address (starts with "npr"). The chain shows neither the payer, the recipient nor the amount. Returns a receipt that proves this one payment to whoever you show it to.',
      inputSchema: { type: 'object', required: ['to', 'amount_near'], properties: { to: { type: 'string', description: 'shielded address' }, amount_near: { type: 'string', description: 'decimal NEAR, e.g. "0.05"' } } },
      run: ({ to, amount_near }) => pay(amount_near, (a) => wallet.transfer('near', a, to, fee)),
    },
    {
      name: 'private_withdraw',
      description: 'Pay NEAR from the private balance to a normal NEAR account. The chain shows the recipient and the amount, not who paid.',
      inputSchema: { type: 'object', required: ['recipient', 'amount_near'], properties: { recipient: { type: 'string', description: 'NEAR account id' }, amount_near: { type: 'string' } } },
      run: ({ recipient, amount_near }) => pay(amount_near, (a) => wallet.withdraw('near', a, recipient, fee)),
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

  if (swap) {
    const symbols = Object.keys(SWAP_TOKENS);
    tools.push({
      name: 'private_swap',
      description: `Swap privately on Rhea between NEAR and ${symbols.slice(1).join(', ')} (one side must be NEAR). A single-use account does the swap and deposits the result back to this agent's private balance; nothing links it to the agent. Costs about 0.14 NEAR plus Rhea's 0.3% pool fee, and takes about a minute. The swap amounts are public on Rhea.`,
      inputSchema: { type: 'object', required: ['from', 'to', 'amount'], properties: { from: { type: 'string', enum: symbols }, to: { type: 'string', enum: symbols }, amount: { type: 'string', description: 'amount of the token given, decimal' } } },
      run: async ({ from, to, amount }) => {
        const f = SWAP_TOKENS[String(from).toUpperCase()], t = SWAP_TOKENS[String(to).toUpperCase()];
        if (!f || !t || f === t || (f.id !== 'near' && t.id !== 'near')) throw new Error(`swap NEAR with one of ${symbols.slice(1).join(', ')}`);
        const amountIn = toUnits(amount, f.decimals, from);
        if (amountIn === 0n) throw new Error('amount must be positive');
        const q = await quote(swap.provider, f.id, t.id, amountIn);
        // caps are in NEAR: the NEAR side of the swap must fit, plus its cost
        const nearSide = f.id === 'near' ? amountIn : q;
        check(nearSide, SWAP_COST, `a swap worth ${fromYocto(nearSide)} NEAR`);
        await wallet.sync();
        const index = newHopIndex();
        await swap.onHop?.(index, false); // the caller keeps the index until the swap is swept
        const r = await privateSwap({ wallet, provider: swap.provider, open: swap.open, from: f.id, to: t.id, amountIn, limit: minOut(q), hopIndex: index });
        await swap.onHop?.(index, true);
        spent += (f.id === 'near' ? amountIn : 0n) + SWAP_COST;
        await wallet.sync();
        return { swapped: `${amount} ${from}`, received_about: `${fmt(q, t.decimals)} ${to}`, single_use_account: r.hop, explorer: explorer(r.hashes[0]), cost_near: fromYocto(SWAP_COST) };
      },
    });
  }
  return tools;
}
