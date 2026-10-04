/**
 * GET /api/checkout/status?orderId=…  ->  StatusResponse
 *
 * The checkout dialog polls this every few seconds. Each poll asks the
 * sandbox how far it got and, when the job is over, closes the escrow:
 *
 *   - reached Día's card step  -> settle: vault -> treasury, receipt on chain
 *   - failed, lost, or no job  -> refund: vault -> buyer
 *
 * The order is not placed at Día — the sandbox stops at the card form, which
 * it cannot fill. Reaching it is the evidence that the basket was buyable at
 * the store, and that is what this demo settles on. The shopper gets their
 * own cart link (`handoffUrl`) to finish there.
 *
 * Idempotent by reading the chain first: a closed order is reported, never
 * closed again.
 */
import { createHash } from 'node:crypto';

import { readOrder, refundOrder, settleOrder } from '../../../../lib/checkout/escrow-server.ts';
import { readJob } from '../../../../lib/checkout/sandbox.ts';
import { checkoutStore, type CheckoutRecord } from '../../../../lib/checkout/store.ts';
import type { StatusResponse } from '../../../../lib/checkout/types.ts';
import { readLoggedInUser } from '../../../../lib/login-gate.ts';
import { canonicalReceipt } from '../../../../lib/order.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One close in flight per order per instance; the chain refuses a second anyway. */
const g = globalThis as { __chgClosing?: Set<string> };
const closing = (g.__chgClosing ??= new Set());

function reply(rec: CheckoutRecord, stage: StatusResponse['stage']): Response {
  const res: StatusResponse = {
    orderId: rec.orderId,
    stage,
    phase: rec.phase ?? null,
    openSig: rec.openSig ?? null,
    closeSig: rec.closeSig ?? null,
    handoffUrl: stage === 'done' ? rec.handoffUrl : null,
    amountDisplay: (rec.amountCents / 100).toFixed(2),
    error: rec.error ?? null,
  };
  return Response.json(res, { headers: { 'cache-control': 'no-store' } });
}

export async function GET(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión.' }, { status: 401 });

  const orderId = new URL(req.url).searchParams.get('orderId') ?? '';
  if (!/^[0-9a-f]{64}$/.test(orderId)) return Response.json({ error: 'Pedido inválido.' }, { status: 400 });

  const store = checkoutStore();
  const rec = await store.get(orderId);
  if (!rec || rec.buyer !== user.address) return Response.json({ error: 'No encontramos ese pedido.' }, { status: 404 });

  if (rec.outcome) return reply(rec, rec.outcome === 'settled' ? 'done' : 'refunded');
  if (!rec.jobId) return reply(rec, 'quoted');

  let finished: 'settle' | 'refund' | null = null;
  if (rec.jobId === 'none') {
    finished = 'refund';
  } else {
    try {
      const job = await readJob(rec.jobId);
      rec.phase = job.phase;
      if (job.status === 'done' && job.result?.reached_payment) {
        finished = 'settle';
        rec.storeOrderForm = job.result.cart?.orderFormId;
      } else if (job.status === 'done' || job.status === 'failed') {
        finished = 'refund';
        rec.error = job.error ?? 'La tienda no llegó al pago.';
      }
    } catch (err) {
      // A sandbox we cannot reach is not yet a failed job; keep polling. The
      // buyer can still refund on chain once the deadline passes.
      console.error('[checkout/status] sandbox', err);
    }
  }

  if (!finished || closing.has(orderId)) {
    await store.set(rec);
    return reply(rec, 'shopping');
  }

  closing.add(orderId);
  try {
    const order = await readOrder(orderId);
    if (!order) throw new Error('order account missing');
    if (order.status === 'open') {
      if (finished === 'settle') {
        const receipt =
          canonicalReceipt({
            orderId,
            buyer: order.buyer,
            basketHash: order.basketHash,
            amountUnits: order.amount.toString(),
            settledAt: new Date().toISOString(),
          }).replace('basis|buyer-confirmed', 'basis|sandbox-reached-payment') +
          `job|${rec.jobId}\norderform|${rec.storeOrderForm ?? ''}\n`;
        rec.closeSig = await settleOrder(order, createHash('sha256').update(receipt).digest());
      } else {
        rec.closeSig = await refundOrder(order);
      }
      rec.outcome = finished === 'settle' ? 'settled' : 'refunded';
    } else {
      rec.outcome = order.status === 'settled' ? 'settled' : 'refunded';
    }
    await store.set(rec);
    return reply(rec, rec.outcome === 'settled' ? 'done' : 'refunded');
  } catch (err) {
    console.error('[checkout/status] close', err);
    await store.set(rec);
    return reply(rec, 'shopping');
  } finally {
    closing.delete(orderId);
  }
}
