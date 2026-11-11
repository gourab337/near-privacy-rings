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
const pick = (files) => Object.entries(files).find(([f, o]) => f.endsWith(`/${NETWORK}.json`) && o.pool === CONTRACT)?.[1] ?? null;
// open ring: published function-call keys of a gas account (README, "Open ring")
const OPEN = pick(import.meta.glob('../../open-ring/*.json', { eager: true, import: 'default' }));
// demo mode: pre-funded testnet sessions and the shielded keys of Alice and Bob, published on purpose
const DEMO = pick(import.meta.glob('../../demo/*.json', { eager: true, import: 'default' }));
const WRAP = NETWORK === 'mainnet' ? 'wrap.near' : 'wrap.testnet';
const TOKENS = [
  { id: 'near', symbol: 'NEAR', decimals: 24 },
  { id: WRAP, symbol: 'wNEAR', decimals: 24 },
];
const EXPLORER_URL = NETWORK === 'mainnet' ? 'https://nearblocks.io' : 'https://testnet.nearblocks.io';
const GAS = 300_000_000_000_000n;
const ns = `${NETWORK}:${CONTRACT}`;
const KEY_STORE = `npr:key:${ns}`;
const OFFER_STORE = `npr:offer:${ns}`;
const EXPECTED_STORE = `npr:expected:${ns}`;
const ACTIVITY_STORE = `npr:activity:${ns}`;
const SWAP_TTL_BLOCKS = 1200n; // ~15-20 minutes
const AMOUNTS = ['0.01', '0.05', '0.1'];

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const tokenOf = (id) => TOKENS.find((t) => t.id === id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const short = (s, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);

// ------------------------------------------------------------------ amounts
function toUnits(str, decimals = 24) {
  const s = String(str).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error('invalid amount');
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error('too many decimals');
  const v = BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
  if (v <= 0n) throw new Error('amount must be positive');
  return v;
}
function fromUnits(v, decimals = 24, shown = 4) {
  const d = 10n ** BigInt(decimals);
  const frac = (v % d).toString().padStart(decimals, '0').slice(0, shown);
  return `${v / d}.${frac}`;
}

// ------------------------------------------------------------------ chain access
async function rpc(method, params) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error));
  return j.result;
}
async function view(method, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: method.contract ?? CONTRACT, method_name: method.name ?? method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(r.result).toString());
}
const pool = { contractId: CONTRACT, view: (m, a) => view(m, a) };
const blockHeight = async () => BigInt((await rpc('block', { finality: 'final' })).header.height);
const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } },
  set: (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const saveExpected = () => store.set(EXPECTED_STORE, sw.expectedState());

let selector, modal, nearAccount = null, relayerInfo = null;

async function signAndSend(calls) {
  if (!nearAccount) {
    modal.show();
    throw new Error('connect a testnet wallet first, then try again');
  }
  const wallet = await selector.wallet();
  const transactions = calls.map((c) => ({ receiverId: c.receiverId, actions: [actionCreators.functionCall(c.method, c.args, GAS, BigInt(c.deposit ?? 0n))] }));
  const res = await wallet.signAndSendTransactions({ transactions });
  return (res ?? []).map((o) => o?.transaction?.hash).filter(Boolean);
}

async function relay(call) {
  if (!relayerInfo) throw new Error('the relayer is offline');
  const r = await fetch(`${RELAYER_URL}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiverId: call.receiverId, method: call.method, args: call.args }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`relayer: ${j.error}`);
  return [j.txHash];
}

/**
 * Anonymous submission. NEAR goes through the open ring (signed here with a published key:
 * no relayer, no wallet); anything else, or an open ring that fails, falls back to the relayer.
 */
async function sendAnonymous(token, build) {
  const routes = [];
  if (OPEN && token === 'near') {
    const { provider } = poolClient(CONTRACT, NETWORK, RPC);
    routes.push({ opts: { relayer: OPEN.account, fee: OPEN_FEE }, fee: OPEN_FEE, via: OPEN.account, send: async (c) => [await sendOpen(provider, OPEN, c)] });
  }
  const f = relayerInfo?.minFee?.[token] ? BigInt(relayerInfo.minFee[token]) : null;
  if (f !== null) routes.push({ opts: { relayer: relayerInfo.relayer, fee: f }, fee: f, via: relayerInfo.relayer, send: relay });
  if (!routes.length) throw new Error('no anonymous route for this token right now');
  let last;
  for (const r of routes) {
    try {
      const call = await build(r.opts);
      return { hashes: await r.send(call), via: r.via, fee: r.fee, call };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ------------------------------------------------------------------ wallet + session
let sw;
async function loadArtifacts() {
  const [wasm, zkey] = await Promise.all(['./transaction2x2.wasm', './transaction2x2.zkey'].map(async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())));
  return { wasm, zkey };
}
// filled in boot(), after initCrypto: keypairs need Poseidon
const people = {};
const personByAddress = (addr) => Object.values(people).find((p) => p.keypair.address() === addr);
const personByAccount = (acc) => Object.values(people).find((p) => p.account === acc);

/** A demo session: a published, pre-funded testnet key. Picks one that still has money. */
async function pickDemoSession(artifacts) {
  const keys = [...DEMO.sessions].sort(() => Math.random() - 0.5);
  for (const k of keys.slice(0, 6)) {
    const w = new ShieldedWallet(new Keypair(BigInt('0x' + k)), pool, artifacts);
    busy('Finding a funded demo wallet…');
    await w.sync();
    if (w.balance('near') >= toUnits('0.05')) return k;
  }
  return null;
}
function loadKeypair(k) {
  if (k?.startsWith('nprview')) return Keypair.fromViewingKey(k); // auditor: view-only
  return new Keypair(BigInt('0x' + k));
}

async function sync() {
  busy('Reading your private balance…');
  try {
    await sw.sync();
    saveExpected();
    renderBalances();
  } finally {
    busy(false);
  }
}

function renderBalances() {
  const near = sw.balance('near');
  $('#total').textContent = fromUnits(near + sw.balance(WRAP));
  $('#tokens').innerHTML = TOKENS.map((t) => {
    const n = sw.notes.filter((x) => x.asset === assetId(t.id)).length;
    return `<div class="tok"><span class="ico">${t.symbol === 'NEAR' ? 'Ⓝ' : 'w'}</span><div><b>${t.symbol}</b><span>${sw.viewOnly ? 'received' : 'private'} · ${n} note${n === 1 ? '' : 's'}</span></div><strong>${fromUnits(sw.balance(t.id), t.decimals)}</strong></div>`;
  }).join('');
}

// ------------------------------------------------------------------ ui helpers
function busy(text) {
  $('#busy').hidden = !text;
  if (text) $('#busy-text').textContent = text;
  $$('button[type=submit]').forEach((b) => (b.disabled = !!text));
}
function toast(text, err = false) {
  const t = document.createElement('div');
  t.className = `toast${err ? ' err' : ''}`;
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 7000 : 4000);
}
async function run(label, fn) {
  try {
    busy('Making a zero-knowledge proof in your browser…');
    await fn();
  } catch (e) {
    console.error(e);
    toast(`${label}: ${e.message ?? e}`, true);
  } finally {
    busy(false);
  }
  try { await sync(); } catch {}
}

/** Chip groups: `[data-chips]` gets buttons; the chosen value is read with chipValue(). */
function chips(el, options, onPick) {
  el.innerHTML = options.map((o, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-v="${esc(o.value)}">${o.label}</button>`).join('');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    $$('.chip', el).forEach((x) => x.classList.toggle('on', x === b));
    onPick?.(b.dataset.v);
  });
}
const chipValue = (form, name) => $(`[data-chips=${name}] .chip.on`, form)?.dataset.v;

