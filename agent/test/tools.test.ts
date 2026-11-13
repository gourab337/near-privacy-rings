// The agent tools against an in-memory pool, with real proofs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { initCrypto, Keypair, ShieldedWallet } from '../../sdk/src/index.ts';
import { createAgentTools, toYocto } from '../tools.ts';
import type { ToolArgs } from '../core.ts';
import type { Leaf, TransactCall } from '../../sdk/src/index.ts';

await initCrypto();
after(() => globalThis.curve_bn128?.terminate());
const ART = { wasm: new URL('../../artifacts/dev/transaction2x2.wasm', import.meta.url).pathname, zkey: new URL('../../artifacts/dev/transaction2x2.zkey', import.meta.url).pathname };

test('agent is paid privately, pays privately within its cap, and proves the payment', async () => {
  const leaves: Leaf[] = [], spent = new Set<string>();
  const pool = { contractId: 'pool.near', view: async (m: string, a: { from_index: number; limit: number; nullifier: string }) => (m === 'get_leaves' ? leaves.slice(a.from_index, a.from_index + a.limit) : spent.has(a.nullifier)) };
  let n = 0;
  const apply = async ({ args }: TransactCall) => {
    args.args.input_nullifiers.forEach((x) => spent.add(x));
    leaves.push({ commitment: args.args.output_commitments[0], encrypted_output: args.ext_data.encrypted_output1 });
    leaves.push({ commitment: args.args.output_commitments[1], encrypted_output: args.ext_data.encrypted_output2 });
    return `tx${++n}`;
  };
  // the agent's only route is the open ring: NEAR transactions with a fee of at least 0.02 NEAR
  const submit = (call: TransactCall) => {
    const e = call.args.ext_data;
    assert.ok(BigInt(e.fee) >= toYocto('0.02') && e.token === 'near' && e.relayer === 'gas.near');
    return apply(call);
  };
  const { tools, wallet } = await createAgentTools({ key: 'ab'.repeat(31), maxPerPayment: '0.5', maxTotal: '0.55', pool, submit, gasAccount: 'gas.near' });
  const call = (name: string, args: ToolArgs = {}) => tools.find((t) => t.name === name)!.run(args);

  // a customer funds the agent with three payments, so its balance sits in three notes
  const customer = new ShieldedWallet(new Keypair(), pool, ART);
  const { address } = await call('shielded_address');
  assert.equal(address, wallet.keypair.address());
  for (const amt of ['0.2', '0.2', '0.2']) {
    const [dep] = await customer.deposit('near', toYocto('0.5'));
    await apply(dep);
    await customer.sync();
    await apply(await customer.transfer('near', toYocto(amt), address, { fee: toYocto('0.02') }));
    await customer.sync();
  }
  assert.equal((await call('shielded_balance')).near, '0.600000');

  // over the cap: refused before any proof is made
  await assert.rejects(() => call('private_send', { to: customer.keypair.address(), amount_near: '0.6' }), /per-payment cap/);

  // 0.45 plus the fee is more than any two notes hold, so the tool merges first, then pays
  const paid = await call('private_send', { to: customer.keypair.address(), amount_near: '0.45' });
  assert.match(paid.receipt as string, /^nprreceipt/);
  assert.deepEqual(await call('verify_receipt', { receipt: paid.receipt }), { valid: true, token: 'near', amount_near: '0.450000', to: customer.keypair.address() });
  // 0.6 - merge fee 0.02 - 0.45 - fee 0.02
  assert.equal((await call('shielded_balance')).near, '0.110000');

  // spent 0.49 (merge fee, 0.45, fee) of a 0.55 budget: 0.05 more, its fee and a possible merge would exceed it
  await assert.rejects(() => call('private_withdraw', { recipient: 'shop.near', amount_near: '0.05' }), /total spending budget/);
  await call('private_withdraw', { recipient: 'shop.near', amount_near: '0.01' });
  assert.equal((await call('shielded_balance')).near, '0.080000');
});
