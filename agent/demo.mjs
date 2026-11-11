// An AI agent with a private wallet, driven by a model on NEAR AI Cloud (TEE-hosted).
//
//   NEAR_AI_API_KEY=... node agent/demo.mjs "Pay 0.01 NEAR to npr… for the dataset"
//
// The model decides; the tools in tools.js hold the shielded key and enforce the payment
// cap, so a confused or prompt-injected model cannot spend more than NPR_MAX_PAYMENT.
// After each model reply the script fetches NEAR AI Cloud's signature for the exact bytes
// exchanged and checks it. That shows which key signed the reply. It does not verify the
// hardware attestation of that key; use github.com/nearai/nearai-cloud-verifier for that.
import crypto from 'node:crypto';
import { createAgentTools, loadAgentKey } from './tools.js';

const BASE = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const MODEL = process.env.NEAR_AI_MODEL ?? 'zai-org/GLM-5.1-FP8';
const KEY = process.env.NEAR_AI_API_KEY;
if (!KEY) throw new Error('set NEAR_AI_API_KEY (https://cloud.near.ai, or the hackathon credits at https://nearbuilders.org/dashboard)');
const auth = { authorization: `Bearer ${KEY}` };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const { tools } = await createAgentTools({ network: process.env.NPR_NETWORK ?? 'testnet', key: loadAgentKey(), maxPerPayment: process.env.NPR_MAX_PAYMENT ?? '0.05' });
const toolSpecs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

/** Checks the signature NEAR AI Cloud publishes for one completion. Returns a one-line verdict. */
async function checkSignature(id, requestBytes, responseBytes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${BASE}/signature/${id}?signing_algo=ed25519`, { headers: { ...auth, accept: 'application/json' } });
    const s = r.ok ? await r.json() : null;
    if (s?.signature && s.text) {
      const hashes = `${sha(requestBytes)}:${sha(responseBytes)}`;
      const expected = s.signature_kind === 'provider_tee' ? `${MODEL}:${hashes}` : s.signature_kind === 'gateway' ? hashes : null;
      if (s.text !== expected) return `UNVERIFIED: signed text does not match the bytes we exchanged (${s.signature_kind})`;
      const hex = (x) => Buffer.from(String(x).replace(/^0x/, ''), 'hex');
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), hex(s.signing_address)]), format: 'der', type: 'spki' });
      const ok = crypto.verify(null, Buffer.from(s.text), pub, hex(s.signature));
      return ok ? `signed by ${s.signature_kind} key ${String(s.signing_address).slice(0, 16)}… over these exact bytes` : 'UNVERIFIED: bad signature';
    }
    await new Promise((res) => setTimeout(res, 1500));
  }
  return 'UNVERIFIED: no signature available';
}

const messages = [
  { role: 'system', content: 'You are an autonomous agent with a private NEAR wallet. Use the tools to check your balance and make payments. Never invent addresses or receipts. Report what you did in two sentences.' },
  { role: 'user', content: process.argv[2] ?? 'What is your shielded address and private balance?' },
];
for (let turn = 0; turn < 8; turn++) {
  const body = JSON.stringify({ model: MODEL, messages, tools: toolSpecs });
  const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'accept-encoding': 'identity', 'x-no-aliasing': 'true' }, body });
  const raw = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`NEAR AI Cloud ${res.status}: ${raw.toString().slice(0, 300)}`);
  const out = JSON.parse(raw.toString());
  console.log(`[model reply ${out.id}] ${await checkSignature(out.id, Buffer.from(body), raw)}`);
  const msg = out.choices[0].message;
  messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
  if (!msg.tool_calls?.length) {
    console.log(`\n${msg.content}`);
    break;
  }
  for (const c of msg.tool_calls) {
    const tool = tools.find((t) => t.name === c.function.name);
    let result;
    try {
      result = tool ? await tool.run(JSON.parse(c.function.arguments || '{}')) : { error: 'unknown tool' };
    } catch (e) {
      result = { error: String(e.message ?? e) };
    }
    console.log(`[tool] ${c.function.name}(${c.function.arguments}) -> ${JSON.stringify(result).slice(0, 200)}`);
    messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
  }
}
process.exit(0);