// ------------------------------------------------------------------ ring explorer
const activity = () => store.get(ACTIVITY_STORE) ?? [];
function addActivity(a) {
  store.set(ACTIVITY_STORE, [a, ...activity()].slice(0, 30));
  renderExplorer(a.hash);
}
function ago(t) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
const ICON = { send: '→', withdraw: '↗', deposit: '↓', swap: '⇄' };
function renderExplorer(open) {
  const list = activity();
  if (!list.length) return;
  $('#explorer').innerHTML = list.map((a) => `
    <li class="entry${a.hash === open ? ' open' : ''}" data-hash="${a.hash}">
      <button class="head" type="button">
        <span class="ico">${ICON[a.kind]}</span>
        <span class="what"><b>${esc(a.title)}</b><span class="mono">${short(a.hash, 4, 4)} · ${ago(a.time)}</span></span>
        <span class="amt ${a.kind === 'send' ? 'blur' : ''}">${a.amount} ${a.symbol}</span>
      </button>
      <div class="views" ${a.hash === open ? '' : 'hidden'}>
        <div class="label">See what each party sees</div>
        <div class="vtabs">${partiesOf(a).map((p, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-party="${p.id}">${p.label}</button>`).join('')}</div>
        <div class="vbody"></div>
      </div>
    </li>`).join('');
  if (open) showParty($(`.entry[data-hash="${open}"]`), partiesOf(list.find((a) => a.hash === open))[0].id);
}
function partiesOf(a) {
  const p = [{ id: 'public', label: 'Public' }, { id: 'you', label: 'You' }];
  if (a.kind === 'send' && a.toName) p.push({ id: 'recipient', label: a.toName });
  if (a.kind === 'withdraw') p.push({ id: 'recipient', label: a.toName ?? 'Recipient' });
  return p;
}
const row = (k, v, cls = '') => `<div class="kv"><span>${k}</span><b class="${cls}">${v}</b></div>`;
const HIDDEN = '<i class="hid">hidden</i>';

async function showParty(li, party) {
  const a = activity().find((x) => x.hash === li.dataset.hash);
  $$('.vtabs button', li).forEach((b) => b.classList.toggle('on', b.dataset.party === party));
  const body = $('.vbody', li);
  if (party === 'you') {
    body.innerHTML = [
      row('Action', esc(a.title)),
      row('Amount', `${a.amount} ${a.symbol}`),
      row('Fee', `${a.fee} NEAR`),
      a.receipt ? `<div class="kv col"><span>Your receipt (proves this one payment)</span><textarea readonly rows="2">${a.receipt}</textarea></div>` : '',
      `<p class="foot">Only your browser knows this. It is not written anywhere on-chain.</p>`,
    ].join('');
    return;
  }
  if (party === 'recipient' && a.kind === 'send') {
    // decrypt the payment the way the recipient's own wallet does, with their key
    body.innerHTML = '<p class="foot">Decrypting with ' + esc(a.toName) + "'s key…</p>";
    const p = people[a.toName.toLowerCase()];
    const leaves = await view('get_leaves', { from_index: Math.max(0, a.firstLeaf ?? 0), limit: 200 });
    let found = null;
    leaves.forEach((l, i) => {
      if (found || l.commitment !== a.commitment) return;
      const n = Note.decrypt(p.keypair, Buffer.from(l.encrypted_output, 'base64'), (a.firstLeaf ?? 0) + i);
      if (n && n.commitment() === BigInt('0x' + l.commitment)) found = n;
    });
    body.innerHTML = found
      ? [row(`${esc(a.toName)}'s wallet found`, `${fromUnits(found.amount)} NEAR`), row('From', '<i class="hid">unknown</i>'),
        `<p class="foot">This was decrypted just now, in this page, with ${esc(a.toName)}'s key (a demo key). Even ${esc(a.toName)} cannot tell who paid: the note carries no sender. On Helius's Solana rings the sender and recipient are public; here both are hidden.</p>`].join('')
      : '<p class="foot">Not found yet: the payment may still be settling. Try again in a few seconds.</p>';
    return;
  }
  if (party === 'recipient' && a.kind === 'withdraw') {
    body.innerHTML = [row('Received', `${a.amount} ${a.symbol}`), row('Into', `<span class="mono">${esc(a.recipient)}</span>`), row('From', 'the privacy pool'), row('Whose balance paid', '<i class="hid">unknown</i>'),
      `<p class="foot">${esc(a.toName ?? 'The recipient')} sees a normal payment from the pool contract, like any other NEAR transfer.</p>`].join('');
    return;
  }
  // public: read the transaction back from the chain
  body.innerHTML = '<p class="foot">Reading the transaction from the NEAR RPC…</p>';
  try {
    const tx = (await rpc('tx', { tx_hash: a.hash, sender_account_id: a.signer, wait_until: 'FINAL' })).transaction;
    const fc = tx.actions[0].FunctionCall;
    const args = JSON.parse(Buffer.from(fc.args, 'base64').toString());
    const ext = args.ext_data ?? {};
    const shared = tx.signer_id === OPEN?.account;
    const rows = [
      row('Signed by', `<span class="mono">${esc(tx.signer_id)}</span>${shared ? ' <em class="tag">shared public key: everyone uses it</em>' : ''}`),
      row('Called', `<span class="mono">${esc(fc.method_name)}</span> on the pool, ${fc.deposit === '0' ? 'with no NEAR attached' : `with ${fromUnits(BigInt(fc.deposit))} NEAR attached`}`),
    ];
    if (a.kind === 'send') {
      rows.push(row('Sender', HIDDEN), row('Recipient', HIDDEN), row('Amount', HIDDEN), row('Token', `NEAR <em class="tag">shown by the ${fromUnits(BigInt(ext.fee), 24, 2)} NEAR fee</em>`));
    } else if (a.kind === 'withdraw') {
      rows.push(row('Sender', HIDDEN), row('Recipient', `<span class="mono">${esc(ext.recipient)}</span>`), row('Amount', `${fromUnits(-BigInt(ext.ext_amount))} ${a.symbol}`));
    } else if (a.kind === 'deposit') {
      rows.push(row('Depositor', `<span class="mono">${esc(tx.signer_id)}</span>`), row('Amount', `${a.amount} ${a.symbol}`), row('Which private note it became', HIDDEN));
    }
    const proof = args.args ?? JSON.parse(args.msg ?? '{}').args;
    if (proof) rows.push(`<div class="kv col"><span>What the contract stores</span><code class="blob">nullifiers ${short(proof.input_nullifiers[0], 8, 6)}, ${short(proof.input_nullifiers[1], 8, 6)}\nnew notes  ${short(proof.output_commitments[0], 8, 6)}, ${short(proof.output_commitments[1], 8, 6)}\nencrypted  2 × 152 bytes · proof 256 bytes</code></div>`);
    rows.push(`<p class="foot">Read live from the chain. <a href="${EXPLORER_URL}/txns/${a.hash}" target="_blank" rel="noopener">Open in explorer ↗</a></p>`);
    body.innerHTML = rows.join('');
  } catch (e) {
    body.innerHTML = `<p class="foot">Could not read the transaction yet (${esc(e.message ?? e)}). Try again in a few seconds.</p>`;
  }
}

