import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initCrypto, poseidon, Keypair, Note, MerkleTree, assetId, extDataHash, FIELD_SIZE } from '../src/crypto.ts';

await initCrypto();
const fixtures = JSON.parse(fs.readFileSync(new URL('../../contract/tests/fixtures/dev.json', import.meta.url)));

test('empty tree root matches the contract', () => {
  assert.equal(new MerkleTree().root().toString(16).padStart(64, '0'), fixtures.empty_root);
});

test('note encrypts to its owner only', () => {
  const alice = new Keypair(), eve = new Keypair();
  const n = new Note({ amount: 123456789n, pubKey: alice.pubKey, asset: assetId('near') });
  const ct = n.encrypt(alice.view.publicKey);
  assert.equal(ct.length, 152);
  const back = Note.decrypt(alice, ct, 7);
  assert.equal(back.commitment(), n.commitment());
  assert.equal(back.index, 7);
  assert.equal(Note.decrypt(eve, ct, 7), null);
});

test('shielded address round-trips', () => {
  const k = new Keypair();
  const p = Keypair.parseAddress(k.address());
  assert.equal(p.pubKey, k.pubKey);
  assert.deepEqual([...p.viewPk], [...k.view.publicKey]);
});

test('ids and hashes are canonical field elements', () => {
  for (const t of ['near', 'wrap.near', 'usdc.near']) assert.ok(assetId(t) > 0n && assetId(t) < FIELD_SIZE);
  const ext = { recipient: 'a.near', extAmount: -5n, relayer: '', fee: 1n, encryptedOutput1: Buffer.alloc(152), encryptedOutput2: Buffer.alloc(152), token: 'near', swapLeg: 0n };
  assert.ok(extDataHash(ext) < FIELD_SIZE);
});

test('merkle paths recompute the root', () => {
  const t = new MerkleTree(20, [1n, 2n, 3n]);
  const { pathElements, pathIndices } = t.path(2);
  // recompute from leaf 3 using the same hasher the circuit uses
  let cur = 3n, idx = pathIndices;
  for (const sib of pathElements) {
    cur = idx & 1 ? poseidon([sib, cur]) : poseidon([cur, sib]);
    idx >>= 1;
  }
  assert.equal(cur, t.root());
});
