/**
 * GET /api/profile          ->  PublicProfile
 * PUT /api/profile { email?, password?, dni?, postcode? }  ->  PublicProfile
 *
 * The signed-in shopper's Día details (lib/profile.ts). The wallet address
 * comes from the session cookie only, so a request can read or write nothing
 * but its own row. The password goes in and never comes out: both answers
 * carry `hasPassword` instead. Nothing from the body is ever logged.
 */
import { readLoggedInUser } from '../../../lib/login-gate.ts';
import { ProfileKeyError } from '../../../lib/profile-crypto.ts';
import { getProfile, ProfileInputError, ProfileUnavailableError, publicProfile, saveProfile } from '../../../lib/profile.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

function failure(err: unknown): Response {
  if (err instanceof ProfileInputError) return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
  // Name only: a decrypt or database error must not echo anything it read.
  console.error('[profile]', err instanceof Error ? err.name : 'failed');
  const unavailable = err instanceof ProfileKeyError || err instanceof ProfileUnavailableError;
  return Response.json(
    { error: unavailable ? 'El perfil no está disponible en este momento.' : 'No pudimos guardar tu perfil.' },
    { status: unavailable ? 503 : 500, headers: NO_STORE },
  );
}

export async function GET(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión.' }, { status: 401, headers: NO_STORE });
  try {
    return Response.json(publicProfile(await getProfile(user.address)), { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}

export async function PUT(req: Request): Promise<Response> {
  const user = await readLoggedInUser(req);
  if (!user.ok) return Response.json({ error: 'Iniciá sesión.' }, { status: 401, headers: NO_STORE });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return Response.json({ error: 'Datos inválidos.' }, { status: 400, headers: NO_STORE });
  try {
    return Response.json(publicProfile(await saveProfile(user.address, body)), { headers: NO_STORE });
  } catch (err) {
    return failure(err);
  }
}
