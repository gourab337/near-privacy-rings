// Deposit from any chain (NEAR Intents 1Click): one widget for the Deposit tab (notes for this
// wallet) and for payment links (notes for someone else's private address). See sdk/src/intents.ts.
import { SOURCES, sourceInfo, quoteDeposit, depositStatus, walletLink, formatUnits, refundError } from '../../sdk/src/intents.ts';

const STATUS = {
  PENDING_DEPOSIT: 'Waiting for your deposit…',
  KNOWN_DEPOSIT_TX: 'Deposit seen. Waiting for confirmations…',
  PROCESSING: 'Swapping and delivering to the pool…',
  INCOMPLETE_DEPOSIT: 'Less than the quote arrived. It will be refunded to your address.',
  SUCCESS: 'Arrived.',
  REFUNDED: 'Refunded to your address.',
  FAILED: 'Failed. NEAR Intents refunds it to your address.',
};
const DONE = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const CHIPS = ['0.5', '1', '5'];
const MIN = 10n ** 23n; // 0.1 NEAR: below this, bridge minimums make quotes fail
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function xchainHtml({ amount = '', title = 'You receive privately', nearLogo, request = false }) {
  return `
    <div class="box line">
      <label class="box-top" for="x-amount"><span>${title}</span><span>Native NEAR</span></label>
      <div class="box-row"><input id="x-amount" name="xamount" class="amount" inputmode="decimal" autocomplete="off" size="1" placeholder="0" value="${esc(amount)}" /><span class="token">${nearLogo}NEAR</span></div>
      <div class="chips quick" data-xchips>${CHIPS.map((c) => `<button type="button" class="chip${c === amount ? ' on' : ''}" data-v="${c}">${c}</button>`).join('')}</div>
    </div>
    <div class="arrow" aria-hidden="true"><i class="ph ph-arrow-up"></i></div>
    <div class="box">
      <label class="box-top" for="x-src"><span>You pay with</span><span class="x-usd"></span></label>
      <div class="box-row"><span class="amount out x-in">–</span><select id="x-src" name="xsource" class="x-src">${SOURCES.map((s, i) => `<option value="${i}">${s.symbol} · ${s.chain}</option>`).join('')}</select></div>
    </div>
    <label class="x-refund"><span>Your <span class="x-chain">Solana</span> address, for refunds</span><input name="xrefund" autocomplete="off" spellcheck="false" /></label>
    <div class="fee-line x-fees"></div>
    <button type="submit" class="primary" data-label="Get deposit address">Get deposit address</button>
    ${request ? '<button type="button" class="ghost wide x-request"><i class="ph ph-link"></i> Copy a payment link for this amount</button>' : ''}
    <div class="x-pay" hidden></div>`;
}

/**
 * Wires a form rendered from xchainHtml.
 * opts: { pool, to?, wallet: async () => ShieldedWallet, toUnits, fromUnits, store?: {get,set,key},
 *         onSuccess(pending, status), onRequest?(amount), toast }
 */
