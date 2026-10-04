# changuito — documentation

changuito is a chat app where an agent shops an Argentine supermarket over MCP,
locks the basket's USDC equivalent in a Solana escrow, and has a browser agent
walk the store's real checkout with that basket. Reaching the payment step
settles the escrow; anything else refunds it. Solana devnet only.

**Reviewing this for a hackathon? Start at [judges.md](judges.md).**

| Document | What is in it |
|---|---|
| [judges.md](judges.md) | fifteen minutes in order, every claim mapped to a file or a devnet transaction, what is real versus simulated, and prior work |
| [architecture.md](architecture.md) | the system diagram and where the trust boundaries fall |
| [flows.md](flows.md) | the paths that matter, end to end: a chat turn, signing in, checkout, refund, the faucet |
| [solana.md](solana.md) | the escrow program, its accounts, and the devnet evidence |
| [sandbox.md](sandbox.md) | the checkout robot: what it does on Día's site, what it is kept from doing, and how it is served |
| [tech-stack.md](tech-stack.md) | the dependency list with versions, the data stores, every environment variable, and the Privy setup |
| [e2e.md](e2e.md) | Playwright smokes against the live sites, and the GitHub Actions secrets |

Elsewhere in the repo:

- [`../README.md`](../README.md) — what changuito is and what was verified on devnet.
- [`../DEPLOY.md`](../DEPLOY.md) — the app on Vercel, the sandbox on Railway, and
  redeploying the program.
- [`../CLAUDE.md`](../CLAUDE.md) — how the agent's behaviour was arrived at, and
  which decisions not to undo.
- [`../packages/mcp/VENDORED.md`](../packages/mcp/VENDORED.md) — what changed in
  the MCP server on the way into this repo.

## The shortest possible summary

```
  "armá un desayuno por menos de $10.000"
        │
        ▼
  agent searches Día over MCP, builds a real cart, hands back a real cart link
        │
        ▼
  Pagar → sign in with email or Google (Privy creates a Solana wallet)
        │
        ▼
  the server quotes the cart in USDC (live ARS/USD + 15% for envío)
        │
        ▼
  one transaction, buyer-signed, fee paid by the resolver:
  USDC ──► escrow vault (an Order account on chain)
        │
        ▼
  the server checks the order on chain, then the sandbox walks Día's
  checkout with the basket, and stops at the payment step
        │
        ├── reached payment ──► settle: vault ──► treasury, receipt hash on chain
        │                       "¡Compra completada!" + the shopper's cart link
        │
        └── anything else ────► refund: vault ──► buyer
```

**No order is placed at Día.** The sandbox stops before card entry; settle
records that the basket got to checkout, and the shopper finishes at Día with
their own cart link. The USDC is a devnet mint handed out by the in-app faucet.
[judges.md](judges.md#4-what-is-real-and-what-is-not) has the full list.
