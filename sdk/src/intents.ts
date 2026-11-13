// Deposits from other chains through NEAR Intents (1Click API, no API key; 1Click adds a
// 0.2% fee without one). The user sends SOL, ETH, USDC, BTC… to a one-time deposit address;
// 1Click swaps it and delivers an exact amount of wNEAR to the pool with `ft_transfer_call`,
// carrying a deposit proof built in the browser (ShieldedWallet.depositMsg). The pool unwraps
// it into native NEAR notes, for the user or for anyone's private address (payment links).
// Mainnet only: 1Click runs on mainnet.
import type { Numeric } from './crypto.ts';

/** Kind of refund address a source chain needs. */
export type RefundKind = 'solana' | 'evm' | 'btc';
/** A source asset offered for cross-chain deposits. */
export interface IntentsSource {
  /** 1Click asset id */
  assetId: string;
  symbol: string;
  chain: string;
  refund: RefundKind;
  /** SPL mint, for Solana Pay links of SPL tokens */
  splToken?: string;
}
/** Decimals and USD price of a source asset (from 1Click /tokens). */
export interface SourceInfo {
  decimals: number;
  price: number;
}
/** The fields of a 1Click quote that are read. */
export interface OneClickQuote {
  /** smallest units of the source asset, decimal string */
  amountIn: string;
  amountInUsd: string;
  /** seconds */
  timeEstimate: number;
  /** only when not dry */
  depositAddress?: string;
  /** ISO time; only when not dry */
  deadline?: string;
}
export interface OneClickQuoteResponse {
  quote: OneClickQuote;
}
export type DepositStatusName = 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';
export interface OneClickStatus {
  status: DepositStatusName;
}
export interface QuoteDepositParams {
  source: IntentsSource;
  /** wNEAR to deliver, yocto */
  amountOut: Numeric;
  /** pool contract id (the recipient) */
  pool: string;
  msg?: string;
  refundTo?: string;
  dry?: boolean;
  minutes?: number;
}
interface OneClickToken {
  assetId: string;
  decimals: number;
  price: number;
}
export const ONECLICK = 'https://1click.chaindefuser.com/v0';
export const WNEAR_ASSET = 'nep141:wrap.near';

/** Source assets offered, by 1Click asset id. Decimals and prices come from /tokens. */
export const SOURCES: IntentsSource[] = [
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', chain: 'Solana', refund: 'solana' },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', symbol: 'USDC', chain: 'Solana', refund: 'solana', splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: 'nep141:base.omft.near', symbol: 'ETH', chain: 'Base', refund: 'evm' },
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', symbol: 'USDC', chain: 'Base', refund: 'evm' },
  { assetId: 'nep141:eth.omft.near', symbol: 'ETH', chain: 'Ethereum', refund: 'evm' },
  { assetId: 'nep141:arb.omft.near', symbol: 'ETH', chain: 'Arbitrum', refund: 'evm' },
  { assetId: 'nep141:btc.omft.near', symbol: 'BTC', chain: 'Bitcoin', refund: 'btc' },
];

const REFUND: Record<RefundKind, [RegExp, string]> = {
  solana: [/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a Solana address'],
  evm: [/^0x[0-9a-fA-F]{40}$/, 'an 0x… address'],
  btc: [/^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, 'a Bitcoin address'],
};
/** Returns an error message, or '' when `addr` looks like a refund address for `source`. */
export function refundError(source: IntentsSource, addr: string): string {
  const [re, what] = REFUND[source.refund];
  return re.test(addr.trim()) ? '' : `Enter ${what} you control: refunds go there.`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${ONECLICK}${path}`, init);
  const j = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new Error(j.message ?? `NEAR Intents: ${r.status}`);
  return j;
}

/** Decimals and USD prices of the offered sources, keyed by asset id. */
export async function sourceInfo(): Promise<Record<string, SourceInfo>> {
  const all = await call<OneClickToken[]>('/tokens');
  return Object.fromEntries(all.filter((t) => SOURCES.some((s) => s.assetId === t.assetId)).map((t) => [t.assetId, { decimals: t.decimals, price: t.price }]));
}

/**
 * Quote for delivering exactly `amountOut` wNEAR (yocto) to `pool`, paid in `source`.
 * dry: price only (no address). Otherwise `msg` (from depositMsg) and `refundTo` are required
 * and the result has `quote.depositAddress`, `quote.amountIn` and `quote.deadline`.
 */
export async function quoteDeposit({ source, amountOut, pool, msg = '', refundTo, dry = true, minutes = 60 }: QuoteDepositParams): Promise<OneClickQuoteResponse> {
  const body: Record<string, unknown> = {
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
  return call<OneClickQuoteResponse>('/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
// placeholders for price-only quotes (1Click validates the format, nothing is sent there)
const DRY_REFUND: Record<RefundKind, string> = { solana: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', evm: '0x1111111111111111111111111111111111111111', btc: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' };

/** { status, ... }: PENDING_DEPOSIT, KNOWN_DEPOSIT_TX, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED. */
export async function depositStatus(depositAddress: string): Promise<OneClickStatus> {
  return call<OneClickStatus>(`/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

/** A wallet link for the deposit (Solana Pay for Solana sources), or null. */
export function walletLink(source: IntentsSource, depositAddress: string, amountIn: Numeric, decimals: number): string | null {
  if (source.chain !== 'Solana') return null;
  const amt = formatUnits(amountIn, decimals);
  return `solana:${depositAddress}?amount=${amt}${source.splToken ? `&spl-token=${source.splToken}` : ''}&label=NEAR%20Privacy%20Rings`;
}

export function formatUnits(v: Numeric, decimals: number): string {
  const s = BigInt(v).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
