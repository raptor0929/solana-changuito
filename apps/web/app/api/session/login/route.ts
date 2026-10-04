import { issueUserSession } from '../../../../lib/session-issue.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/session/login { token }
 *
 * Called after Privy login with the user's Privy access token. Sets the
 * signed httpOnly `chg_user` cookie that /api/chat reads. All of the checking
 * lives in lib/session-issue.ts.
 */
export function POST(req: Request): Promise<Response> {
  return issueUserSession(req);
}
