// Viewing keys and payment receipts, with real proofs against an in-memory pool.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { initCrypto, Keypair, ShieldedWallet, verifyReceipt } from '../src/index.ts';
import type { Leaf, TransactCall } from '../src/index.ts';

await initCrypto();
// snarkjs keeps worker threads alive; stop them so the test process can exit
after(() => globalThis.curve_bn128?.terminate());
const ART = { wasm: new URL('../../artifacts/dev/transaction2x2.wasm', import.meta.url).pathname, zkey: new URL('../../artifacts/dev/transaction2x2.zkey', import.meta.url).pathname };

function memoryPool() {
  const leaves: Leaf[] = [], spent = new Set<string>();
  return {
    contractId: 'pool.near',
    view: async (m: string, a: { from_index: number; limit: number; nullifier: string }) => (m === 'get_leaves' ? leaves.slice(a.from_index, a.from_index + a.limit) : spent.has(a.nullifier)),
    apply({ args }: TransactCall) {
      args.args.input_nullifiers.forEach((n) => spent.add(n));
      leaves.push({ commitment: args.args.output_commitments[0], encrypted_output: args.ext_data.encrypted_output1 });
      leaves.push({ commitment: args.args.output_commitments[1], encrypted_output: args.ext_data.encrypted_output2 });
    },
  };
}

test('viewing key sees incoming notes, cannot spend; receipt proves one payment', async () => {
  const pool = memoryPool();
  const alice = new ShieldedWallet(new Keypair(), pool, ART);
  const bob = new ShieldedWallet(new Keypair(), pool, ART);

  pool.apply((await alice.deposit('near', 100n))[0]);
  await alice.sync();
  const pay = await alice.transfer('near', 30n, bob.keypair.address());
  pool.apply(pay);

  // auditor holding bob's viewing key
  const vk = bob.keypair.viewingKey();
  assert.notEqual(vk.slice(71), bob.keypair.privKey!.toString(16).padStart(64, '0'));
  const auditor = await new ShieldedWallet(Keypair.fromViewingKey(vk), pool, ART).sync();
  assert.equal(auditor.viewOnly, true);
  assert.equal(auditor.balance('near'), 30n);
  await assert.rejects(() => auditor.withdraw('near', 10n, 'thief.near'), /private key/);
  // alice's viewing key sees her deposit and her change, not bob's note
  const a2 = await new ShieldedWallet(Keypair.fromViewingKey(alice.keypair.viewingKey()), pool, ART).sync();
  assert.deepEqual(a2.notes.map((n) => n.amount), [100n, 70n]);

  // receipt: valid as issued, invalid if any field is changed
  const r = await verifyReceipt(pool, pay.receipt);
  assert.deepEqual([r.valid, r.amount, r.token, r.to], [true, 30n, 'near', bob.keypair.address()]);
  const forged = JSON.parse(Buffer.from(pay.receipt.slice(10), 'base64url').toString());
  forged.amount = '31';
  assert.equal((await verifyReceipt(pool, 'nprreceipt' + Buffer.from(JSON.stringify(forged)).toString('base64url'))).valid, false);
});
