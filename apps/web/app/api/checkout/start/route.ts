/**
 * POST /api/checkout/start { orderId, openSig? }  ->  StatusResponse
 *
 * Called after the shopper's wallet sent `open`. The server believes the
 * chain, not the browser: the Order account must exist, belong to the cookie's
 * wallet, be open, lock at least the quoted amount and commit to the quoted
 * basket. Only then does the sandbox start spending effort on it.
 *
 * Idempotent: a second call for an order that already has a job returns the
 * same status rather than starting a second job.
 */
import { readOrder } from '../../../../lib/checkout/escrow-server.ts';
import { startJob } from '../../../../lib/checkout/sandbox.ts';
import { checkoutStore } from '../../../../lib/checkout/store.ts';
import type { StatusResponse } from '../../../../lib/checkout/types.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión para pagar.' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { orderId?: unknown; openSig?: unknown } | null;
  const orderId = typeof body?.orderId === 'string' && /^[0-9a-f]{64}$/.test(body.orderId) ? body.orderId : null;
  if (!orderId) return Response.json({ error: 'Pedido inválido.' }, { status: 400 });

  const store = checkoutStore();
  const rec = await store.get(orderId);
  if (!rec || rec.buyer !== user.address) return Response.json({ error: 'No encontramos ese pedido.' }, { status: 404 });

  if (!rec.jobId) {
    // A just-confirmed transaction can lag one RPC node behind another.
    let order = await readOrder(orderId);
    for (let i = 0; !order && i < 4; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      order = await readOrder(orderId);
    }
    if (!order) return Response.json({ error: 'Todavía no vemos el pago en la red.' }, { status: 409 });
    if (order.buyer !== rec.buyer) return Response.json({ error: 'El pago no es de esta billetera.' }, { status: 403 });
    if (order.status !== 'open') return Response.json({ error: 'Ese pedido ya está cerrado.' }, { status: 409 });
    if (order.amount < BigInt(rec.amount)) return Response.json({ error: 'El monto bloqueado no alcanza.' }, { status: 409 });
    if (order.basketHash !== rec.basketHash) {
      return Response.json({ error: 'El changuito bloqueado no es el cotizado.' }, { status: 409 });
    }

    rec.openSig = typeof body?.openSig === 'string' ? body.openSig : rec.openSig;
    try {
      rec.jobId = await startJob(
        orderId,
        rec.lines.map((l) => ({ name: l.name, quantity: l.quantity, sku: l.skuId })),
      );
    } catch (err) {
      // No job means nothing will settle it: the status poll refunds.
      console.error('[checkout/start]', err);
      rec.error = 'No pudimos arrancar la compra.';
      rec.jobId = 'none';
    }
    rec.phase = 'queued';
    await store.set(rec);
  }

  const res: StatusResponse = {
    orderId,
    stage: 'shopping',
    phase: rec.phase ?? null,
    openSig: rec.openSig ?? null,
    closeSig: null,
    handoffUrl: null,
    amountDisplay: (rec.amountCents / 100).toFixed(2),
    error: rec.error ?? null,
  };
  return Response.json(res);
}
