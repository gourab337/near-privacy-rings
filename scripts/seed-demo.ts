// Seeds the web app's demo mode (testnet only): public accounts for Alice and Bob, shielded
// keys for them, and N pre-funded demo sessions, written to demo/<network>.json.
//
// Every key in that file is PUBLIC ON PURPOSE. Anyone can spend the demo sessions' testnet
// NEAR; that is the point (a visitor starts with a balance, like Helius's demo). Never
// seed a mainnet demo this way.
//
//   node scripts/seed-demo.ts <pool> <sessions> <NEAR per session> <funder> [<funder>...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair } from '../sdk/node_modules/near-api-js/lib/index.js';
import { initCrypto, Keypair, ShieldedWallet } from '../sdk/src/index.ts';
import { poolClient, signerAccount, send } from '../sdk/src/near.ts';

const [pool, n, perNear, ...funders] = process.argv.slice(2);
if (!funders.length) throw new Error('usage: seed-demo.mjs <pool> <sessions> <NEAR per session> <funder>...');
const NETWORK = 'testnet';
const ART = { wasm: 'artifacts/dev/transaction2x2.wasm', zkey: 'artifacts/dev/transaction2x2.zkey' };
const creds = (id) => path.join(os.homedir(), '.near-credentials', NETWORK, `${id}.json`);
const { provider } = poolClient(pool, NETWORK);
const acct = (id) => signerAccount(id, JSON.parse(fs.readFileSync(creds(id))).private_key, provider);
const hex = (k) => k.privKey.toString(16);
await initCrypto();

const out = `demo/${NETWORK}.json`;
const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out)) : null;
// Alice and Bob: a public NEAR account (withdraw target) and a shielded key each
const people = {};
for (const name of ['alice', 'bob']) {
  if (prev?.people?.[name]) { people[name] = prev.people[name]; continue; }
  const account = `${name}.${funders[0]}`;
  const k = KeyPair.fromRandom('ed25519');
  await acct(funders[0]).createAccount({ newAccountId: account, publicKey: k.getPublicKey(), nearToTransfer: 10n ** 23n });
  fs.writeFileSync(creds(account), JSON.stringify({ account_id: account, public_key: k.getPublicKey().toString(), private_key: k.toString() }), { mode: 0o600 });
  people[name] = { account, key: hex(new Keypair()) };
}

// demo sessions, funded in parallel (one funder signs its share sequentially)
const sessions = Array.from({ length: Number(n) }, () => new Keypair());
const amount = BigInt(Math.round(Number(perNear) * 1e6)) * 10n ** 18n;
await Promise.all(funders.map(async (f, fi) => {
  const signer = acct(f);
  for (let i = fi; i < sessions.length; i += funders.length) {
    const w = new ShieldedWallet(sessions[i], poolClient(pool, NETWORK), ART);
    await w.sync();
    for (const c of await w.deposit('near', amount)) await send(signer, c);
    console.log(`session ${i} funded with ${perNear} NEAR by ${f}`);
  }
}));

const keys = [...(prev?.sessions ?? []), ...sessions.map(hex)];
fs.mkdirSync('demo', { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  note: 'Public on purpose: testnet demo keys. Anyone can spend these demo balances. See README, Try the demo.',
  pool, people, sessions: keys,
}, null, 2) + '\n');
console.log(`wrote ${out}: ${keys.length} sessions`);
process.exit(0);
