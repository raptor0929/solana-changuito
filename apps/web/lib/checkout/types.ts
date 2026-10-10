/** Wire shapes shared by app/api/checkout/* and CheckoutModal. Types only. */

export interface QuoteResponse {
  orderId: string;
  /** USDC base units (6 decimals), decimal string. */
  amount: string;
  amountCents: number;
  amountDisplay: string;
  basketHash: string;
  timeoutSecs: number;
  /** Pesos per USDC, and where it came from (belo · USDC, or the ARS_PER_USD override). */
  arsPerUsd: number;
  rateSource: string;
  /** Goods, envío and their sum, in centavos. The USDC amount is the sum at `arsPerUsd`. */
  subtotalCentavos: number;
  shippingCentavos: number;
  totalCentavos: number;
  programId: string;
  usdcMint: string;
}

export type CheckoutStage = 'quoted' | 'locked' | 'shopping' | 'done' | 'refunded';

export interface StatusResponse {
  orderId: string;
  stage: CheckoutStage;
  /** The sandbox phase while shopping: login, empty_cart, shop, checkout, payment. */
  phase: string | null;
  /** What the store answered when the card was submitted: placed, declined, not_attempted, error. */
  payment: string | null;
  /** Día's order number, once placed. */
  storeOrderId: string | null;
  openSig: string | null;
  closeSig: string | null;
  handoffUrl: string | null;
  amountDisplay: string;
  error: string | null;
}

export interface OrderLine {
  orderId: string;
  amountDisplay: string;
  status: 'open' | 'settled' | 'refunded';
  openedAt: number;
  explorer: string;
}
