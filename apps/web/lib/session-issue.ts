import { requireHuman } from './human-gate.ts';
import { mintUserToken, sessionSecret, userCookieHeader } from './login-gate.ts';
import { verifyPrivyToken } from './privy-server.ts';
import { isSolanaAddress } from './solana.ts';

/**
 * POST /api/session/login { token } — issue `chg_user`.
 *
 * The browser sends its Privy access token; the server verifies it against
 * Privy's JWKS and reads the user's embedded Solana wallet from Privy, so the
 * address the cookie names is one Privy vouches for, not one the browser
 * claimed. Everything downstream (chat limits, checkout, orders) reads the
 * address from this cookie.
 */
export async function issueUserSession(
  req: Request,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<Response> {
  const gated = await requireHuman(req, env);
  if (gated) return gated;

  const secret = sessionSecret(env);
  if (!secret) {
    console.error('[session] CHG_SESSION_SECRET is not set in production — refusing to sign sessions.');
    return Response.json(
      { error: 'session_unconfigured', message: 'El inicio de sesión no está disponible ahora.' },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'expected_json' }, { status: 400 });
  }
  const raw = (body as { token?: unknown } | null)?.token;
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) {
    return Response.json({ error: 'session_proof_required', message: 'Iniciá sesión de nuevo.' }, { status: 401 });
  }

  const who = await verifyPrivyToken(token, env);
  if (!who) {
    return Response.json(
      { error: 'session_proof_invalid', message: 'No pudimos confirmar tu sesión. Iniciá sesión de nuevo.' },
      { status: 401 },
    );
  }
  if (!who.address || !isSolanaAddress(who.address)) {
    return Response.json(
      { error: 'wallet_missing', message: 'Tu cuenta todavía no tiene billetera. Probá de nuevo en unos segundos.' },
      { status: 409 },
    );
  }

  const cookie = await mintUserToken(who.address, secret, now);
  return new Response(JSON.stringify({ ok: true, address: who.address }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': userCookieHeader(cookie) },
  });
}
