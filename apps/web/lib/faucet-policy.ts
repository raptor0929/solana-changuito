/**
 * Who gets demo USDC, how much, and when they have had enough.
 *
 * Pure, because this is the part worth being sure about: the mint is
 * admin-gated, which means every call to it is signed by our one hot key, and
 * "how often can a stranger make that key sign something" should not be a
 * question answered inside an HTTP handler.
 */

/** 50.00 USDC. Enough for a week's basket, not enough to be worth farming. */
export const GRANT_UNITS = 50_000_000n; // 50.00 at 6 decimals

/** Above this, the faucet stops: the wallet is not short of money. */
export const ENOUGH_UNITS = 100_000_000n; // 100.00

/** One grant per address per minute. */
export const COOLDOWN_MS = 60_000;

export type FaucetVerdict =
  | { allow: true; amount: bigint }
  | { allow: false; reason: string; retryInMs?: number };

export interface FaucetRequest {
  /** The address's current demo USDC, in token units. */
  balanceUnits: bigint;
  /** When this address was last granted, or undefined if never. */
  lastGrantAt?: number;
  now: number;
}

export function faucetVerdict({ balanceUnits, lastGrantAt, now }: FaucetRequest): FaucetVerdict {
  if (balanceUnits >= ENOUGH_UNITS) {
    return {
      allow: false,
      reason: 'Ya tenés USDC de prueba suficiente para completar una compra.',
    };
  }

  if (lastGrantAt !== undefined) {
    const elapsed = now - lastGrantAt;
    // A clock that went backwards (a redeploy, a different machine) is treated
    // as "too soon" rather than as permission.
    if (elapsed < COOLDOWN_MS) {
      return {
        allow: false,
        reason: 'Esperá un momento antes de volver a pedir fondos.',
        retryInMs: Math.max(0, COOLDOWN_MS - Math.max(elapsed, 0)),
      };
    }
  }

  return { allow: true, amount: GRANT_UNITS };
}
