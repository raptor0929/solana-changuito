import type { NextConfig } from 'next';

import { appSecurityHeaders, fixtureSecurityHeaders, FIXTURE_PATH } from './lib/security-headers.ts';

const config: NextConfig = {
  // www already drops it; there is no reason to advertise the framework.
  poweredByHeader: false,
  // The build checks the app; `npm run typecheck` checks the app and the
  // tests. Split since the Solana move, when several frozen tests began to
  // reference Stellar modules that no longer exist (see CLAUDE.md on tests).
  typescript: { tsconfigPath: 'tsconfig.build.json' },
  async headers() {
    // Order matters: a later rule's value wins for the same header key, so
    // the fixture's relaxed frame-ancestors has to come second. Outside
    // development `fixtureSecurityHeaders` is empty and the rule is not
    // added at all — see lib/security-headers.ts for why that is two locks.
    const fixture = fixtureSecurityHeaders();
    return [
      { source: '/:path*', headers: appSecurityHeaders() },
      ...(fixture.length ? [{ source: FIXTURE_PATH, headers: fixture }] : []),
    ];
  },
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // `@changuito/mcp` is a workspace package of compiled ESM. It gets bundled
  // rather than marked external, because a symlinked workspace package that
  // Next treats as external is not traced into the lambda at all and fails at
  // runtime with MODULE_NOT_FOUND.
  //
  // Bundling it is only safe because `@changuito/mcp/server` has no reference
  // to the checkout module — not even a dynamic one, which a bundler would
  // resolve at build time anyway. See packages/mcp/src/server.ts.
  transpilePackages: ['@changuito/mcp'],

  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,

  // Belt and braces. If the boundary above ever slips, this is the second
  // thing that has to fail before a browser engine ships in a lambda.
  outputFileTracingExcludes: {
    '/api/**': [
      './node_modules/playwright/**',
      './node_modules/playwright-core/**',
      './node_modules/ethers/**',
      './packages/mcp/dist/checkout/**',
      './packages/mcp/dist/wallet/**',
    ],
  },
};

export default config;
