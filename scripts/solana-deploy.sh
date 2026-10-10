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
  # SBPF v3, platform-tools v1.56: Agave 4.3+ refuses v0 deployments, and
  # v1.52 cannot emit v3. Older tools also cannot parse the edition-2024
  # crates in the tree, so there is no going back from here.
  (cd anchor/programs/changuito_escrow && cargo build-sbf --tools-version v1.56 --arch v3)
  # target/idl does not exist on a clean checkout, and `idl build -o` will not
  # create it: it fails with a bare "No such file or directory".
  mkdir -p anchor/target/idl
  (cd anchor && NO_DNA=1 anchor idl build -o target/idl/changuito_escrow.json)
fi

solana program deploy anchor/target/deploy/changuito_escrow.so \
  --program-id "$KEYS/program.json" \
  --keypair "$KEYS/deployer.json" \
  --url "$URL"

node --experimental-strip-types scripts/solana-init.mts
node scripts/write-deployments-module.mjs
