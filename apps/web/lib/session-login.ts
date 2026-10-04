/** Returns the Privy access token for the live session, or null. */
export type TokenSource = () => Promise<string | null>;

/**
 * Mint the httpOnly `chg_user` cookie that lifts the guest turn limit.
 *
 * The server does not take the address on trust: each mint carries the
 * Privy access token, and the server reads the wallet from Privy itself.
 *
 * Two callers race the same Privy login: the balance widget, which wants
 * the cookie to exist, and the chat, which has to *know* it exists before it
 * re-sends the message the gate rejected — otherwise the retry POSTs into the
 * same 401 it is recovering from. So the mint is awaitable, and de-duplicated
 * by address so the second caller waits on the first request instead of
 * signing and firing another.
 *
 * `force` remints when the server still answered `login_required` after a
 * mint we already counted as done. Logout bumps a generation so an in-flight
 * response from the session that just ended cannot resurrect that cookie.
 *
 * Its one relative import names its extension, so the module still loads
 * under `node --experimental-strip-types`.
 */

let pending: { address: string; done: Promise<boolean> } | null = null;
let readyAddress: string | null = null;
let generation = 0;

function start(address: string, sign: TokenSource): Promise<boolean> {
  const gen = generation;
  const done = sign()
    .then((token) =>
      token
        ? fetch('/api/session/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ token }),
          }).then((r) => r.ok && gen === generation)
        : false,
    )
    .catch(() => false)
    .then((ok) => {
      if (ok) readyAddress = address;
      // Drop the in-flight slot either way. A success is remembered on
      // `readyAddress`; a failure has to be a real attempt next time.
      if (pending?.done === done) pending = null;
      return ok;
    });

  pending = { address, done };
  return done;
}

/** Resolves true when the server has the cookie. Never rejects. */
export function ensureUserCookie(
  address: string,
  sign: TokenSource,
  opts?: { force?: boolean },
): Promise<boolean> {
  const force = opts?.force === true;
  if (!force && readyAddress === address) return Promise.resolve(true);
  if (pending?.address === address) {
    if (!force) return pending.done;
    // The mint already in flight is the one we are waiting on. A second POST
    // would race it. Only remint when that attempt itself failed.
    return pending.done.then((ok) => (ok ? true : start(address, sign)));
  }
  if (force) readyAddress = null;
  return start(address, sign);
}

/**
 * After logout. The cookie a cached success stands for has just been cleared,
 * so logging back in with the same address has to mint it again.
 */
export function forgetUserCookie(): void {
  readyAddress = null;
  pending = null;
  generation += 1;
}
