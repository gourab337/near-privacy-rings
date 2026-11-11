// Generates real proofs used as contract test fixtures (dev zkey only).
import fs from 'node:fs';
import * as snarkjs from '../sdk/node_modules/snarkjs/main.js';
import { initCrypto, Keypair, Note, MerkleTree, assetId } from '../sdk/src/crypto.js';
import { buildProof } from '../sdk/src/prover.js';

await initCrypto();
const art = { wasm: 'artifacts/dev/transaction2x2.wasm', zkey: 'artifacts/dev/transaction2x2.zkey' };
const vkey = JSON.parse(fs.readFileSync('artifacts/dev/verification_key.json'));
const NEAR = assetId('near');
const alice = new Keypair(11n), bob = new Keypair(22n);
const tree = new MerkleTree();
const enc = (n, kp) => n.encrypt(kp.view.publicKey);

// 1) deposit 10 (yocto units for test) of native NEAR to alice as 7 + 3
const d1 = new Note({ amount: 7n, keypair: alice, asset: NEAR });
const d2 = new Note({ amount: 3n, keypair: alice, asset: NEAR });
const depExt = { recipient: '', extAmount: 10n, relayer: '', fee: 0n, encryptedOutput1: enc(d1, alice), encryptedOutput2: enc(d2, alice), token: 'near', swapLeg: 0n };
const dep = await buildProof({ tree, inputs: [], outputs: [d1, d2], asset: NEAR, ext: depExt, publicAsset: NEAR, artifacts: art });
console.log('deposit proof verifies:', await snarkjs.groth16.verify(vkey, dep.publicSignals, dep.proof));
const rootBefore = tree.root();
d1.index = 0; d2.index = 1;
tree.insert(d1.commitment()); tree.insert(d2.commitment());

// 2) private transfer: alice spends 7+3, bob gets 4, alice change 6. asset hidden.
const o1 = new Note({ amount: 4n, pubKey: bob.pubKey, asset: NEAR });
const o2 = new Note({ amount: 6n, keypair: alice, asset: NEAR });
const trExt = { recipient: '', extAmount: 0n, relayer: '', fee: 0n, encryptedOutput1: enc(o1, bob), encryptedOutput2: enc(o2, alice), token: '', swapLeg: 0n };
const tr = await buildProof({ tree, inputs: [d1, d2], outputs: [o1, o2], asset: NEAR, ext: trExt, publicAsset: 0n, artifacts: art });
console.log('transfer proof verifies:', await snarkjs.groth16.verify(vkey, tr.publicSignals, tr.proof));
const rootAfterDeposit = tree.root();
o1.index = 2; o2.index = 3;
tree.insert(o1.commitment()); tree.insert(o2.commitment());

const extJson = (e) => ({ recipient: e.recipient, ext_amount: e.extAmount.toString(), relayer: e.relayer, fee: e.fee.toString(),
  encrypted_output1: Buffer.from(e.encryptedOutput1).toString('base64'), encrypted_output2: Buffer.from(e.encryptedOutput2).toString('base64'),
  token: e.token, swap_leg: e.swapLeg.toString(16).padStart(64, '0') });
const hex = (x) => x.toString(16).padStart(64, '0');
fs.writeFileSync('contract/tests/fixtures/dev.json', JSON.stringify({
  note: 'DEV zkey fixtures — not for mainnet',
  empty_root: hex(rootBefore), root_after_deposit: hex(rootAfterDeposit), root_after_transfer: hex(tree.root()),
  deposit: { args: dep.args, ext_data: extJson(depExt) },
  transfer: { args: tr.args, ext_data: extJson(trExt) },
}, null, 2));
console.log('wrote fixtures');
process.exit(0);
