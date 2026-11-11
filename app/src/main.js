import './shims/globals.js';
import './style.css';
import '@near-wallet-selector/modal-ui/styles.css';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import { setupHereWallet } from '@near-wallet-selector/here-wallet';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { actionCreators } from '@near-js/transactions';
import { Buffer, initCrypto, Keypair, Note, assetId, ShieldedWallet, OPEN_FEE, verifyReceipt, encodeJson, decodeJson } from '../../sdk/src/index.js';
import { poolClient, sendOpen } from '../../sdk/src/near.js';

// ------------------------------------------------------------------ config
const NETWORK = import.meta.env.VITE_NETWORK ?? 'testnet';
const CONTRACT = import.meta.env.VITE_CONTRACT ?? 'npr-pool-65673.testnet';
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? 'http://localhost:8787';
const RPC = import.meta.env.VITE_RPC ?? (NETWORK === 'mainnet' ? 'https://rpc.mainnet.fastnear.com' : 'https://rpc.testnet.fastnear.com');
// open ring: published function-call keys of a gas account (see open-ring/README in the repo)
const OPEN = Object.entries(import.meta.glob('../../open-ring/*.json', { eager: true, import: 'default' }))
  .find(([f, o]) => f.endsWith(`/${NETWORK}.json`) && o.pool === CONTRACT)?.[1] ?? null;
const WRAP = NETWORK === 'mainnet' ? 'wrap.near' : 'wrap.testnet';
const TOKENS = [
  { id: 'near', symbol: 'NEAR', decimals: 24 },
  { id: WRAP, symbol: 'wNEAR', decimals: 24 },
];
const EXPLORER = NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
const GAS = 300_000_000_000_000n;
const KEY_STORE = `npr:key:${NETWORK}:${CONTRACT}`;
const OFFER_STORE = `npr:offer:${NETWORK}:${CONTRACT}`;
const EXPECTED_STORE = `npr:expected:${NETWORK}:${CONTRACT}`;
const SWAP_TTL_BLOCKS = 1200n; // ~15-20 minutes

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const tokenOf = (id) => TOKENS.find((t) => t.id === id);

// ------------------------------------------------------------------ amounts
function toUnits(str, decimals) {
  const s = String(str).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('invalid amount');
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error('too many decimals');
  const v = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (v <= 0n) throw new Error('amount must be positive');
  return v;
}
function fromUnits(v, decimals, shown = 4) {
  const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, '0').slice(0, shown);
  return `${v / d}.${frac}`;
}

// ------------------------------------------------------------------ chain access
async function view(method, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: method.contract ?? CONTRACT, method_name: method.name ?? method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
    }),
  });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error));
  return JSON.parse(Buffer.from(j.result.result).toString());
}
const pool = { contractId: CONTRACT, view: (m, a) => view(m, a) };
async function blockHeight() {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'block', params: { finality: 'final' } }) });
  return BigInt((await r.json()).result.header.height);
}
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const saveExpected = () => store.set(EXPECTED_STORE, sw.expectedState());

let selector, modal, nearAccount = null, relayerInfo = null;

async function signAndSend(calls) {
  if (!nearAccount) throw new Error('connect a NEAR wallet first');
  const wallet = await selector.wallet();
  const transactions = calls.map((c) => ({
    receiverId: c.receiverId,
    actions: [actionCreators.functionCall(c.method, c.args, GAS, BigInt(c.deposit ?? 0n))],
  }));
  const res = await wallet.signAndSendTransactions({ transactions });
  return (res ?? []).map((o) => o?.transaction?.hash).filter(Boolean);
}

