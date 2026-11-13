import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { initCrypto, Keypair } from '../src/index.ts';
import { hopKey, minOut, newHopIndex } from '../src/rhea.ts';

test('hop accounts are derived from the shielded key, recoverable and unlinkable', async () => {
  await initCrypto();
  const kp = new Keypair(123456789n);
  const a = hopKey(kp, 0);
  assert.deepEqual(hopKey(new Keypair(123456789n), 0), a, 'same key and index give the same hop (recoverable from a backup)');
  assert.notEqual(hopKey(kp, 1).accountId, a.accountId, 'each swap gets a new hop');
  assert.notEqual(hopKey(new Keypair(987654321n), 0).accountId, a.accountId);
  assert.match(a.accountId, /^[0-9a-f]{64}$/, 'an implicit account id');
  assert.equal(Buffer.from(KeyPair.fromString(a.secretKey).getPublicKey().data).toString('hex'), a.accountId, 'the secret key controls that account');
  assert.equal(minOut(10_000n), 9_950n, '0.5% slippage');
  const idx = new Set(Array.from({ length: 50 }, newHopIndex));
  assert.ok(idx.size === 50 && [...idx].every((i) => Number.isInteger(i) && i >= 0 && i < 2 ** 31), 'hop indexes are random, never reused');
});