// ------------------------------------------------------------------ actions
function recipientAddress(form) {
  const v = chipValue(form, 'to');
  if (v === 'other') return Keypair.parseAddress(form.toCustom.value.trim()) && form.toCustom.value.trim();
  return people[v].keypair.address();
}

async function onSend(form) {
  const amount = toUnits(chipValue(form, 'amount'));
  const to = (() => { try { return recipientAddress(form); } catch (e) { toast(`Send: ${e.message}`, true); return null; } })();
  if (!to) return;
  await run('Send', async () => {
    let receipt;
    const r = await sendAnonymous('near', async (opts) => { const c = await sw.transfer('near', amount, to, opts); receipt = c.receipt; return c; });
    const who = personByAddress(to);
    const first = r.call.args.args.output_commitments[0];
    addActivity({ kind: 'send', hash: r.hashes[0], signer: r.via, time: Date.now(), title: `Private transfer: You → ${who?.name ?? short(to, 7, 4)}`, amount: fromUnits(amount), symbol: 'NEAR', fee: fromUnits(r.fee, 24, 2), toName: who?.name, commitment: first, firstLeaf: Math.max(0, sw.tree.size - 2), receipt });
    toast(`Sent ${fromUnits(amount)} NEAR privately`);
  });
}

async function onWithdraw(form) {
  const amount = toUnits(chipValue(form, 'amount'));
  const v = chipValue(form, 'recipient');
  const recipient = v === 'other' ? form.recipientCustom.value.trim() : people[v].account;
  if (!recipient) return toast('Withdraw: enter an account', true);
  await run('Withdraw', async () => {
    const r = await sendAnonymous('near', (opts) => sw.withdraw('near', amount, recipient, opts));
    addActivity({ kind: 'withdraw', hash: r.hashes[0], signer: r.via, time: Date.now(), title: `Withdrawal: You → ${personByAccount(recipient)?.name ?? recipient}`, amount: fromUnits(amount), symbol: 'NEAR', fee: fromUnits(r.fee, 24, 2), toName: personByAccount(recipient)?.name, recipient });
    toast(`Withdrew ${fromUnits(amount)} NEAR to ${recipient}`);
  });
}

