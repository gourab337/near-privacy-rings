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
import { Buffer, initCrypto, Keypair, Note, assetId, ShieldedWallet } from '../../sdk/src/index.js';

// ------------------------------------------------------------------ config
const NETWORK = import.meta.env.VITE_NETWORK ?? 'testnet';
const CONTRACT = import.meta.env.VITE_CONTRACT ?? 'npr-pool-65673.testnet';
const RELAYER_URL = import.meta.env.VITE_RELAYER_URL ?? 'http://localhost:8787';
const RPC = import.meta.env.VITE_RPC ?? (NETWORK === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
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

// ------------------------------------------------------------------ shielded wallet
let sw;
async function loadArtifacts() {
  const [wasm, zkey] = await Promise.all(['./transaction2x2.wasm', './transaction2x2.zkey'].map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
  return { wasm, zkey };
}
function loadKeypair() {
  let k = null;
  try { k = localStorage.getItem(KEY_STORE); } catch {}
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
  $('#balances').innerHTML = TOKENS.map((t) => `<div><b>${fromUnits(sw.balance(t.id), t.decimals)}</b><span>${t.symbol} · ${sw.notes.filter((n) => n.asset === assetId(t.id)).length} notes</span></div>`).join('');
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
  $('.public', panel).innerHTML = `<b>What the chain sees</b>${rows.map((r) => `<div>${r}</div>`).join('')}`;
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
    const fee = anonymous ? minFee(token) : 0n;
    if (anonymous && fee === null) throw new Error('relayer offline or token not accepted');
    const call = await sw.transfer(token, amount, form.to.value.trim(), anonymous ? { relayer: relayerInfo.relayer, fee } : {});
    const hashes = anonymous ? await relay(call) : await signAndSend([call]);
    log(`Sent ${form.amount.value} ${t.symbol} privately (${anonymous ? 'anonymous' : 'confidential'})`, hashes);
    showPublic(form, anonymous
      ? [`Relayer <code>${relayerInfo.relayer}</code> submitted a transaction and was paid a ${fromUnits(fee, t.decimals)} ${t.symbol} fee.`, 'Not visible: you, the recipient, the amount.']
      : [`Account <code>${nearAccount}</code> submitted a shielded transaction.`, 'Not visible: token, amount, recipient.']);
  });
}

async function onWithdraw(form) {
  const token = form.token.value, t = tokenOf(token);
  const amount = toUnits(form.amount.value, t.decimals);
  const anonymous = form.ring.value === 'anonymous';
  await run('Withdraw', async () => {
    const recipient = form.recipient.value.trim();
    const fee = anonymous ? minFee(token) : 0n;
    if (anonymous && fee === null) throw new Error('relayer offline or token not accepted');
    const call = await sw.withdraw(token, amount, recipient, anonymous ? { relayer: relayerInfo.relayer, fee } : {});
    const hashes = anonymous ? await relay(call) : await signAndSend([call]);
    log(`Withdrew ${form.amount.value} ${t.symbol} to ${recipient}`, hashes);
    showPublic(form, [`<code>${recipient}</code> received ${form.amount.value} ${t.symbol} from the pool${anonymous ? ` via relayer <code>${relayerInfo.relayer}</code>` : ''}.`, anonymous ? 'Not visible: which shielded balance paid it.' : `Also visible: <code>${nearAccount}</code> submitted it.`]);
  });
}

const encodeCode = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const decodeCode = (s) => JSON.parse(Buffer.from(s.trim(), 'base64url').toString());
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
  $('#sync').addEventListener('click', sync);
  $('#copy-address').addEventListener('click', () => navigator.clipboard.writeText(sw.keypair.address()));
  $('#swap-copy').addEventListener('click', () => navigator.clipboard.writeText($('#swap-out textarea').value));
  $('#export-key').addEventListener('click', () => { const o = $('#key-out'); o.hidden = !o.hidden; o.textContent = sw.keypair.privKey.toString(16); });
  $('#import-key').addEventListener('click', async () => {
    const k = prompt('Paste a shielded key (hex). This replaces the key in this browser.');
    if (!k || !/^[0-9a-f]{1,64}$/i.test(k.trim())) return;
    try { localStorage.setItem(KEY_STORE, k.trim().toLowerCase()); } catch {}
    location.reload();
  });

  selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet(), setupIntearWallet(), setupHereWallet(), setupMyNearWallet()] });
  modal = setupModal(selector, { contractId: CONTRACT });
  const refreshAccount = () => {
    nearAccount = selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null;
    $('#connect').textContent = nearAccount ?? 'Connect NEAR wallet';
  };
  selector.store.observable.subscribe(refreshAccount);
  refreshAccount();
  $('#connect').addEventListener('click', async () => {
    if (!nearAccount) return modal.show();
    if (confirm(`Disconnect ${nearAccount}?`)) await (await selector.wallet()).signOut();
  });

  fetch(`${RELAYER_URL}/info`).then((r) => r.json()).then((i) => {
    relayerInfo = i;
    for (const f of $$('.fee')) f.textContent = `(fee ${fromUnits(BigInt(i.minFee.near), 24, 3)} NEAR or wNEAR, reveals which)`;
  }).catch(() => {
    for (const f of $$('.fee')) f.textContent = '(relayer offline)';
  });

  busy('Loading proving key (12 MB, once)…');
  await initCrypto();
  sw = new ShieldedWallet(loadKeypair(), pool, await loadArtifacts());
  sw.restoreExpected(store.get(EXPECTED_STORE) ?? []);
  $('#address').textContent = sw.keypair.address();
  busy(false);
  await sync();
}

boot().catch((e) => { console.error(e); log(`Startup failed: ${e.message ?? e}`, [], true); busy(false); });
