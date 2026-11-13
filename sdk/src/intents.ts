// Deposits from other chains through NEAR Intents (1Click API, no API key; 1Click adds a
// 0.2% fee without one). The user sends SOL, ETH, USDC, BTC… to a one-time deposit address;
// 1Click swaps it and delivers an exact amount of wNEAR to the pool with `ft_transfer_call`,
// carrying a deposit proof built in the browser (ShieldedWallet.depositMsg). The pool unwraps
// it into native NEAR notes, for the user or for anyone's private address (payment links).
// Mainnet only: 1Click runs on mainnet.
export const ONECLICK = 'https://1click.chaindefuser.com/v0';
export const WNEAR_ASSET = 'nep141:wrap.near';

/** Source assets offered, by 1Click asset id. Decimals and prices come from /tokens. */
export const SOURCES = [
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', chain: 'Solana', refund: 'solana' },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', symbol: 'USDC', chain: 'Solana', refund: 'solana', splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: 'nep141:base.omft.near', symbol: 'ETH', chain: 'Base', refund: 'evm' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', symbol: 'USDC', chain: 'Base', refund: 'evm' },
  { assetId: 'nep141:eth.omft.near', symbol: 'ETH', chain: 'Ethereum', refund: 'evm' },
  { assetId: 'nep141:arb.omft.near', symbol: 'ETH', chain: 'Arbitrum', refund: 'evm' },
  { assetId: 'nep141:btc.omft.near', symbol: 'BTC', chain: 'Bitcoin', refund: 'btc' },
];

const REFUND = {
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a Solana address'],
  evm: [/^0x[0-9a-fA-F]{40}$/, 'an 0x… address'],
  btc: [/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, 'a Bitcoin address'],
};
/** Returns an error message, or '' when `addr` looks like a refund address for `source`. */
export function refundError(source, addr) {
  const [re, what] = REFUND[source.refund];
  return re.test(addr.trim()) ? '' : `Enter ${what} you control: refunds go there.`;
}

async function call(path, init) {
  const r = await fetch(`${ONECLICK}${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message ?? `NEAR Intents: ${r.status}`);
  return j;
}

/** Decimals and USD prices of the offered sources, keyed by asset id. */
export async function sourceInfo() {
  const all = await call('/tokens');
  return Object.fromEntries(all.filter((t) => SOURCES.some((s) => s.assetId === t.assetId)).map((t) => [t.assetId, { decimals: t.decimals, price: t.price }]));
}

/**
 * Quote for delivering exactly `amountOut` wNEAR (yocto) to `pool`, paid in `source`.
 * dry: price only (no address). Otherwise `msg` (from depositMsg) and `refundTo` are required
 * and the result has `quote.depositAddress`, `quote.amountIn` and `quote.deadline`.
 */
export async function quoteDeposit({ source, amountOut, pool, msg = '', refundTo, dry = true, minutes = 60 }) {
  const body = {
    dry,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: source.assetId,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: WNEAR_ASSET,
    amount: String(amountOut),
    refundTo: refundTo || DRY_REFUND[source.refund],
    refundType: 'ORIGIN_CHAIN',
    recipient: pool,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  if (msg) body.customRecipientMsg = msg;
  return call('/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
// placeholders for price-only quotes (1Click validates the format, nothing is sent there)
const DRY_REFUND = { solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', evm: '0x1111111111111111111111111111111111111111', btc: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };

/** { status, ... }: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED. */
export async function depositStatus(depositAddress) {
  return call(`/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

/** A wallet link for the deposit (Solana Pay for Solana sources), or null. */
export function walletLink(source, depositAddress, amountIn, decimals) {
  if (source.chain !== 'Solana') return null;
  const amt = formatUnits(amountIn, decimals);
  return `solana:${depositAddress}?amount=${amt}${source.splToken ? `&spl-token=${source.splToken}` : ''}&label=NEAR%20Privacy%20Rings`;
}

export function formatUnits(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
