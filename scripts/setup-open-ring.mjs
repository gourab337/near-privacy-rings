// Sets up the open ring's gas account: creates it, adds function-call keys that can only
// call `transact` on the pool, and writes the PRIVATE keys to open-ring/<network>.json.
// Those keys are meant to be public: they cannot move funds, attach NEAR, or call
// anything else. Anyone may sign an anonymous transaction with them.
//
//   node scripts/setup-open-ring.mjs <network> <pool> <gasAccount> <funder> [NEAR=1] [keys=8]
//
// <funder> must be the parent of <gasAccount>; its key is read from ~/.near-credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair, actions } from '../sdk/node_modules/near-api-js/lib/index.js';
import { poolClient, signerAccount } from '../sdk/src/near.js';

const [network, pool, gasAccount, funder, near = '1', count = '8'] = process.argv.slice(2);
if (!funder) throw new Error('usage: setup-open-ring.mjs <network> <pool> <gasAccount> <funder> [NEAR] [keys]');
const creds = (id) => path.join(os.homedir(), '.near-credentials', network, `${id}.json`);
const { provider } = poolClient(pool, network);

const out = `open-ring/${network}.json`;
const NOTE = 'Public on purpose. These are function-call keys that can only call transact on the pool; they cannot move funds. See README, Open ring.';
let gas;
const actionsList = [];
if (fs.existsSync(creds(gasAccount))) {
  // re-run: keep the account, replace the published keys
  gas = signerAccount(gasAccount, JSON.parse(fs.readFileSync(creds(gasAccount))).private_key, provider);
  if (fs.existsSync(out)) for (const k of JSON.parse(fs.readFileSync(out)).keys) actionsList.push(actions.deleteKey(KeyPair.fromString(k).getPublicKey()));
} else {
  const full = KeyPair.fromRandom('ed25519');
  await signerAccount(funder, JSON.parse(fs.readFileSync(creds(funder))).private_key, provider).createAccount({
    newAccountId: gasAccount,
    publicKey: full.getPublicKey(),
    nearToTransfer: BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n,
  });
  fs.writeFileSync(creds(gasAccount), JSON.stringify({ account_id: gasAccount, public_key: full.getPublicKey().toString(), private_key: full.toString() }), { mode: 0o600 });
  gas = signerAccount(gasAccount, full.toString(), provider);
}
const keys = [];
for (let i = 0; i < Number(count); i++) {
  const k = KeyPair.fromRandom('ed25519');
  // no allowance argument = no cap: the key may spend the gas account's balance on gas for
  // `transact` on the pool, and can do nothing else (the Account helper would cap it at 0.25 NEAR)
  actionsList.push(actions.addFunctionCallAccessKey(k.getPublicKey(), pool, ['transact']));
  keys.push(k.toString());
}
await gas.signAndSendTransaction({ receiverId: gasAccount, actions: actionsList });
fs.mkdirSync('open-ring', { recursive: true });
fs.writeFileSync(out, JSON.stringify({ note: NOTE, pool, account: gasAccount, keys }, null, 2) + '\n');
console.log(`gas account ${gasAccount} with ${keys.length} public function-call keys -> open-ring/${network}.json`);
