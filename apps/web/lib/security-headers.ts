import { ANALYTICS_IDS, type AnalyticsIds } from './analytics.ts';
import { DEPLOYMENTS, NETWORK_IDS } from './deployments.ts';
import { STOREFRONT_ORIGINS } from './storefront.ts';

/**
 * Response headers for the shopper, mirroring www's (apps/landing/lib/csp.ts).
 *
 * The app shipped none, so any site could frame app.changuito.me and lay a
 * fake button over "Cargar USDC" or "Ya lo completé". `frame-ancestors 'none'`
 * plus X-Frame-Options is the fix; the rest is the same baseline www has.
 *
 * What the browser actually talks to, and so what the CSP names:
 * - Turnstile: script, iframe and beacon on challenges.cloudflare.com.
 * - Privy: the auth API, its embedded-wallet iframe and its relays (below).
 * - Solana devnet: the RPC (https and wss) from deployments.ts, which the
 *   balance reads and the open transaction's blockhash go through.
 * - Product photos: every retailer serves them from *.vtexassets.com.
 * - Supermarket origins stay in frame-src; see lib/storefront.ts.
 * - Analytics: only the vendors whose id is set, same as www.
 *
 * `'unsafe-inline'` for scripts stays for the reason www gives: a nonce makes
 * every route dynamic and drops Next's inline bootstrap otherwise. Pure so
 * next.config can call it and a test can pin it.
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
/** Privy: the auth API, its embedded-wallet iframe, and its RPC relays. */
const PRIVY = ['https://auth.privy.io', 'https://*.privy.io', 'https://*.privy.systems'];
const PRIVY_WS = ['wss://*.privy.io', 'wss://relay.walletconnect.com'];
/**
 * Derived from lib/deployments.ts rather than listed, so the RPC the app is
 * pointed at and the RPC the browser may reach cannot drift. The wss twin is
 * for Privy's confirmation subscriptions.
 */
const SOLANA = [
  ...new Set(
    NETWORK_IDS.flatMap((net) => {
      const origin = new URL(DEPLOYMENTS[net].rpcUrl).origin;
      return [origin, origin.replace(/^http/, 'ws')];
    }),
  ),
];
const PRODUCT_IMAGES = 'https://*.vtexassets.com';

export function analyticsCspSources(ids: AnalyticsIds = ANALYTICS_IDS): { script: string[]; connect: string[]; img: string[] } {
  const script: string[] = [];
  const connect: string[] = [];
  const img: string[] = [];
  if (ids.ga) {
    script.push('https://www.googletagmanager.com', 'https://www.google-analytics.com');
    connect.push(
      'https://www.google-analytics.com',
      'https://*.google-analytics.com',
      'https://analytics.google.com',
      'https://*.analytics.google.com',
      'https://www.googletagmanager.com',
      'https://stats.g.doubleclick.net',
    );
    img.push('https://www.google-analytics.com', 'https://www.googletagmanager.com');
  }
  if (ids.meta) {
    script.push('https://connect.facebook.net');
    connect.push('https://www.facebook.com', 'https://connect.facebook.net');
    img.push('https://www.facebook.com');
  }
  if (ids.clarity) {
    script.push('https://www.clarity.ms', 'https://scripts.clarity.ms');
    connect.push('https://www.clarity.ms', 'https://*.clarity.ms');
    img.push('https://www.clarity.ms', 'https://c.clarity.ms');
  }
  return { script, connect, img };
}

const join = (xs: string[]) => (xs.length ? ` ${xs.join(' ')}` : '');

export function appContentSecurityPolicy(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  ids: AnalyticsIds = ANALYTICS_IDS,
): string {
  const isProd = nodeEnv === 'production';
  const vendors = analyticsCspSources(ids);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${isProd ? '' : " 'unsafe-eval'"}${join(vendors.script)} ${TURNSTILE_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${PRODUCT_IMAGES}${join(vendors.img)}`,
    "font-src 'self' data:",
    `connect-src 'self'${isProd ? '' : ' ws: wss:'} ${PRIVY.join(' ')} ${PRIVY_WS.join(' ')} ${SOLANA.join(' ')}${join(vendors.connect)} ${TURNSTILE_ORIGIN}`,
    // Turnstile's challenge, and the supermarket checkout the shopper
    // finishes the order on. 'self' is the dev fixture at /dev/checkout,
    // which stands in for a store that has no sandbox. This is the frames
    // *we* may open; being framed is still refused outright, below.
    `frame-src 'self' ${TURNSTILE_ORIGIN} ${PRIVY.join(' ')} ${STOREFRONT_ORIGINS.join(' ')}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(isProd ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** The one path that is allowed to be framed, and only outside production. */
export const FIXTURE_PATH = '/dev/checkout';

/**
 * The app's headers with exactly one line relaxed, for the checkout fixture.
 *
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY` refuse framing by
 * *anyone*, and a browser counts us among them: the checkout dialog framing
 * our own /dev/checkout is blocked by our own header, which is the header
 * working. The fixture is the stand-in for a store with no sandbox, so it has
 * to be framable by us and nobody else — `'self'` says precisely that.
 *
 * Returns nothing in production, where app/dev/checkout `notFound()`s anyway.
 * Two independent reasons a real deployment cannot serve a framable page that
 * says "pagado" and takes no money, because one is a single edit away from
 * being deleted by someone who does not know why it is there.
 */
export function fixtureSecurityHeaders(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  ids: AnalyticsIds = ANALYTICS_IDS,
): { key: string; value: string }[] {
  if (nodeEnv === 'production') return [];
  return appSecurityHeaders(nodeEnv, ids).map((h) =>
    h.key === 'Content-Security-Policy'
      ? { key: h.key, value: h.value.replace("frame-ancestors 'none'", "frame-ancestors 'self'") }
      : h.key === 'X-Frame-Options'
        ? { key: h.key, value: 'SAMEORIGIN' }
        : h,
  );
}

export function appSecurityHeaders(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  ids: AnalyticsIds = ANALYTICS_IDS,
): { key: string; value: string }[] {
  const headers = [
    { key: 'Content-Security-Policy', value: appContentSecurityPolicy(nodeEnv, ids) },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Permitted-Cross-Domain-Policies', value: 'none' },
    // Passkeys (WebAuthn) keep their default of 'self'. Camera and microphone
    // are granted to this origin only: the composer asks for them when the
    // shopper taps the mic or the camera. `()` would refuse the prompt
    // outright, which is what a desktop browser does when the header is empty.
    { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()' },
  ];
  if (nodeEnv === 'production') {
    headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  }
  return headers;
}