async function onDeposit(form) {
  const amount = toUnits(chipValue(form, 'amount'));
  await run('Deposit', async () => {
    const calls = await sw.deposit('near', amount);
    busy('Confirm in your wallet…');
    const hashes = await signAndSend(calls);
    addActivity({ kind: 'deposit', hash: hashes[0], signer: nearAccount, time: Date.now(), title: `Deposit: ${nearAccount} → private balance`, amount: fromUnits(amount), symbol: 'NEAR', fee: '0.01' });
    toast(`Deposited ${fromUnits(amount)} NEAR`);
  });
}

function showCode(label, code) {
  const box = $('#swap-out');
  box.hidden = false;
  $('label', box).textContent = label;
  $('textarea', box).value = code;
}
async function onOffer(form) {
  const give = form.give.value, want = form.want.value;
  if (give === want) return toast('Swap: pick two different tokens', true);
  try {
    const giveAmt = toUnits(form.giveAmount.value), wantAmt = toUnits(form.wantAmount.value);
    if (sw.balance(give) < giveAmt) throw new Error('not enough private balance');
    const offer = sw.createOffer(give, giveAmt, want, wantAmt, { validUntil: (await blockHeight()) + SWAP_TTL_BLOCKS });
    const p = sw.pendingOffer;
    store.set(OFFER_STORE, { giveToken: p.giveToken, giveAmount: p.giveAmount.toString(), validUntil: p.validUntil.toString(), want: { amount: p.want.amount.toString(), blinding: p.want.blinding.toString(), asset: p.want.asset.toString() } });
    saveExpected();
    showCode('Offer code: send this to the other person', encodeJson(offer));
  } catch (e) {
    toast(`Swap: ${e.message}`, true);
  }
}
async function onTake(form) {
  await run('Accept offer', async () => {
    const offer = decodeJson(form.code.value);
    if (BigInt(offer.validUntil) <= (await blockHeight())) throw new Error('offer expired');
    const res = await sw.takeOffer(offer);
    saveExpected();
    showCode('Reply code: send this back', encodeJson(res));
  });
}
async function onComplete(form) {
  await run('Settle swap', async () => {
    if (!sw.pendingOffer) {
      const s = store.get(OFFER_STORE);
      if (!s) throw new Error('no open offer in this browser');
      sw.pendingOffer = { giveToken: s.giveToken, giveAmount: BigInt(s.giveAmount), validUntil: BigInt(s.validUntil), want: new Note({ amount: BigInt(s.want.amount), blinding: BigInt(s.want.blinding), asset: BigInt(s.want.asset), keypair: sw.keypair }) };
    }
    const call = await sw.completeOffer(decodeJson(form.code.value));
    const hashes = relayerInfo ? await relay(call) : await signAndSend([call]);
    store.set(OFFER_STORE, null);
    sw.pendingOffer = null;
    addActivity({ kind: 'swap', hash: hashes[0], signer: relayerInfo?.relayer ?? nearAccount, time: Date.now(), title: 'Private swap', amount: '', symbol: '', fee: '0' });
  });
}
async function onVerifyReceipt(form) {
  const out = $('#verify-out');
  try {
    const r = await verifyReceipt(pool, form.receipt.value.trim());
    const t = tokenOf(r.token);
    const who = personByAddress(r.to)?.name ?? `<span class="mono">${short(r.to, 10, 6)}</span>`;
    out.innerHTML = r.valid
      ? `<b class="ok">Valid</b> The pool holds a payment of exactly ${fromUnits(r.amount, t?.decimals ?? 24)} ${t?.symbol ?? r.token} to ${who}. Nothing else is revealed: not who paid, not anything else either side did.`
      : `<b class="bad">Not found</b> No such payment is in the pool. The receipt is wrong, altered, or not settled yet.`;
  } catch (e) {
    out.innerHTML = `<b class="bad">Not a valid receipt</b> ${esc(e.message ?? e)}`;
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  $('#network').textContent = NETWORK;
  $('#contract-link').href = `${EXPLORER_URL}/address/${CONTRACT}`;
  $('#contract-link').textContent = CONTRACT;
  for (const sel of $$('select')) sel.innerHTML = TOKENS.map((t) => `<option value="${t.id}">${t.symbol}</option>`).join('');
  $('#swap-offer').want.value = WRAP;

  await initCrypto();
  if (DEMO) for (const [name, p] of Object.entries(DEMO.people)) people[name] = { name: name[0].toUpperCase() + name.slice(1), account: p.account, keypair: new Keypair(BigInt('0x' + p.key)) };
  const names = Object.values(people);
  const toChips = [...names.map((p) => ({ value: p.name.toLowerCase(), label: `${p.name} <span class="mono">${short(p.keypair.address(), 5, 4)}</span>` })), { value: 'other', label: 'Other address' }];
  chips($('[data-chips=to]'), toChips, (v) => ($('[name=toCustom]').hidden = v !== 'other'));
  const acctChips = [...names.map((p) => ({ value: p.name.toLowerCase(), label: `${p.name} <span class="mono">${short(p.account, 6, 8)}</span>` })), { value: 'other', label: 'Other account' }];
  chips($('[data-chips=recipient]'), acctChips, (v) => ($('[name=recipientCustom]').hidden = v !== 'other'));
  for (const el of $$('[data-chips=amount]')) chips(el, AMOUNTS.map((a) => ({ value: a, label: `${a} NEAR` })));

  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    $$('.seg button').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
  }));
  const on = (sel, fn) => $(sel).addEventListener('submit', (e) => { e.preventDefault(); fn(e.target); });
  on('[data-panel=send]', onSend);
  on('[data-panel=withdraw]', onWithdraw);
  on('[data-panel=deposit]', onDeposit);
  on('#swap-offer', onOffer);
  on('#swap-take', onTake);
  on('#swap-complete', onComplete);
  on('#verify-receipt', onVerifyReceipt);
  $('#explorer').addEventListener('click', (e) => {
    const li = e.target.closest('.entry');
    if (!li) return;
    const tab = e.target.closest('[data-party]');
    if (tab) return showParty(li, tab.dataset.party);
    if (e.target.closest('.head')) {
      const v = $('.views', li);
      v.hidden = !v.hidden;
      if (!v.hidden) showParty(li, 'public');
    }
  });
  $('#copy-address').addEventListener('click', () => navigator.clipboard.writeText(sw.keypair.address()));
  $('#swap-copy').addEventListener('click', () => navigator.clipboard.writeText($('#swap-out textarea').value));
  $('#show-view').addEventListener('click', () => { const o = $('#view-out'); o.hidden = !o.hidden; o.textContent = sw.keypair.viewingKey(); });
  $('#copy-view').addEventListener('click', () => navigator.clipboard.writeText(sw.keypair.viewingKey()));
  $('#export-key').addEventListener('click', () => { const o = $('#key-out'); o.hidden = !o.hidden; o.textContent = sw.viewOnly ? 'This browser holds a viewing key only.' : sw.keypair.privKey.toString(16); });
  $('#import-key').addEventListener('click', () => {
    const k = prompt('Paste a private key (hex), or a viewing key (nprview…) for view-only mode.');
    if (!k || !/^([0-9a-f]{1,64}|nprview[0-9a-f]{128})$/i.test(k.trim())) return;
    store.set(KEY_STORE, k.trim().toLowerCase());
    store.set(ACTIVITY_STORE, null);
    location.reload();
  });
  $('#new-session').addEventListener('click', () => {
    for (const k of [KEY_STORE, EXPECTED_STORE, ACTIVITY_STORE, OFFER_STORE]) store.set(k, null);
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
  fetch(`${RELAYER_URL}/info`).then((r) => r.json()).then((i) => (relayerInfo = i)).catch(() => {});

  busy('Loading the proving key (12 MB, once)…');
  await initCrypto();
  const artifacts = await loadArtifacts();
  let key = store.get(KEY_STORE);
  if (!key && DEMO) key = await pickDemoSession(artifacts);
  if (!key) key = new Keypair().privKey.toString(16);
  store.set(KEY_STORE, key);
  sw = new ShieldedWallet(loadKeypair(key), pool, artifacts);
  sw.restoreExpected(store.get(EXPECTED_STORE) ?? []);
  $('#viewonly').hidden = !sw.viewOnly;
  $('#address').textContent = sw.keypair.address();
  renderExplorer();
  busy(false);
  await sync();
}

boot().catch((e) => { console.error(e); toast(`Startup failed: ${e.message ?? e}`, true); busy(false); });
