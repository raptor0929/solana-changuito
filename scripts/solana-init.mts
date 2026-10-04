/**
 * Devnet bring-up for the escrow, after `solana program deploy`:
 *
 *   1. initialize(resolver, treasury) — once; skipped when Config exists.
 *   2. Smoke: open → settle and open → refund, with the deployer as buyer.
 *   3. Write deployments.json (Solana shape).
 *
 *   node --experimental-strip-types scripts/solana-init.mts [--no-smoke]
 *
 * Keys come from ~/.config/solana/changuito/*.json and never leave this machine.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { configPda, decodeOrder, initializeIx, openIx, orderPda, refundIx, settleIx } from '../apps/web/lib/escrow.ts';
import { explorerTx, rpc, sendIxs, tokenBalance } from '../apps/web/lib/solana.ts';

const KEYS = join(homedir(), '.config/solana/changuito');
const root = new URL('..', import.meta.url).pathname;
const RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';

const load = async (n: string): Promise<KeyPairSigner> =>
  createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${n}.json`), 'utf8'))));

const PROGRAM = address('9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9');
const MINT = address('9rYNCiaaKQ5rT1QR8Ar6FJVUr7gnwZy3RYAT6MtAtdMM');
const TREASURY = address('EV5c3mjEHBtTU6JmX31eLsfKX5zPgMVDEiKDhqjApZPS');

const deployer = await load('deployer');
const resolver = await load('resolver');
const [treasuryToken] = await findAssociatedTokenPda({ owner: TREASURY, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

// 1. initialize
const cfg = await configPda(PROGRAM);
const existing = await rpc(RPC).getAccountInfo(cfg, { encoding: 'base64' }).send();
let initSig: string | null = null;
if (existing.value) {
  console.log(`config ${cfg} already initialized`);
} else {
  initSig = await sendIxs(deployer, [
    await initializeIx({ program: PROGRAM, payer: deployer.address, mint: MINT, resolver: resolver.address, treasury: TREASURY }),
  ], RPC);
  console.log(`initialize ${explorerTx(initSig)}`);
}

// 2. smoke
const smoke: Record<string, string> = {};
if (!process.argv.includes('--no-smoke')) {
  const buyer = deployer;
  const [buyerToken] = await findAssociatedTokenPda({ owner: buyer.address, mint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  smoke.fund = await sendIxs(resolver, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: resolver, ata: buyerToken, owner: buyer.address, mint: MINT }),
    getMintToInstruction({ mint: MINT, token: buyerToken, mintAuthority: resolver, amount: 2_000_000n }),
  ], RPC);

  const basket = createHash('sha256').update('smoke-basket').digest();
  for (const outcome of ['settle', 'refund'] as const) {
    const orderId = randomBytes(32);
    const open = await sendIxs(buyer, [
      await openIx({ program: PROGRAM, buyer: buyer.address, mint: MINT, buyerToken, orderId, amount: 1_000_000n, basketHash: basket, timeoutSecs: 3600n }),
    ], RPC);
    const close = outcome === 'settle'
      ? await sendIxs(resolver, [
          await settleIx({ program: PROGRAM, resolver: resolver.address, orderId, treasuryToken, buyer: buyer.address, basketHash: basket, receiptHash: createHash('sha256').update('smoke-receipt').digest() }),
        ], RPC)
      : await sendIxs(resolver, [
          await refundIx({ program: PROGRAM, caller: resolver.address, orderId, buyerToken, buyer: buyer.address }),
        ], RPC);
    const acct = await rpc(RPC).getAccountInfo(await orderPda(PROGRAM, orderId), { encoding: 'base64' }).send();
    const order = decodeOrder(Buffer.from(acct.value!.data[0], 'base64'));
    console.log(`${outcome}: open ${explorerTx(open)}\n        ${outcome} ${explorerTx(close)}\n        status=${order?.status}`);
    if (order?.status !== (outcome === 'settle' ? 'settled' : 'refunded')) throw new Error(`smoke ${outcome} ended ${order?.status}`);
    smoke[`${outcome}Open`] = open;
    smoke[outcome] = close;
  }
  console.log(`treasury USDC: ${Number(await tokenBalance(treasuryToken, RPC)) / 1e6}`);
}

// 3. deployments.json
const path = join(root, 'deployments.json');
const prev = (() => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } })();
const out = {
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  programId: PROGRAM,
  usdcMint: MINT,
  usdcDecimals: 6,
  resolver: resolver.address,
  treasury: TREASURY,
  treasuryToken,
  config: cfg,
  deployedAt: prev.cluster === 'devnet' ? prev.deployedAt : new Date().toISOString(),
  evidence: { ...(prev.evidence ?? {}), ...(initSig ? { initialize: initSig } : {}), ...(Object.keys(smoke).length ? { smoke } : {}) },
};
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
console.log('wrote deployments.json');
