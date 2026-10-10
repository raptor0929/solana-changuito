/** Wire shapes shared by app/api/checkout/* and CheckoutModal. Types only. */

export interface QuoteResponse {
  orderId: string;
  /** USDC base units (6 decimals), decimal string. */
  amount: string;
  amountCents: number;
  amountDisplay: string;
  basketHash: string;
  timeoutSecs: number;
  arsPerUsd: number;
  /** Where the rate came from: `belo`, or `ARS_PER_USD` when pinned. */
  rateSource: string;
  /** The breakdown the shopper confirms, in centavos and as display strings. */
  itemsCentavos: number;
  shippingCentavos: number;
  totalCentavos: number;
  itemsDisplay: string;
  shippingDisplay: string;
  totalDisplay: string;
  /** The store's name for the delivery option, e.g. "Envío a Domicilio". */
  shippingLabel: string;
  programId: string;
  usdcMint: string;
}

export type CheckoutStage = 'quoted' | 'locked' | 'shopping' | 'done' | 'refunded';

export interface StatusResponse {
  orderId: string;
  stage: CheckoutStage;
  /** The sandbox phase while shopping: login, empty_cart, shop, checkout, payment. */
  phase: string | null;
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
