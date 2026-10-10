/**
 * The shopper's Día login, as /api/checkout/start receives it. Validated here
 * and handed to the sandbox; nothing in this module stores or logs it.
 */
import type { SandboxShopper } from './sandbox.ts';

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;

/** The shopper's login and optional address, validated. Undefined when the login is incomplete. */
export function readShopper(dia: unknown, address: unknown, postcode?: string): SandboxShopper | undefined {
  const d = (dia ?? {}) as Record<string, unknown>;
  const a = (address ?? {}) as Record<string, unknown>;
  const email = str(d.email, 254);
  const password = typeof d.password === 'string' && d.password.length > 0 && d.password.length <= 128 ? d.password : undefined;
  const dni = str(d.dni, 12)?.replace(/\D/g, '');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !password || !dni || !/^\d{7,9}$/.test(dni)) return undefined;
  const shopper: SandboxShopper = { email, password, dni };
  if (postcode) shopper.postcode = postcode;
  for (const k of ['street', 'number', 'phone', 'complement'] as const) {
    const v = str(a[k], 120);
    if (v) shopper[k] = v;
  }
  return shopper;
}
