/**
 * GET /api/checkout/orders  ->  { orders: OrderLine[] }
 *
 * What this wallet has bought, read from the escrow program rather than a
 * database: every Order account whose buyer is the signed-in wallet. The
 * chain is the record, so the list is the same on every device and needs no
 * DATABASE_URL.
 */
import { ordersOf } from '../../../../lib/checkout/escrow-server.ts';
import type { OrderLine } from '../../../../lib/checkout/types.ts';
import { orderPda, hexToBytes } from '../../../../lib/escrow.ts';
import { DEPLOYMENTS } from '../../../../lib/deployments.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';
import { explorerAccount } from '../../../../lib/solana.ts';
import { formatUsdc } from '../../../../lib/usdc.ts';
import { address } from '@solana/kit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión.' }, { status: 401 });
  try {
    const program = address(DEPLOYMENTS.devnet.programId);
    const orders: OrderLine[] = await Promise.all(
      (await ordersOf(user.address)).slice(0, 50).map(async (o) => ({
        orderId: o.orderId,
        amountDisplay: formatUsdc(o.amount),
        status: o.status,
        openedAt: o.openedAt * 1000,
        explorer: explorerAccount(await orderPda(program, hexToBytes(o.orderId))),
      })),
    );
    return Response.json({ orders }, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    console.error('[checkout/orders]', err);
    return Response.json({ error: 'No pudimos leer tus compras.' }, { status: 502 });
  }
}