async function relay(call) {
  if (!relayerInfo) throw new Error('relayer offline: use the confidential ring');
  const r = await fetch(`${RELAYER_URL}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ receiverId: call.receiverId, method: call.method, args: call.args }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`relayer: ${j.error}`);
  return [j.txHash];
}

/**
 * Anonymous submission. NEAR notes go through the open ring: the proof is signed in this
 * browser with a published key, so there is no relayer and no wallet. Other tokens, or an
 * open ring that fails (its gas account can be drained by spam), fall back to the relayer.
 * `build(opts)` makes the proof for a route; returns { hashes, who, fee }.
 */
async function sendAnonymous(token, build) {
  const routes = [];
  if (OPEN && token === 'near') {
    const { provider } = poolClient(CONTRACT, NETWORK, RPC);
    routes.push({ opts: { relayer: OPEN.account, fee: OPEN_FEE }, fee: OPEN_FEE, who: `A public key of <code>${OPEN.account}</code>, which anyone can use (no relayer),`, send: async (c) => [await sendOpen(provider, OPEN, c)] });
  }
  const f = minFee(token);
  if (f !== null) routes.push({ opts: { relayer: relayerInfo.relayer, fee: f }, fee: f, who: `Relayer <code>${relayerInfo.relayer}</code>`, send: relay });
  if (!routes.length) throw new Error('no anonymous route for this token: the relayer is offline');
  let last;
  for (const r of routes) {
    try {
      return { hashes: await r.send(await build(r.opts)), who: r.who, fee: r.fee };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ------------------------------------------------------------------ shielded wallet
let sw;
async function loadArtifacts() {
  const [wasm, zkey] = await Promise.all(['./transaction2x2.wasm', './transaction2x2.zkey'].map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
  return { wasm, zkey };
}
function loadKeypair() {
  let k = null;
  try { k = localStorage.getItem(KEY_STORE); } catch {}
  if (k?.startsWith('nprview')) return Keypair.fromViewingKey(k); // auditor: view-only
  const kp = k ? new Keypair(BigInt('0x' + k)) : new Keypair();
  if (!k) try { localStorage.setItem(KEY_STORE, kp.privKey.toString(16)); } catch {}
  return kp;
}

async function sync() {
  busy('Syncing notes…');
  try {
    await sw.sync();
    saveExpected();
    renderBalances();
  } finally {
    busy(false);
  }
}

function renderBalances() {
  $('#balances').innerHTML = TOKENS.map((t) => `<div><b>${fromUnits(sw.balance(t.id), t.decimals)}</b><span>${t.symbol}${sw.viewOnly ? ' received' : ''} · ${sw.notes.filter((n) => n.asset === assetId(t.id)).length} notes</span></div>`).join('');
}

// ------------------------------------------------------------------ ui helpers
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
  $$('button[type=submit]').forEach((b) => (b.disabled = !!text));
}
function log(text, hashes = [], err = false) {
  const ul = $('#log');
  if (ul.firstElementChild?.classList.contains('muted')) ul.innerHTML = '';
  const li = document.createElement('li');
  li.innerHTML = `<span class="${err ? 'err' : ''}"></span><span>${hashes.map((h) => `<a href="${EXPLORER}/txns/${h}" target="_blank" rel="noopener">${h.slice(0, 8)}…</a>`).join(' ')}</span>`;
  li.firstElementChild.textContent = text;
  ul.prepend(li);
}
function showPublic(panel, rows) {
  $('.public', panel).innerHTML = `<b>What the chain sees</b>${rows.filter(Boolean).map((r) => `<div>${r}</div>`).join('')}`;
}
async function run(label, fn) {
  try {
    busy('Generating zero-knowledge proof…');
    const res = await fn();
    await sync();
    return res;
  } catch (e) {
    console.error(e);
    log(`${label}: ${e.message ?? e}`, [], true);
  } finally {
    busy(false);
  }
}
const minFee = (token) => (relayerInfo?.minFee?.[token] ? BigInt(relayerInfo.minFee[token]) : null);

// ------------------------------------------------------------------ actions
async function onDeposit(form) {
  const token = form.token.value, t = tokenOf(token);
  const amount = toUnits(form.amount.value, t.decimals);
  await run('Deposit', async () => {
    const depositCalls = await sw.deposit(token, amount);
    const calls = [];
    if (token !== 'near') {
      // wrap NEAR -> wNEAR first (registering storage if needed)
      const reg = await view({ name: 'storage_balance_of', contract: token }, { account_id: nearAccount });
      if (!reg) calls.push({ receiverId: token, method: 'storage_deposit', args: {}, deposit: 1_250_000_000_000_000_000_000n });
      calls.push({ receiverId: token, method: 'near_deposit', args: {}, deposit: amount });
    }
    calls.push(...depositCalls);
    busy('Waiting for wallet…');
    const hashes = await signAndSend(calls);
    log(`Deposited ${form.amount.value} ${t.symbol}`, hashes);
    showPublic(form, [`Account <code>${nearAccount}</code> deposited ${form.amount.value} ${t.symbol}.`, 'Not visible: which shielded note it became, or who later spends it.']);
  });
}

async function onSend(form) {
  const token = form.token.value, t = tokenOf(token);
  const amount = toUnits(form.amount.value, t.decimals);
  const anonymous = form.ring.value === 'anonymous';
  await run('Send', async () => {
    Keypair.parseAddress(form.to.value.trim());
    const to = form.to.value.trim();
    let receipt;
    const build = async (opts) => { const c = await sw.transfer(token, amount, to, opts); receipt = c.receipt; return c; };
    const anon = anonymous ? await sendAnonymous(token, build) : null;
    const hashes = anon ? anon.hashes : await signAndSend([await build()]);
    $('#receipt-out').hidden = false;
    $('#receipt-out textarea').value = receipt;
    log(`Sent ${form.amount.value} ${t.symbol} privately (${anonymous ? 'anonymous' : 'confidential'})`, hashes);
    showPublic(form, anonymous
      ? [`${anon.who} submitted a transaction that paid a ${fromUnits(anon.fee, t.decimals)} ${t.symbol} fee.`, 'Not visible: you, the recipient, the amount.']
      : [`Account <code>${nearAccount}</code> submitted a shielded transaction.`, 'Not visible: token, amount, recipient.']);
  });
}

async function onWithdraw(form) {
  const token = form.token.value, t = tokenOf(token);
  const amount = toUnits(form.amount.value, t.decimals);
  const anonymous = form.ring.value === 'anonymous';
  await run('Withdraw', async () => {
    const recipient = form.recipient.value.trim();
    const anon = anonymous ? await sendAnonymous(token, (opts) => sw.withdraw(token, amount, recipient, opts)) : null;
    const hashes = anon ? anon.hashes : await signAndSend([await sw.withdraw(token, amount, recipient)]);
    log(`Withdrew ${form.amount.value} ${t.symbol} to ${recipient}`, hashes);
    showPublic(form, [`<code>${recipient}</code> received ${form.amount.value} ${t.symbol} from the pool.`, anonymous ? `${anon.who} submitted it.` : '', anonymous ? 'Not visible: which shielded balance paid it.' : `Also visible: <code>${nearAccount}</code> submitted it.`]);
  });
}

const encodeCode = encodeJson;
const decodeCode = decodeJson;
function showCode(label, code) {
  const box = $('#swap-out');
  box.hidden = false;
  $('label', box).textContent = label;
  $('textarea', box).value = code;
}

async function onOffer(form) {
  const give = form.give.value, want = form.want.value;
  if (give === want) return log('Swap: pick two different tokens', [], true);
  try {
    const giveAmt = toUnits(form.giveAmount.value, tokenOf(give).decimals);
    const wantAmt = toUnits(form.wantAmount.value, tokenOf(want).decimals);
    if (sw.balance(give) < giveAmt) throw new Error('insufficient shielded balance');
    const offer = sw.createOffer(give, giveAmt, want, wantAmt, { validUntil: (await blockHeight()) + SWAP_TTL_BLOCKS });
    const p = sw.pendingOffer;
    store.set(OFFER_STORE, { giveToken: p.giveToken, giveAmount: p.giveAmount.toString(), validUntil: p.validUntil.toString(), want: { amount: p.want.amount.toString(), blinding: p.want.blinding.toString(), asset: p.want.asset.toString() } });
    saveExpected();
    showCode('Offer code: send this to the taker', encodeCode(offer));
    log(`Created offer: ${form.giveAmount.value} ${tokenOf(give).symbol} for ${form.wantAmount.value} ${tokenOf(want).symbol}`);
  } catch (e) {
    log(`Swap offer: ${e.message}`, [], true);
  }
}

async function onTake(form) {
  await run('Take offer', async () => {
    const offer = decodeCode(form.code.value);
    if (BigInt(offer.validUntil) <= (await blockHeight())) throw new Error('offer expired');
    const res = await sw.takeOffer(offer);
    saveExpected();
    showCode('Response code: send this back to the maker', encodeCode(res));
    log(`Accepted offer: pay ${fromUnits(BigInt(offer.want.amount), 24)} ${tokenOf(offer.want.token)?.symbol}, receive ${fromUnits(BigInt(offer.give.amount), 24)} ${tokenOf(offer.give.token)?.symbol}`);
  });
}

async function onComplete(form) {
  await run('Settle swap', async () => {
    if (!sw.pendingOffer) {
      const s = store.get(OFFER_STORE);
      if (!s) throw new Error('no open offer in this browser');
      sw.pendingOffer = { giveToken: s.giveToken, giveAmount: BigInt(s.giveAmount), validUntil: BigInt(s.validUntil), want: new Note({ amount: BigInt(s.want.amount), blinding: BigInt(s.want.blinding), asset: BigInt(s.want.asset), keypair: sw.keypair }) };
    }
    const call = await sw.completeOffer(decodeCode(form.code.value));
    const hashes = relayerInfo ? await relay(call) : await signAndSend([call]);
    store.set(OFFER_STORE, null);
    sw.pendingOffer = null;
    log('Swap settled atomically', hashes);
    showPublic($('[data-panel=swap]'), [relayerInfo ? `Relayer <code>${relayerInfo.relayer}</code> submitted a swap.` : `<code>${nearAccount}</code> submitted a swap.`, 'Not visible: either token, either amount, either party.']);
  });
}

async function onVerifyReceipt(form) {
  const out = $('#verify-out');
  try {
    const r = await verifyReceipt(pool, form.receipt.value.trim());
    const t = tokenOf(r.token);
    const what = `${fromUnits(r.amount, t?.decimals ?? 24)} ${t?.symbol ?? r.token} to <code>${r.to.slice(0, 14)}…${r.to.slice(-6)}</code>`;
    out.innerHTML = r.valid
      ? `<b>Valid</b><div>The pool holds a note of exactly ${what} (leaf ${r.index}).</div><div>Not revealed: who paid, or anything else either side did.</div>`
      : `<b>Not found</b><div>No note of ${what} is in the pool. The receipt is wrong, altered, or its payment has not settled.</div>`;
  } catch (e) {
    out.innerHTML = `<b>Not a valid receipt</b><div>${String(e.message ?? e).replace(/</g, '&lt;')}</div>`;
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  $('#network').textContent = NETWORK;
  $('#network').classList.toggle('mainnet', NETWORK === 'mainnet');
  $('#contract-link').href = `${EXPLORER}/address/${CONTRACT}`;
  $('#contract-link').textContent = CONTRACT;
  for (const sel of $$('select')) sel.innerHTML = TOKENS.map((t) => `<option value="${t.id}">${t.symbol}</option>`).join('');
  $('#swap-offer').want.value = WRAP;

  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  }));
  const on = (sel, fn) => $(sel).addEventListener('submit', (e) => { e.preventDefault(); fn(e.target); });
  on('[data-panel=deposit]', onDeposit);
  on('[data-panel=send]', onSend);
  on('[data-panel=withdraw]', onWithdraw);
  on('#swap-offer', onOffer);
  on('#swap-take', onTake);
  on('#swap-complete', onComplete);
  on('#verify-receipt', onVerifyReceipt);
  $('#show-view').addEventListener('click', () => { const o = $('#view-out'); o.hidden = !o.hidden; o.textContent = sw.keypair.viewingKey(); });
  $('#copy-view').addEventListener('click', () => navigator.clipboard.writeText(sw.keypair.viewingKey()));
  $('#receipt-copy').addEventListener('click', () => navigator.clipboard.writeText($('#receipt-out textarea').value));
  $('#sync').addEventListener('click', sync);
  $('#copy-address').addEventListener('click', () => navigator.clipboard.writeText(sw.keypair.address()));
  $('#swap-copy').addEventListener('click', () => navigator.clipboard.writeText($('#swap-out textarea').value));
  $('#export-key').addEventListener('click', () => { const o = $('#key-out'); o.hidden = !o.hidden; o.textContent = sw.viewOnly ? 'This browser holds a viewing key only.' : sw.keypair.privKey.toString(16); });
  $('#import-key').addEventListener('click', async () => {
    const k = prompt('Paste a shielded key (hex), or a viewing key (nprview…) to open a view-only wallet. This replaces the key in this browser.');
    if (!k || !/^([0-9a-f]{1,64}|nprview[0-9a-f]{128})$/i.test(k.trim())) return;
    try { localStorage.setItem(KEY_STORE, k.trim().toLowerCase()); } catch {}
    location.reload();
  });

  selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet(), setupIntearWallet(), setupHereWallet(), setupMyNearWallet()] });
  modal = setupModal(selector, { contractId: CONTRACT });
  const refreshAccount = () => {
    nearAccount = selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
    $('#connect').textContent = nearAccount ?? 'Connect wallet';
  };
  selector.store.observable.subscribe(refreshAccount);
  refreshAccount();
  $('#connect').addEventListener('click', async () => {
    if (!nearAccount) return modal.show();
    if (confirm(`Disconnect ${nearAccount}?`)) await (await selector.wallet()).signOut();
  });

  fetch(`${RELAYER_URL}/info`).then((r) => r.json()).then((i) => {
    relayerInfo = i;
    for (const f of $$('.fee')) f.textContent = OPEN ? '(0.02 fee, reveals the token; NEAR needs no relayer)' : `(fee ${fromUnits(BigInt(i.minFee.near), 24, 3)} NEAR or wNEAR, reveals which)`;
  }).catch(() => {
    for (const f of $$('.fee')) f.textContent = OPEN ? '(0.02 NEAR fee, no relayer; relayer for wNEAR is offline)' : '(relayer offline)';
  });

  busy('Loading proving key (12 MB, once)…');
  await initCrypto();
  sw = new ShieldedWallet(loadKeypair(), pool, await loadArtifacts());
  sw.restoreExpected(store.get(EXPECTED_STORE) ?? []);
  $('#viewonly').hidden = !sw.viewOnly;
  $('#address').textContent = sw.keypair.address();
  busy(false);
  await sync();
}

boot().catch((e) => { console.error(e); log(`Startup failed: ${e.message ?? e}`, [], true); busy(false); });
