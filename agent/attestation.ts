// Checks that the key signing a NEAR AI Cloud model's replies lives in a genuine TEE.
// Runs in Node and in the browser. Follows github.com/nearai/nearai-cloud-verifier.
//
// What a pass means: the signing key is bound, with our fresh nonce, into an Intel TDX quote
// that verifies against Intel's certificates (fetched through Phala's PCCS), from a VM
// running a specific dstack compose whose hash is pinned in the quote. In Node we also send
// the GPU evidence to NVIDIA's attestation service (NRAS); browsers cannot reach NRAS (it
// rejects cross-origin requests), so the app reports the GPU check as not run.
//
// What it does not prove: which model weights run (NEAR AI Cloud names the model only in an
// unattested log), that the GPUs are physically attached to that VM (they share only the
// nonce), or that the compose itself is safe (that needs a review of its pinned images).
import dcap from '@phala/dcap-qvl';
import { NEARAI } from './nearai.ts';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(String(s).replace(/^0x/, '').match(/../g) ?? [], (h) => parseInt(h, 16));
const sha256hex = async (bytes) => hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
const norm = (a) => String(a ?? '').replace(/^0x/, '').toLowerCase();
const isBrowser = typeof window !== 'undefined';
// TD report fields inside a TDX v4 quote (48-byte header first)
const MR_CONFIG_ID = 232, REPORT_DATA = 568;

/**
 * @returns {Promise<{ ok: boolean, checks: {name: string, ok: boolean|null, detail: string}[], model?: string, nonce: string }>}
 *   ok is true when every check that ran passed; a check with ok === null did not run.
 */
export async function verifyAttestation({ base = NEARAI.base, model = NEARAI.model, signingAddress }) {
  const nonce = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const q = new URLSearchParams({ model, nonce, signing_algo: 'ed25519', signing_address: signingAddress });
  const res = await fetch(`${base}/attestation/report?${q}`);
  if (!res.ok) {
    add('Signing key is attested', false, `NEAR AI Cloud has no attestation for this key (${res.status})`);
    return { ok: false, checks, nonce };
  }
  const report = await res.json();
  const att = (report.model_attestations ?? []).find((a) => norm(a.signing_address) === norm(signingAddress));
  if (!att) {
    add('Signing key is attested', false, `no attestation for key ${norm(signingAddress).slice(0, 12)}… and model ${model}`);
    return { ok: false, checks, nonce };
  }
  const quote = unhex(att.intel_quote);

  // 1. the quote is a genuine Intel TDX quote, with an acceptable TCB status
  try {
    const v = await dcap.getCollateralAndVerify(quote);
    const status = String(v.status);
    add('Intel TDX quote is genuine', status === 'UpToDate' || status === 'OutOfDate', `${status}, verified against Intel's certificates (collateral via Phala PCCS)`);
  } catch (e) {
    add('Intel TDX quote is genuine', false, String(e?.message ?? e).slice(0, 160));
  }

  // 2. the quote binds this signing key and our fresh nonce
  const rd = quote.slice(REPORT_DATA, REPORT_DATA + 64);
  const keyPadded = norm(signingAddress).padEnd(64, '0');
  add('Quote binds this signing key', hex(rd.slice(0, 32)) === keyPadded, `report_data[0..32] = ${hex(rd.slice(0, 8))}…`);
  add('Quote is fresh (our nonce)', hex(rd.slice(32, 64)) === nonce, `report_data[32..64] = our random nonce`);

  // 3. the VM runs the compose whose hash is pinned in the quote
  const info = att.info ?? {};
  const composeHash = norm(info.compose_hash ?? info.tcb_info?.compose_hash);
  const appCompose = info.tcb_info?.app_compose;
  const computed = appCompose ? await sha256hex(new TextEncoder().encode(appCompose)) : '';
  const mrConfig = hex(quote.slice(MR_CONFIG_ID, MR_CONFIG_ID + 48));
  add('VM runs the published compose', !!composeHash && computed === composeHash && mrConfig.startsWith('01' + composeHash), `compose ${composeHash.slice(0, 12)}…, pinned in mr_config_id`);

  // 4. NVIDIA GPU evidence (Node only: NRAS rejects browser requests)
  if (isBrowser) {
    add('NVIDIA GPU attestation', null, "not run in the browser (NVIDIA's service blocks it); run node agent/verify-tee.ts");
  } else {
    try {
      const payload = JSON.parse(att.nvidia_payload);
      if (payload.nonce !== nonce) throw new Error('GPU evidence is not for our nonce');
      const r = await fetch('https://nras.attestation.nvidia.com/v3/attest/gpu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: att.nvidia_payload });
      const body = await r.json();
      const jwt = body?.[0]?.[1];
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
      add('NVIDIA GPU attestation', claims['x-nvidia-overall-att-result'] === true, `NRAS overall result ${claims['x-nvidia-overall-att-result']} (JWT signature not checked)`);
    } catch (e) {
      add('NVIDIA GPU attestation', false, String(e?.message ?? e).slice(0, 160));
    }
  }
  return { ok: checks.every((c) => c.ok !== false), checks, model: att.model_name, nonce };
}