export function wireXchain(form, opts) {
  const { toUnits, fromUnits } = opts;
  let info = null, timer = null, seq = 0;
  const $ = (s) => form.querySelector(s);
  const src = () => SOURCES[Number(form.xsource.value)];
  const amount = () => { try { return toUnits(form.xamount.value); } catch { return null; } };
  const setErr = (t) => { let e = $('.gate-err'); if (!e) { e = Object.assign(document.createElement('p'), { className: 'gate-err', role: 'alert' }); form.insertBefore(e, $('button[type=submit]')); } e.textContent = t; };

  const refreshChain = () => {
    $('.x-chain').textContent = src().chain;
    form.xrefund.placeholder = { solana: 'Solana address', evm: '0x…', btc: 'bc1…' }[src().refund];
  };
  async function price() {
    const my = ++seq, a = amount();
    $('.x-in').textContent = '–'; $('.x-usd').textContent = ''; $('.x-fees').innerHTML = '';
    if (a === null || a < MIN) { if (a !== null && a > 0n) $('.x-fees').innerHTML = row('Minimum', '0.1 NEAR'); return; }
    try {
      info ??= await sourceInfo();
      const s = src(), d = info[s.assetId];
      const q = (await quoteDeposit({ source: s, amountOut: a + 10n ** 22n, pool: opts.pool })).quote;
      if (my !== seq) return;
      $('.x-in').textContent = trim(formatUnits(q.amountIn, d.decimals), 6);
      $('.x-usd').textContent = `≈ $${Number(q.amountInUsd).toFixed(2)}`;
      $('.x-fees').innerHTML = row('Pool storage fee', '0.01 NEAR <small>included</small>') + row('NEAR Intents fee', '0.2% <small>included</small>') +
        row('Arrives', `~${Math.max(1, Math.round(q.timeEstimate / 60))} min after your deposit confirms`, 'fee-total');
    } catch (e) {
      if (my === seq) $('.x-fees').innerHTML = row('Quote', esc(e.message));
    }
  }
  let debounce;
  const reprice = () => { clearTimeout(debounce); debounce = setTimeout(price, 350); };
  form.xamount.addEventListener('input', () => { form.querySelectorAll('[data-xchips] .chip').forEach((c) => c.classList.toggle('on', c.dataset.v === form.xamount.value)); reprice(); });
  form.xsource.addEventListener('change', () => { refreshChain(); reprice(); });
  $('[data-xchips]').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (!b) return; form.xamount.value = b.dataset.v; form.xamount.dispatchEvent(new Event('input')); });
  $('.x-request')?.addEventListener('click', () => opts.onRequest?.(form.xamount.value.trim()));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = amount(), s = src(), refund = form.xrefund.value.trim();
    if (a === null || a < MIN) return setErr('Enter at least 0.1 NEAR.');
    const bad = refundError(s, refund);
    if (bad) return setErr(bad);
    setErr('');
    const btn = $('button[type=submit]');
    btn.disabled = true; btn.classList.add('is-busy'); btn.textContent = 'Proving in your browser…';
    try {
      info ??= await sourceInfo();
      const w = await opts.wallet();
      const d = await w.depositMsg('near', a, opts.to);
      btn.textContent = 'Getting a deposit address…';
      const q = (await quoteDeposit({ source: s, amountOut: d.total, pool: opts.pool, msg: d.msg, refundTo: refund, dry: false })).quote;
      const pending = { addr: q.depositAddress, amountIn: q.amountIn, decimals: info[s.assetId].decimals, src: Number(form.xsource.value), amount: a.toString(), deadline: q.deadline, to: opts.to ?? null, receipt: d.receipt ?? null };
      opts.store?.set(pending);
      show(pending);
    } catch (err) {
      console.error(err);
      setErr(err.message ?? String(err));
    } finally {
      btn.disabled = false; btn.classList.remove('is-busy'); btn.textContent = btn.dataset.label;
    }
  });

  function show(p) {
    // round up, never down: sending less than the quote gets refunded
    const s = SOURCES[p.src], dp = Math.min(p.decimals, 8), step = 10n ** BigInt(p.decimals - dp);
    const amt = formatUnits(((BigInt(p.amountIn) + step - 1n) / step) * step, p.decimals);
    const link = walletLink(s, p.addr, p.amountIn, p.decimals);
    form.classList.add('paying');
    const box = $('.x-pay');
    box.hidden = false;
    box.innerHTML = `
      <div class="box line"><div class="box-top"><span>Send exactly</span><span>${s.chain}</span></div>
        <div class="box-row"><span class="amount out">${esc(amt)}</span><span class="token">${s.symbol}</span></div></div>
      <div class="box"><div class="box-top"><span>To this one-time address</span><button type="button" class="icon-btn x-copy" aria-label="Copy address"><i class="ph ph-copy"></i></button></div>
        <code class="x-addr">${esc(p.addr)}</code></div>
      ${link ? `<a class="ghost wide" href="${esc(link)}"><i class="ph ph-wallet"></i> Open in your Solana wallet</a>` : ''}
      <p class="x-status"><span class="spin" aria-hidden="true"></span><span class="x-st">${STATUS.PENDING_DEPOSIT}</span></p>
      <p class="note">${fromUnits(BigInt(p.amount))} NEAR arrives as a private balance${p.to ? ' for the person you are paying' : ''}. Send it before ${new Date(p.deadline).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: a late or short deposit is refunded to your address, and so is anything above what the swap needs.</p>
      <button type="button" class="link x-reset">Start over</button>`;
    box.querySelector('.x-copy').onclick = () => { navigator.clipboard.writeText(p.addr); opts.toast?.('Address copied'); };
    box.querySelector('.x-reset').onclick = () => { if (!confirm('Stop tracking this deposit? Only do this if you have not sent anything to the address.')) return; reset(); };
    poll(p);
  }
  function reset() {
    clearTimeout(timer);
    opts.store?.set(null);
    form.classList.remove('paying');
    $('.x-pay').hidden = true;
    $('.x-pay').innerHTML = '';
  }
  async function poll(p) {
    clearTimeout(timer);
    let st = null;
    try { st = await depositStatus(p.addr); } catch {}
    const status = st?.status;
    const el = $('.x-st');
    if (!el) return;
    if (status) el.textContent = STATUS[status] ?? status;
    if (!DONE.has(status)) { timer = setTimeout(() => poll(p), 5000); return; }
    $('.spin')?.remove();
    opts.store?.set(null);
    if (status === 'SUCCESS') await opts.onSuccess?.(p, st, form);
    $('.x-reset').textContent = 'New deposit';
    $('.x-reset').onclick = reset;
  }

  refreshChain();
  const saved = opts.store?.get();
  if (saved) show(saved);
  else price();
  return { reprice: price };
}

const row = (k, v, cls = '') => `<div class="${cls}"><span>${k}</span><span>${v}</span></div>`;
const trim = (s, dp) => { const [w, f = ''] = s.split('.'); const t = f.slice(0, dp).replace(/0+$/, ''); return t ? `${w}.${t}` : w; };
