/**
 * POST /api/faucet  ->  { address, usdc, usdcDisplay, txHash, created }
 *
 * Devnet only: mints our test USDC to the signed-in shopper's Privy wallet and
 * sends a pinch of SOL with it. The SOL is rent, not fees — the resolver pays
 * the `open` fee (/api/checkout/open), but `open` creates an order account and
 * a vault, and the buyer pays for those. The vault's rent comes back when it closes on settle or refund;
 * the order account stays as the on-chain record, and its rent with it.
 *
 * One transaction, signed by the resolver, which is the mint authority:
 * create the token account if missing, mint, transfer SOL. Doing it in one
 * means a shopper never ends up with USDC and nothing to open an order with.
 *
 * The address comes from the `chg_user` cookie, never from the body: the
 * resolver key signs every grant, so who it signs for is the server's call.
 *
 * GET /api/faucet  ->  { mode, allowed }: kept for the widget, always yes.
 */
import { address } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { getCreateAssociatedTokenIdempotentInstruction, getMintToInstruction } from '@solana-program/token';

import { faucetVerdict } from '../../../lib/faucet-policy.ts';
import { requireHuman } from '../../../lib/human-gate.ts';
import { readLoggedInUser } from '../../../lib/login-gate.ts';
import { resolverConfigured, resolverSigner } from '../../../lib/server/resolver.ts';
import { sendIxs } from '../../../lib/solana.ts';
import { formatUsdc, readBalances, USDC_MINT, usdcAccount } from '../../../lib/usdc.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 0.01 SOL: an order account plus a vault is ~0.004, so two or three orders. */
const RENT_LAMPORTS = 10_000_000n;
/** Below this the wallet gets the SOL again with the next grant. */
const RENT_FLOOR = 6_000_000n;

export interface FaucetResponse {
  address: string;
  /** True when this call created the shopper's USDC account. */
  created: boolean;
  usdc: string;
  usdcDisplay: string;
  txHash: string | null;
}

/** Per-instance cooldown. A cold start resets it; the balance ceiling still holds. */
const lastGrant = new Map<string, number>();

export async function GET(): Promise<Response> {
  return Response.json({ mode: 'public', allowed: true }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request): Promise<Response> {
  const gated = await requireHuman(req);
  if (gated) return gated;

  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión para cargar USDC.' }, { status: 401 });
  if (!resolverConfigured()) return Response.json({ error: 'El faucet no está configurado.' }, { status: 503 });

  const owner = user.address;
  const before = await readBalances(owner);
  const verdict = faucetVerdict({ balanceUnits: before.usdc, lastGrantAt: lastGrant.get(owner), now: Date.now() });
  if (!verdict.allow) {
    const body: FaucetResponse & { note: string } = {
      address: owner,
      created: false,
      usdc: before.usdc.toString(),
      usdcDisplay: formatUsdc(before.usdc),
      txHash: null,
      note: verdict.reason,
    };
    return Response.json(body, { status: 429 });
  }

  lastGrant.set(owner, Date.now());
  try {
    const resolver = await resolverSigner();
    const ata = await usdcAccount(owner);
    const ixs = [
      getCreateAssociatedTokenIdempotentInstruction({ payer: resolver, ata, owner: address(owner), mint: USDC_MINT }),
      getMintToInstruction({ mint: USDC_MINT, token: ata, mintAuthority: resolver, amount: verdict.amount }),
      ...(before.lamports < RENT_FLOOR
        ? [getTransferSolInstruction({ source: resolver, destination: address(owner), amount: RENT_LAMPORTS })]
        : []),
    ];
    const txHash = await sendIxs(resolver, ixs);
    const usdc = before.usdc + verdict.amount;
    const body: FaucetResponse = {
      address: owner,
      created: !before.hasUsdcAccount,
      usdc: usdc.toString(),
      usdcDisplay: formatUsdc(usdc),
      txHash,
    };
    return Response.json(body);
  } catch (err) {
    lastGrant.delete(owner);
    console.error('[faucet]', err);
    return Response.json({ error: 'No pudimos cargar USDC. Probá de nuevo en un momento.' }, { status: 502 });
  }
}
