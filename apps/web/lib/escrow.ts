/**
 * Client for anchor/programs/changuito_escrow, written by hand against the IDL
 * (anchor/target/idl/changuito_escrow.json). Four instructions and two account
 * layouts do not earn a generator; the discriminators below are copied from the
 * IDL and are the only thing that has to move if the program does.
 *
 * Shared by the browser (open), the server (settle, refund, reads) and
 * scripts/solana-init.mts, so it imports packages only — no relative imports.
 */
import {
  AccountRole,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
} from '@solana/kit';

export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

const DISC = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  open: [228, 220, 155, 71, 199, 189, 60, 45],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  refund: [2, 96, 183, 251, 63, 208, 46, 46],
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Order: [134, 173, 223, 185, 77, 86, 28, 51],
} as const;

const enc = new TextEncoder();
const addr = getAddressEncoder();

function concat(...parts: (ReadonlyUint8Array | readonly number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p as ArrayLike<number>, o);
    o += p.length;
  }
  return out;
}

function bytes32(b: Uint8Array, what: string): Uint8Array {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes`);
  return b;
}

export const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
export const bytesToHex = (b: ArrayLike<number>): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- PDAs

export async function configPda(program: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [enc.encode('config')] });
  return pda;
}
export async function orderPda(program: Address, orderId: Uint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [enc.encode('order'), bytes32(orderId, 'orderId')] });
  return pda;
}
export async function vaultPda(program: Address, orderId: Uint8Array): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: [enc.encode('vault'), bytes32(orderId, 'orderId')] });
  return pda;
}

// ---------------------------------------------------------- instructions

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE });
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY });
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER });
const rs = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER });

export async function initializeIx(p: { program: Address; payer: Address; mint: Address; resolver: Address; treasury: Address }): Promise<Instruction> {
  return {
    programAddress: p.program,
    accounts: [ws(p.payer), w(await configPda(p.program)), r(p.mint), r(SYSTEM_PROGRAM)],
    data: concat(DISC.initialize, addr.encode(p.resolver), addr.encode(p.treasury)),
  };
}

export async function openIx(p: {
  program: Address; buyer: Address; mint: Address; buyerToken: Address;
  orderId: Uint8Array; amount: bigint; basketHash: Uint8Array; timeoutSecs: bigint;
}): Promise<Instruction> {
  return {
    programAddress: p.program,
    accounts: [
      ws(p.buyer), r(await configPda(p.program)), r(p.mint), w(p.buyerToken),
      w(await orderPda(p.program, p.orderId)), w(await vaultPda(p.program, p.orderId)),
      r(TOKEN_PROGRAM), r(SYSTEM_PROGRAM),
    ],
    data: concat(
      DISC.open, bytes32(p.orderId, 'orderId'), getU64Encoder().encode(p.amount),
      bytes32(p.basketHash, 'basketHash'), getI64Encoder().encode(p.timeoutSecs),
    ),
  };
}

export async function settleIx(p: {
  program: Address; resolver: Address; orderId: Uint8Array; treasuryToken: Address; buyer: Address;
  basketHash: Uint8Array; receiptHash: Uint8Array;
}): Promise<Instruction> {
  return {
    programAddress: p.program,
    accounts: [
      rs(p.resolver), r(await configPda(p.program)), w(await orderPda(p.program, p.orderId)),
      w(await vaultPda(p.program, p.orderId)), w(p.treasuryToken), w(p.buyer), r(TOKEN_PROGRAM),
    ],
    data: concat(DISC.settle, bytes32(p.basketHash, 'basketHash'), bytes32(p.receiptHash, 'receiptHash')),
  };
}

export async function refundIx(p: {
  program: Address; caller: Address; orderId: Uint8Array; buyerToken: Address; buyer: Address;
}): Promise<Instruction> {
  return {
    programAddress: p.program,
    accounts: [
      rs(p.caller), r(await configPda(p.program)), w(await orderPda(p.program, p.orderId)),
      w(await vaultPda(p.program, p.orderId)), w(p.buyerToken), w(p.buyer), r(TOKEN_PROGRAM),
    ],
    data: concat(DISC.refund),
  };
}

// --------------------------------------------------------------- accounts

export type OrderStatus = 'open' | 'settled' | 'refunded';

export interface OrderAccount {
  orderId: string; // hex
  buyer: Address;
  amount: bigint;
  basketHash: string; // hex
  status: OrderStatus;
  openedAt: number;
  deadline: number;
  receiptHash: string; // hex, zeros until settled
}

/** Size of an Order account on chain: 8 disc + 32+32+8+32+1+8+8+32+1+1. */
export const ORDER_SIZE = 163;
export const ORDER_DISCRIMINATOR = Uint8Array.from(DISC.Order);

export function decodeOrder(data: Uint8Array): OrderAccount | null {
  if (data.length < ORDER_SIZE) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== DISC.Order[i]) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const orderId = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const buyer = getAddressDecoder().decode(data.subarray(o, o + 32)); o += 32;
  const amount = v.getBigUint64(o, true); o += 8;
  const basketHash = bytesToHex(data.subarray(o, o + 32)); o += 32;
  const s = data[o]; o += 1;
  const openedAt = Number(v.getBigInt64(o, true)); o += 8;
  const deadline = Number(v.getBigInt64(o, true)); o += 8;
  const receiptHash = bytesToHex(data.subarray(o, o + 32));
  const status: OrderStatus = s === 0 ? 'open' : s === 1 ? 'settled' : 'refunded';
  return { orderId, buyer, amount, basketHash, status, openedAt, deadline, receiptHash };
}

export function isConfigAccount(data: Uint8Array): boolean {
  return data.length >= 8 && DISC.Config.every((b, i) => data[i] === b);
}
