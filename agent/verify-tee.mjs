// Verifies that the key signing a NEAR AI Cloud model's replies lives in a genuine TEE
// (Intel TDX quote, fresh nonce, pinned compose, NVIDIA GPU). No API key needed.
//
//   node agent/verify-tee.mjs [model] [signing address]
//
// Without a signing address it checks every attested key the model currently has.
import { NEARAI } from './nearai.js';
import { verifyAttestation } from './attestation.js';

const model = process.argv[2] ?? NEARAI.model;
let keys = process.argv[3] ? [process.argv[3]] : [];
if (!keys.length) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const r = await (await fetch(`${NEARAI.base}/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ed25519`)).json();
  keys = (r.model_attestations ?? []).map((a) => a.signing_address);
  console.log(`${model}: ${keys.length} attested signing key(s)`);
}
let all = true;
for (const k of keys) {
  const v = await verifyAttestation({ model, signingAddress: k });
  console.log(`\nkey ${String(k).replace(/^0x/, '').slice(0, 16)}…  model ${v.model ?? '?'}  ${v.ok ? 'PASS' : 'FAIL'}`);
  for (const c of v.checks) console.log(`  ${c.ok === null ? '–' : c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  all &&= v.ok;
}
process.exit(all ? 0 : 1);
