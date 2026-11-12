// An AI agent with a private wallet, driven by a model on NEAR AI Cloud (TEE-hosted).
//
//   NEAR_AI_API_KEY=... node agent/demo.mjs "Pay 0.01 NEAR to npr… for the dataset"
//
// The model decides; the tools (core.js) hold the shielded key and enforce the caps, so a
// confused or prompt-injected model cannot spend more than NPR_MAX_PAYMENT / NPR_MAX_TOTAL.
// After each reply, nearai.js checks NEAR AI Cloud's signature over the exact bytes exchanged.
// NPR_NETWORK=mainnet adds the private_swap tool (Rhea).
import { createAgentTools, loadAgentKey } from './tools.js';
import { NEARAI, SYSTEM_PROMPT, runAgent } from './nearai.js';

const KEY = process.env.NEAR_AI_API_KEY;
if (!KEY) throw new Error('set NEAR_AI_API_KEY (https://cloud.near.ai, or the hackathon credits at https://nearbuilders.org/dashboard)');
const { tools } = await createAgentTools({ network: process.env.NPR_NETWORK ?? 'testnet', key: loadAgentKey(), maxPerPayment: process.env.NPR_MAX_PAYMENT ?? '0.05', maxTotal: process.env.NPR_MAX_TOTAL ?? '0.1' });
await runAgent({
  base: process.env.NEAR_AI_BASE_URL ?? NEARAI.base,
  apiKey: KEY,
  model: process.env.NEAR_AI_MODEL ?? NEARAI.model,
  tools,
  messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: process.argv[2] ?? 'What is your shielded address and private balance?' }],
  onEvent: (e) => {
    if (e.type === 'reply') console.log(`[model reply ${e.id}] ${e.signature.ok ? '' : 'UNVERIFIED: '}${e.signature.verdict}`);
    if (e.type === 'tool') console.log(`[tool] ${e.name}(${JSON.stringify(e.args)}) -> ${JSON.stringify(e.error ? { error: e.error } : e.result).slice(0, 220)}`);
    if (e.type === 'answer') console.log(`\n${e.content}`);
  },
});
process.exit(0);
