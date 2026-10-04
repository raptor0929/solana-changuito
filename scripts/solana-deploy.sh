#!/usr/bin/env bash
#
# Build and deploy the escrow to Solana devnet, initialize it, smoke it and
# record the result in deployments.json + apps/web/lib/deployments.ts.
#
#   scripts/solana-deploy.sh            # build + deploy + init + smoke
#   SKIP_BUILD=1 scripts/solana-deploy.sh
#
# Keys live in ~/.config/solana/changuito/ (deployer, resolver, treasury,
# program). Devnet only: the cluster is hard-coded on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS="$HOME/.config/solana/changuito"
URL="${SOLANA_RPC_URL:-https://api.devnet.solana.com}"

if [[ -z "${SKIP_BUILD:-}" ]]; then
  # platform-tools v1.52: older ones cannot parse edition-2024 crates in the tree.
  (cd anchor/programs/changuito_escrow && cargo build-sbf --tools-version v1.52)
  (cd anchor && anchor idl build -o target/idl/changuito_escrow.json)
fi

solana program deploy anchor/target/deploy/changuito_escrow.so \
  --program-id "$KEYS/program.json" \
  --keypair "$KEYS/deployer.json" \
  --url "$URL"

node --experimental-strip-types scripts/solana-init.mts
node scripts/write-deployments-module.mjs
