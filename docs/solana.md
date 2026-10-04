# Solana

Everything changuito does on chain, on **devnet only**. One Anchor program, one
mock USDC mint, one server key, and the shopper's Privy wallet.

Explorer links use Solscan with `?cluster=devnet`.

## Deployment

| What | Address |
|---|---|
| Program `changuito_escrow` (Anchor 0.32) | [`9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9`](https://solscan.io/account/9A2PXJafYxym4i8ah1QFQZngqz2j7rQh8xQX2eXB2wC9?cluster=devnet) |
| Config PDA `["config"]` | [`BfMWiygm3XRab8xbJC355rxRZ4DFYqR2vyi1gjSjWyTQ`](https://solscan.io/account/BfMWiygm3XRab8xbJC355rxRZ4DFYqR2vyi1gjSjWyTQ?cluster=devnet) |
| Mock USDC mint (6 decimals, authority = resolver) | [`9rYNCiaaKQ5rT1QR8Ar6FJVUr7gnwZy3RYAT6MtAtdMM`](https://solscan.io/account/9rYNCiaaKQ5rT1QR8Ar6FJVUr7gnwZy3RYAT6MtAtdMM?cluster=devnet) |
| Resolver (settles, refunds, mints faucet USDC, pays `open` fees) | [`AgTnHC9dmyuzjwp3oCRzaYrZbgeXD4tC2uSXmKhiyqQ5`](https://solscan.io/account/AgTnHC9dmyuzjwp3oCRzaYrZbgeXD4tC2uSXmKhiyqQ5?cluster=devnet) |
| Treasury (owner) | [`EV5c3mjEHBtTU6JmX31eLsfKX5zPgMVDEiKDhqjApZPS`](https://solscan.io/account/EV5c3mjEHBtTU6JmX31eLsfKX5zPgMVDEiKDhqjApZPS?cluster=devnet) |
| Treasury USDC token account | [`HVsDJbwmsa2oTUpddQMSSUzKF6Z4PvQRU96d7n95owxa`](https://solscan.io/account/HVsDJbwmsa2oTUpddQMSSUzKF6Z4PvQRU96d7n95owxa?cluster=devnet) |
| Program upgrade authority (deployer) | [`2AF3x8xhFfGaLHf5CPX7YZyS5aywQkNfu51gV1Sjt15k`](https://solscan.io/account/2AF3x8xhFfGaLHf5CPX7YZyS5aywQkNfu51gV1Sjt15k?cluster=devnet) |

Source of truth: `deployments.json` at the repo root, turned into
`apps/web/lib/deployments.ts` by `scripts/write-deployments-module.mjs`.

The program is deployed with the standard upgradeable loader and **is not
frozen**: the deployer key can redeploy it. On devnet that is intended; it is
also the one key that could change every rule below.

---

## The program

Source: `anchor/programs/changuito_escrow/src/lib.rs`. It is a port of the
Soroban escrow this project started with; auth rules and error names were kept
on purpose.

Why an escrow and not a transfer: between "the shopper approved this basket"
and "an agent carried it through the store's checkout", prices move, items go
out of stock, stores reject carts. The escrow holds the money across that gap
with three properties a transfer does not have:

1. **Recoverable.** A failed basket refunds; after the deadline the buyer can
   refund without anyone's cooperation.
2. **Committed.** `basket_hash` pins the exact lines and total the shopper
   approved; settle must present the same hash.
3. **Auditable.** Settle stores a receipt hash, and every transition emits an
   event.

### Accounts and PDAs

| Account | Seeds | Owner / authority | Lifetime |
|---|---|---|---|
| `Config` | `["config"]` | program | created once by `initialize`, never modified |
| `Order` | `["order", order_id]` | program | created by `open`, **kept** after close as the record |
| vault (SPL token account) | `["vault", order_id]` | token authority = the Order PDA | created by `open`, **closed** by settle/refund |

`order_id` is 32 random bytes chosen by the server at quote time.

**Config** — `8 + 32 + 32 + 32 + 1 = 105` bytes:

| Field | Type |
|---|---|
| `resolver` | Pubkey |
| `treasury` | Pubkey (owner of the treasury token account) |
| `mint` | Pubkey (the only accepted mint) |
| `bump` | u8 |

**Order** — 163 bytes (`ORDER_SIZE` in `lib/escrow.ts`):

| Offset | Field | Type | Notes |
|---|---|---|---|
| 0 | discriminator | [u8; 8] | `[134,173,223,185,77,86,28,51]` |
| 8 | `order_id` | [u8; 32] | |
| 40 | `buyer` | Pubkey | the `memcmp` offset the purchases list filters on |
| 72 | `amount` | u64 | USDC base units (6 decimals) |
| 80 | `basket_hash` | [u8; 32] | SHA-256 of `canonicalBasket` (`lib/order.ts`) |
| 112 | `status` | u8 | 0 Open, 1 Settled, 2 Refunded |
| 113 | `opened_at` | i64 | unix seconds |
| 121 | `deadline` | i64 | `opened_at + timeout_secs` |
| 129 | `receipt_hash` | [u8; 32] | zeros until settled |
| 161 | `bump` | u8 | |
| 162 | `vault_bump` | u8 | |

### Instructions

| Instruction | Signer | Accounts that matter | Checks | Effect |
|---|---|---|---|---|
| `initialize(resolver, treasury)` | any payer | `config` (init), `mint` | `init` fails if Config exists | writes resolver, treasury, mint. No admin, no setter: "a resolver that could be swapped is a resolver that could be stolen" |
| `open(order_id, amount, basket_hash, timeout_secs)` | buyer | `buyer_token` (mint = config.mint, authority = buyer), `order` (init), `vault` (init) | `amount > 0` → else `InvalidAmount`; `300 ≤ timeout_secs ≤ 2 592 000` (5 min–30 days) → else `InvalidTimeout`; `init` fails if the order already exists; `config.mint == mint` | USDC buyer → vault; buyer pays rent for Order and vault; emits `Opened` |
| `settle(basket_hash, receipt_hash)` | resolver | `config` (`has_one = resolver`), `order`, `vault`, `treasury_token` (mint = config.mint, `owner == config.treasury`), `buyer` (= order.buyer) | signer is `config.resolver` → else `NotAuthorized`; destination owned by treasury → else `NotAuthorized`; `status == Open` → else `OrderClosed`; hash equal → else `BasketMismatch` | status ← Settled, store `receipt_hash`; vault → treasury; close vault, rent → buyer; emits `Settled` |
| `refund()` | resolver **or** buyer | `order`, `vault`, `buyer_token` (mint = config.mint, authority = order.buyer), `buyer` | `status == Open` → else `OrderClosed`; caller is resolver, or caller is buyer and `now ≥ deadline` → else `NotAuthorized` | status ← Refunded; vault → buyer; close vault, rent → buyer; emits `Refunded` |

Status is written before the token CPIs, so nothing in the transaction can
observe an Open order mid-transfer.

### Errors

| Code | Message |
|---|---|
| `OrderClosed` | the order is no longer open |
| `NotAuthorized` | neither the resolver nor, after the deadline, the buyer |
| `InvalidAmount` | amount must be positive |
| `InvalidTimeout` | timeout must be between 5 minutes and 30 days |
| `BasketMismatch` | basket hash does not match the opened order |

### Events

| Event | Fields |
|---|---|
| `Opened` | `order_id`, `buyer`, `amount`, `basket_hash`, `deadline` |
| `Settled` | `order_id`, `buyer`, `amount`, `receipt_hash` |
| `Refunded` | `order_id`, `buyer`, `amount`, `self_service` (true when the buyer refunded after the deadline) |

### What the resolver can and cannot do

The resolver is a hot key on the web server. The program limits it to:

- settle an **open** order whose basket hash it can name, **only into a token
  account owned by the configured treasury**;
- refund an open order, **only into a token account whose authority is the
  order's buyer**.

Outside the program, it is also the fee payer for every `open`, and co-signs
only the exact message the server built for that order (see
[Wallet](#wallet-privy-embedded-wallet-resolver-paid-fees)).

It cannot pick a destination, cannot change config, and cannot close an order
twice. Its realistic abuse is settling an order whose basket did not reach
checkout, or refunding early. The buyer does not depend on it to get money
back: after `deadline` (one hour in the app) `refund` accepts the buyer's
signature.

---

## The client: `@solana/kit`, hand-written

`apps/web/lib/escrow.ts` is ~200 lines against the IDL
(`anchor/target/idl/changuito_escrow.json`): PDA derivation, the four
instruction builders, `decodeOrder`. Four instructions and two layouts did not
earn a code generator, and the discriminators are the only constants that move
if the program changes. It has no relative imports, so the browser, the API
routes and `scripts/solana-init.mts` share it.

| Caller | File | Does |
|---|---|---|
| Server | `lib/checkout/open-tx.ts` | builds a v0 `open` transaction, resolver as fee payer, for the buyer's Privy wallet to sign (`/api/checkout/open`) |
| Server | `lib/checkout/escrow-server.ts` | `readOrder`, `settleOrder`, `refundOrder` (resolver-signed), `ordersOf` (purchases list) |
| Server | `lib/solana.ts` | `sendIxs`: sign, send, then poll `getSignatureStatuses` until confirmed (no websockets in serverless; a 429 is treated as a pause) |

**The chain is the purchases database.** `ordersOf(buyer)` is
`getProgramAccounts` with `memcmp` on the Order discriminator at offset 0 and
the buyer at offset 40. `GET /api/checkout/orders` serves it; there is no
orders table.

## Wallet: Privy embedded wallet, resolver-paid fees

- Login is Privy email or Google (`@privy-io/react-auth` 3.47,
  `loginMethods: ['email', 'google']`). A Solana embedded wallet is created on
  first login.
- The wallet **only signs**: `wallet.signTransaction` (Privy
  `useSignTransaction`, `components/WalletProvider.tsx`, `lib/use-wallet.ts`),
  no send. Privy gas sponsorship is not used.
- The **resolver pays the transaction fee** for `open`, in two calls to
  `/api/checkout/open` (`app/api/checkout/open/route.ts`):
  1. `POST {orderId}` builds the v0 `open` with `feePayer = resolver`
     (`lib/checkout/open-tx.ts`), stores its base64 message bytes on the
     checkout record as `openMessage`, and returns the transaction unsigned.
  2. The browser signs it as the buyer and sends `PUT {orderId, tx}`. The
     server refuses it unless the message bytes equal `openMessage` exactly
     and the buyer's ed25519 signature verifies, then adds the resolver's
     signature (`partiallySignTransaction`), sends, waits for confirmation and
     stores `openSig`.

  **The exact-bytes check is the rule.** A key that pays fees must never
  co-sign arbitrary bytes from the browser; it signs only the one message it
  built for that quote.
- The resolver does **not** pay **rent**: the program has `payer = buyer` for
  both accounts `open` creates, the Order (163 bytes, ≈0.00203 SOL) and the
  vault (165-byte token account, ≈0.00204 SOL). On settle or refund the
  **vault** is closed and its rent returns to the buyer; the **Order** account
  is kept as the on-chain receipt, so its ≈0.002 SOL stays locked per order.
- To cover that, the faucet sends 0.01 SOL along with the USDC whenever the
  wallet holds less than 0.006 SOL.

Verified on devnet: [`DRzvSuVN…NoCgrSfWA`](https://solscan.io/tx/DRzvSuVNZQXwQWYkMyDpU9s8ApkHHjjPwK7XkLdRFRzq5PBSZTdCdqTHPnhcCdHSXa42mGfQCHS5wfNoCgrSfWA?cluster=devnet)
is an `open` with the resolver as fee payer; the buyer went from 0.01 to
0.00703328 SOL, which is rent only.

**The trade-off.** The resolver hot key now also pays every shopper's `open`
fee (two signatures, ≈0.00001 SOL), so it has to be kept topped up with
devnet SOL; when it runs dry, nobody can lock. Abuse is bounded: a quote
needs a signed-in session, and the resolver co-signs only the message built
for that quote.

Privy dashboard settings the app needs: email and Google login, Solana
embedded wallets (create on login), and allowed origins
(`http://localhost:3124` plus the production domain). Gas sponsorship is not
needed.

## Faucet (mock USDC)

`POST /api/faucet` — cookie-authenticated and behind the human gate. The
address comes from the `chg_user` cookie, never the body. One resolver-signed
transaction:

1. create the shopper's USDC associated token account (idempotent);
2. `mint_to` 50 USDC (the resolver is the mint authority);
3. transfer 0.01 SOL if the wallet holds less than 0.006 SOL.

Policy (`lib/faucet-policy.ts`): grant 50, refuse at a balance of 100 or more,
60-second per-instance cooldown.

This USDC is worthless by construction. It exists so a judge can run the whole
flow without a stablecoin faucet.

## Server environment

| Variable | Purpose |
|---|---|
| `SOLANA_RESOLVER_SECRET` | resolver keypair, JSON byte array or base58. Refused by name if its public key is not the one in `deployments.json` |
| `SOLANA_RPC_URL` / `NEXT_PUBLIC_SOLANA_RPC_URL` | optional; defaults to `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` | token verification audience; wallet lookup |

## Redeploying

Keys live in `~/.config/solana/changuito/` (`deployer.json`, `resolver.json`,
`treasury.json`, `program.json`) and are never committed.

```sh
scripts/solana-deploy.sh                 # build + deploy + initialize + smoke
SKIP_BUILD=1 scripts/solana-deploy.sh    # reuse anchor/target/deploy/*.so
```

What it runs:

1. `cargo build-sbf --tools-version v1.52` and `anchor idl build` (older
   platform-tools cannot parse edition-2024 crates in the dependency tree).
2. `solana program deploy` with `program.json` as the program id and
   `deployer.json` as payer and upgrade authority.
3. `scripts/solana-init.mts`: `initialize(resolver, treasury)` if Config does
   not exist, then a smoke test (open → settle, open → refund, deployer as
   buyer), then writes `deployments.json`. `--no-smoke` skips the smoke.
4. `scripts/write-deployments-module.mjs` → `apps/web/lib/deployments.ts`.

A route-level end-to-end run against `next dev` and the mock sandbox, with a
throwaway keypair in place of Privy:

```sh
node --experimental-strip-types scripts/devnet-e2e.mts [http://localhost:3124]
# faucet → quote → sign + send open → start → poll status
# with SANDBOX_MOCK_FAIL=1 on the dev server, the same run ends in a refund
```

Note: `initialize` accepts any payer, so on a fresh deploy it should run
immediately after the deploy (the script does). On the current deployment
Config already exists and cannot be re-initialized.

---

## Evidence transactions

Deployment (from `deployments.json`):

| Step | Transaction |
|---|---|
| Program deploy | [`3f3caazB…4SQ91YjmC`](https://solscan.io/tx/3f3caazBpPsDmcvQnKzGgdM7H1GPMeNiZoD6Z8yq7H8JX8tdrEmfXMA2gBuDSNBbRqCsq51KF6VtLCG4SQ91YjmC?cluster=devnet) |
| `initialize` | [`3mWgS3g9…foWUu7Xj2`](https://solscan.io/tx/3mWgS3g9iCju1J9p8s6563KRQfG3juVCX2mwFqURJB2oYVWzvAimMgPqxjMNsJUFY64unGUtBcwsyzsfoWUu7Xj2?cluster=devnet) |
| Smoke: fund deployer | [`2bahH3CV…Eq6Cjux`](https://solscan.io/tx/2bahH3CVovSMEKLELkjJUYq1JTtnJkLcxUGSHVc4UaiSDPj5MT2cB1SCVJAX4uJfoP4z5HM2rUDryCmmEqa6Cjux?cluster=devnet) |
| Smoke: `open` (settle path) | [`5Hw7m8aq…uJJFNPr`](https://solscan.io/tx/5Hw7m8aq638nYbY9MY5C8bDs4XC4AjqNAESgEVpErLMcYvkMkdmrghHUtQkR2k9Ex7XfWFzVnPsyHztzmuJJFNPr?cluster=devnet) |
| Smoke: `settle` | [`z5Qq1C15…CFjwew8`](https://solscan.io/tx/z5Qq1C15CTsqC94R3mGrgEzqr29LNstTmFm4mEr3nVb3gY2Yna7LhL3mG2EoPuosiun9NLAKG77E3tSPCFjwew8?cluster=devnet) |
| Smoke: `open` (refund path) | [`C7VcfqHY…VTgomNz`](https://solscan.io/tx/C7VcfqHYVTNAkjP8T8isTWcfVhfewHgU4U8ZZQXEDnoMtLvLoiDrVf8Te4UwKS5zg7D45PdKbfmvrK8mVTgomNz?cluster=devnet) |
| Smoke: `refund` | [`5GtMF7Jv…HjFQA47e`](https://solscan.io/tx/5GtMF7JvPdcog9d7oebhdwtgfw45yPY8Nh6mS6TE5pdXmBXcYad7saFPHsxriqUry4fYLAWqqXboKAM5HjFQA47e?cluster=devnet) |

Route-level e2e (`scripts/devnet-e2e.mts` against `next dev` + mock sandbox,
2026-10-04):

| Path | Step | Transaction |
|---|---|---|
| settle | faucet (ATA + 50 USDC + SOL) | [`36qKsuaG…6zWUzgqzL`](https://solscan.io/tx/36qKsuaGykkY9NyrkGG4PKNArByv6fXJtf5bBNNj2sUoQ1cV7DGebdqZJnLXmkdEncZjkRoncaCFDeo6zWUzgqzL?cluster=devnet) |
| settle | `open` — 5.06 USDC for a $6.150 ARS basket at 1400 ARS/USD + 15% | [`5aShGUf3…RAyLze35Z`](https://solscan.io/tx/5aShGUf3h1cJvNuLDUNZXjpBCBEf18bHkq8GpkcnN1D4yJaumBfNJkqNacRqMkBYq7r4FvEtnrTK1ZyRAyLze35Z?cluster=devnet) |
| settle | `settle` | [`32qUpErt…sjGR9a4K`](https://solscan.io/tx/32qUpErth2AG72KvXPCNSDX5NY9ftwsaH7u6SYSpZaB3N6b6Kz8csjhAWpNckTdsEkH53HPBQk2eySDrsjGR9a4K?cluster=devnet) |
| refund (`SANDBOX_MOCK_FAIL=1`) | `open` | [`2vaNKpBu…vYDXHbCZ`](https://solscan.io/tx/2vaNKpBuuYbnfgT3gaZwr2gwcKbYLjgrP2dfAZBzr2PgheuXuHEDedVSkoHdhL6ZDsW88mofSZPjkyFKYvDXHbCZ?cluster=devnet) |
| refund | `refund` | [`244i1Squ…VYExKP`](https://solscan.io/tx/244i1SqumYySTLBSFkEnPRN6KFEqBDWNEC9GQfPU9zEdsouRYVuwdPgtAGYMVY2BULq8KoEsPruPCqrDMyYVExKP?cluster=devnet) |

These e2e runs used the in-process mock sandbox, not the Railway service.

---

## Limitations

- **Devnet and a mock mint.** Nothing here moves real value.
- **Settle is not a purchase.** The resolver settles when the sandbox reaches
  Día's payment step; no order is placed at Día (see [sandbox.md](sandbox.md)).
  The full locked amount, including the 15% FX buffer, goes to the treasury.
- **The receipt hash is not independently reproducible yet.** It is SHA-256 of
  a text that includes the order, buyer, basket hash, amount, the basis
  `sandbox-reached-payment`, the sandbox job id, the sandbox's `orderFormId`
  and a `settledAt` timestamp (`app/api/checkout/status/route.ts`). The
  preimage is not stored anywhere, so a third party cannot recompute it.
- **No self-refund button.** The program allows the buyer to refund after the
  deadline; the UI does not expose it yet.
- **No program tests in the repo for the Anchor port.** It is exercised by the
  deploy smoke and the route-level e2e above. The Soroban original had a unit
  suite; it was not ported.
- **Upgradeable.** The deployer key can replace the program.
