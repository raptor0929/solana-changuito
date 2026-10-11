/**
 * Who may buy with the shared card: the `shared_card_member` table
 * (migration 0004), read by apps/web/lib/shared-card.ts at every quote and
 * every checkout start.
 *
 *   npm run members                                   the card's network, and everyone on it
 *   npm run members -- add <solana address> [note…]   allow a wallet
 *   npm run members -- remove <solana address>        stop allowing it
 *   … --network devnet|mainnet                        another network than the card's
 *
 * The network defaults to the card's own: the `shared_card` row the app pays
 * with (devnet first, else mainnet), because that is the network the app
 * checks membership on. A member added to the other network changes nothing.
 *
 * Removing a wallet stops its next quote and its next start. A job already
 * running finishes with the card it was given.
 *
 * Connects like scripts/db.mjs: the web app's env file loaded the way Next
 * does, DIRECT_URL or DATABASE_URL, never printed.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// @next/env is CommonJS: it has no named ESM exports, so it comes in whole.
import nextEnv from '@next/env';
import postgres from 'postgres';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
nextEnv.loadEnvConfig(join(ROOT, 'apps', 'web'), true, { info: () => {}, error: () => {} });

const NETWORKS = ['devnet', 'mainnet', 'testnet'];
// Base58, 32–44 characters: the wallet_address domain (0005) checks the same.
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function where(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}`;
  } catch {
    return 'an unparseable database URL';
  }
}

const args = process.argv.slice(2);
const flag = args.indexOf('--network');
const explicitNet = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
const [cmd = 'list', address, ...noteWords] = args;

if (explicitNet && !NETWORKS.includes(explicitNet)) {
  console.error(`--network must be one of ${NETWORKS.join(', ')}`);
  process.exit(2);
}
if ((cmd === 'add' || cmd === 'remove') && !ADDRESS.test(address ?? '')) {
  console.error('That does not look like a Solana address (base58, 32–44 characters).');
  process.exit(2);
}

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_URL or DATABASE_URL for apps/web.');
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });

try {
  const [card] = await sql`
    select network, brand from shared_card where network in ('devnet', 'mainnet')
    order by (network = 'devnet') desc limit 1`;
  const net = explicitNet ?? card?.network ?? 'devnet';
  const cardLine = card
    ? `card: ${card.brand} on ${card.network}`
    : 'card: none in shared_card (checkouts are refused until there is one)';

  if (cmd === 'list') {
    const rows = await sql`
      select address, note, created_at from shared_card_member where network = ${net} order by created_at`;
    console.log(`${cardLine}\nmembers on ${net} (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.address}  ${r.created_at.toISOString().slice(0, 10)}  ${r.note ?? ''}`);
    if (card && net !== card.network) console.log(`note: the app checks membership on ${card.network}, not ${net}.`);
  } else if (cmd === 'add') {
    const note = noteWords.join(' ') || null;
    const rows = await sql`
      insert into shared_card_member (network, address, note) values (${net}, ${address}, ${note})
      on conflict (network, address) do update set note = coalesce(excluded.note, shared_card_member.note)
      returning (xmax = 0) as inserted`;
    console.log(`${rows[0].inserted ? 'added' : 'already a member (note updated)'}: ${address} on ${net} (${where(url)})`);
    if (card && net !== card.network) console.log(`warning: the card is on ${card.network}; this membership is not checked.`);
  } else if (cmd === 'remove') {
    const rows = await sql`delete from shared_card_member where network = ${net} and address = ${address} returning 1`;
    console.log(rows.length ? `removed: ${address} from ${net}` : `${address} was not a member on ${net}`);
  } else {
    console.error('usage: npm run members [-- list | add <address> [note…] | remove <address>] [--network devnet|mainnet]');
    process.exitCode = 2;
  }
} catch (err) {
  // SQLSTATE and message only. 23514 is the wallet_address domain refusing the value.
  console.error(`members failed on ${where(url)}: ${err.code ?? ''} ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
