// Generates contract test fixtures with the real SDK wallet against an in-memory pool
// (dev zkey only). Every call spec is "applied" locally the way the contract would.
import fs from 'node:fs';
import * as snarkjs from '../sdk/node_modules/snarkjs/main.js';
import { initCrypto, Keypair, ShieldedWallet } from '../sdk/src/index.ts';
import type { CallSpec, ExtDataJson, FtTransferCallArgs, Leaf, ProofArgs } from '../sdk/src/index.ts';
import { MerkleTree } from '../sdk/src/crypto.ts';

await initCrypto();
// NPR_KEYSET=mainnet writes contract/tests/fixtures/mainnet.json (used by `cargo test --features mainnet`)
const SET = process.env.NPR_KEYSET ?? 'dev';
const ART = { wasm: `artifacts/${SET}/transaction2x2.wasm`, zkey: `artifacts/${SET}/transaction2x2.zkey` };
const vkey = JSON.parse(fs.readFileSync(`artifacts/${SET}/verification_key.json`));
const TOKEN = 'wrap.testnet';
const VALID_UNTIL = 1000n;

// in-memory pool state
const leaves: Leaf[] = [];
const spent = new Set<string>();
const pool = {
  contractId: 'pool.near',
  view: async (m: string, a: { from_index: number; limit: number; nullifier: string }) => (m === 'get_leaves' ? leaves.slice(a.from_index, a.from_index + a.limit) : spent.has(a.nullifier)),
};
const tree = () => new MerkleTree(20, leaves.map((l) => BigInt('0x' + l.commitment)));
function apply(proofArgs: ProofArgs, ext: ExtDataJson) {
  proofArgs.input_nullifiers.forEach((n) => spent.add(n));
  leaves.push({ commitment: proofArgs.output_commitments[0], encrypted_output: ext.encrypted_output1 });
  leaves.push({ commitment: proofArgs.output_commitments[1], encrypted_output: ext.encrypted_output2 });
}
async function check(proofArgs: ProofArgs, ext: ExtDataJson, label: string) {
  const sig = [proofArgs.root, proofArgs.public_amount, proofArgs.ext_data_hash, proofArgs.public_asset, ...proofArgs.input_nullifiers, ...proofArgs.output_commitments].map((h) => BigInt('0x' + h).toString());
  const proof = decodeProof(proofArgs.proof);
  if (!(await snarkjs.groth16.verify(vkey, sig, proof))) throw new Error(`${label}: proof does not verify`);
}
// re-encode NEAR proof bytes into snarkjs form, to check the encoding round-trips
function decodeProof(b64: string) {
  const b = Buffer.from(b64, 'base64');
  const le = (o: number) => BigInt('0x' + Buffer.from(b.subarray(o, o + 32)).reverse().toString('hex')).toString();
  return { pi_a: [le(0), le(32), '1'], pi_b: [[le(64), le(96)], [le(128), le(160)], ['1', '0']], pi_c: [le(192), le(224), '1'], protocol: 'groth16', curve: 'bn128' };
}

const alice = new ShieldedWallet(new Keypair(11n), pool, ART);
const bob = new ShieldedWallet(new Keypair(22n), pool, ART);
const out: Record<string, unknown> = { note: `${SET} zkey fixtures`, empty_root: hex(tree().root()) };

// 1) alice deposits 10 native (yocto) units
await alice.sync();
const [dep] = await alice.deposit('near', 10n);
await check(dep.args.args, dep.args.ext_data, 'deposit');
out.deposit = dep.args;
apply(dep.args.args, dep.args.ext_data);
out.root_after_deposit = hex(tree().root());

// 2) alice -> bob 4 (hidden)
await alice.sync();
const tr = await alice.transfer('near', 4n, bob.keypair.address());
await check(tr.args.args, tr.args.ext_data, 'transfer');
out.transfer = tr.args;
apply(tr.args.args, tr.args.ext_data);
out.root_after_transfer = hex(tree().root());

// 3) bob deposits 5 wrap.testnet via ft_transfer_call
await bob.sync();
const [, ft] = await bob.deposit(TOKEN, 5n) as [CallSpec<{}>, CallSpec<FtTransferCallArgs>];
const msg = JSON.parse(ft.args.msg) as { args: ProofArgs; ext_data: ExtDataJson };
await check(msg.args, msg.ext_data, 'ft deposit');
out.ft_deposit = { msg: ft.args.msg, amount: ft.args.amount, token: TOKEN };
apply(msg.args, msg.ext_data);

// 4) swap: alice gives 2 NEAR for bob's 3 wNEAR
await Promise.all([alice.sync(), bob.sync()]);
const offer = alice.createOffer('near', 2n, TOKEN, 3n, { validUntil: VALID_UNTIL });
const taken = await bob.takeOffer(offer);
const swap = await alice.completeOffer(taken);
await check(swap.args.leg_a, swap.args.ext_a, 'swap leg a');
await check(swap.args.leg_b, swap.args.ext_b, 'swap leg b');
out.swap = swap.args;
out.swap_valid_until = Number(VALID_UNTIL);
apply(swap.args.leg_a, swap.args.ext_a);
apply(swap.args.leg_b, swap.args.ext_b);
out.root_after_swap = hex(tree().root());

// sanity: balances as the wallets see them after everything
await Promise.all([alice.sync(), bob.sync()]);
const bal = (w: ShieldedWallet) => `${w.balance('near')} NEAR / ${w.balance(TOKEN)} wNEAR`;
console.log('alice', bal(alice), '| bob', bal(bob));
if (alice.balance('near') !== 4n || alice.balance(TOKEN) !== 3n || bob.balance('near') !== 6n || bob.balance(TOKEN) !== 2n) throw new Error('unexpected balances');

// 5) open ring, on a fresh pool: carol deposits 0.05 NEAR, then withdraws 0.01 NEAR to
//    carol.near with a 0.02 NEAR fee, naming the gas account that will submit it
leaves.length = 0;
spent.clear();
const carol = new ShieldedWallet(new Keypair(33n), pool, ART);
await carol.sync();
const [odep] = await carol.deposit('near', 5n * 10n ** 22n);
apply(odep.args.args, odep.args.ext_data);
await carol.sync();
const owd = await carol.withdraw('near', 10n ** 22n, 'carol.near', { relayer: 'gas.near', fee: 2n * 10n ** 22n });
await check(owd.args.args, owd.args.ext_data, 'open withdraw');
out.open = { deposit: odep.args, withdraw: owd.args };

fs.writeFileSync(`contract/tests/fixtures/${SET}.json`, JSON.stringify(out, null, 2));
console.log(`wrote contract/tests/fixtures/${SET}.json`);
process.exit(0);

function hex(x: bigint): string {
  return x.toString(16).padStart(64, '0');
}
