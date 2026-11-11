// End-to-end demo against a deployed pool (testnet or mainnet).
//
//   NPR_NETWORK=testnet NPR_CONTRACT=pool.x.testnet ALICE=x.testnet BOB=bob.x.testnet \
//   RELAYER_URL=http://localhost:8787 node scripts/e2e.mjs
//
// Signing keys are read from ~/.near-credentials/<network>/<account>.json.
// Shielded keys are created fresh each run (printed so the run can be inspected).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initCrypto, Keypair, ShieldedWallet } from '../sdk/src/index.js';
import { blockHeight, poolClient, signerAccount, send } from '../sdk/src/near.js';

const env = process.env;
const NETWORK = env.NPR_NETWORK ?? 'testnet';
const CONTRACT = env.NPR_CONTRACT;
const WRAP = NETWORK === 'mainnet' ? 'wrap.near' : 'wrap.testnet';
const ART = {
  wasm: env.NPR_WASM ?? 'artifacts/dev/transaction2x2.wasm',
  zkey: env.NPR_ZKEY ?? 'artifacts/dev/transaction2x2.zkey',
};
const NEAR = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 18n; // x NEAR in yocto
const fmt = (y) => (Number(y / 10n ** 18n) / 1e6).toFixed(6);

function account(id) {
  const f = path.join(os.homedir(), '.near-credentials', NETWORK, `${id}.json`);
  return signerAccount(id, JSON.parse(fs.readFileSync(f)).private_key, pool.provider);
}
async function relay(call) {
  const r = await fetch(`${env.RELAYER_URL}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receiverId: call.receiverId, method: call.method, args: call.args }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`relayer: ${j.error}`);
  return j.txHash;
}
const step = (s) => console.log(`\n▸ ${s}`);
const tx = (h) => console.log(`  tx ${h}  https://${NETWORK === 'mainnet' ? '' : 'testnet.'}nearblocks.io/txns/${h}`);

const pool = poolClient(CONTRACT, NETWORK);
await initCrypto();
const relayerInfo = await (await fetch(`${env.RELAYER_URL}/info`)).json();
const alice = { acct: account(env.ALICE), w: new ShieldedWallet(new Keypair(), pool, ART) };
const bob = { acct: account(env.BOB), w: new ShieldedWallet(new Keypair(), pool, ART) };
console.log('alice shielded address', alice.w.keypair.address().slice(0, 24) + '…');
console.log('bob   shielded address', bob.w.keypair.address().slice(0, 24) + '…');
const show = async () => {
  await Promise.all([alice.w.sync(), bob.w.sync()]);
  for (const [n, p] of [['alice', alice], ['bob', bob]]) console.log(`  ${n}: ${fmt(p.w.balance('near'))} NEAR, ${fmt(p.w.balance(WRAP))} wNEAR (shielded)`);
};

step('1. alice deposits 0.2 NEAR (public: alice, 0.2 NEAR)');
await alice.w.sync();
for (const c of await alice.w.deposit('near', NEAR(0.2))) tx(await send(alice.acct, c));
await show();

step('2. confidential ring: alice sends bob 0.05 NEAR (public: alice signed; asset, amount, recipient hidden)');
tx(await send(alice.acct, await alice.w.transfer('near', NEAR(0.05), bob.w.keypair.address())));
await show();

step(`3. anonymous ring: bob withdraws 0.03 NEAR to his account via relayer ${relayerInfo.relayer} (bob never signs)`);
const fee = BigInt(relayerInfo.minFee.near);
tx(await relay(await bob.w.withdraw('near', NEAR(0.03), env.BOB, { relayer: relayerInfo.relayer, fee })));
await show();

step('4. bob wraps 0.1 NEAR and deposits 0.1 wNEAR via ft_transfer_call');
await bob.acct.callFunction({ contractId: WRAP, methodName: 'storage_deposit', args: {}, deposit: NEAR(0.00125), gas: 30_000_000_000_000n });
await bob.acct.callFunction({ contractId: WRAP, methodName: 'near_deposit', args: {}, deposit: NEAR(0.1), gas: 30_000_000_000_000n });
for (const c of await bob.w.deposit(WRAP, NEAR(0.1))) tx(await send(bob.acct, c));
await show();

step('5. private swap: alice gives 0.04 NEAR for bob’s 0.05 wNEAR, atomically, submitted by the relayer');
// both legs expire ~10 minutes from now, so neither side can sit on the other's leg
const offer = alice.w.createOffer('near', NEAR(0.04), WRAP, NEAR(0.05), { validUntil: (await blockHeight(pool.provider)) + 600n });
const taken = await bob.w.takeOffer(offer);
tx(await relay(await alice.w.completeOffer(taken)));
await show();

console.log('\n✓ e2e complete');
process.exit(0);
