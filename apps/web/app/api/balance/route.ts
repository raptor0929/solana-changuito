/**
 * GET /api/balance?address=… — SOL and devnet USDC for a Solana address.
 *
 * Read-only and public on purpose: a balance is on chain for anyone to read.
 */
import { requireHuman } from '../../../lib/human-gate.ts';
import { isSolanaAddress } from '../../../lib/solana.ts';
import { formatUsdc, readBalances } from '../../../lib/usdc.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface BalanceResponse {
  address: string;
  /** Lamports, as a string. Rent for an escrow order comes out of this. */
  sol: string;
  /** USDC base units (6 decimals), as a string. */
  usdc: string;
  /** The same number, rounded for a person: "12.34". */
  usdcDisplay: string;
  network: 'devnet';
}

export async function GET(req: Request): Promise<Response> {
  const gated = await requireHuman(req);
  if (gated) return gated;

  const address = new URL(req.url).searchParams.get('address') ?? '';
  if (!isSolanaAddress(address)) {
    return Response.json({ error: 'not a Solana address' }, { status: 400 });
  }
  try {
    const b = await readBalances(address);
    const body: BalanceResponse = {
      address,
      sol: b.lamports.toString(),
      usdc: b.usdc.toString(),
      usdcDisplay: formatUsdc(b.usdc),
      network: 'devnet',
    };
    return Response.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `could not read balances: ${message}` }, { status: 502 });
  }
}
