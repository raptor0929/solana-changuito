-- changuito moves from Stellar to Solana devnet.
--
-- The address domain was a Stellar G-address; it is now a base58 Solana
-- public key (32–44 characters, no 0/O/I/l). The domain is renamed so the
-- name stops lying, and the network list gains 'devnet'.
--
-- Both new checks are NOT VALID: rows written under Stellar keep their
-- G-addresses and their 'testnet'/'mainnet' network as a record of what was,
-- and every new row is checked. Nothing in the app reads them back across
-- the switch — orders now live on chain (the escrow program), and the
-- `chat` archive is keyed by session.

alter domain stellar_address drop constraint if exists stellar_address_check;
alter domain stellar_address rename to wallet_address;
alter domain wallet_address
  add constraint wallet_address_check
  check (value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') not valid;

alter domain network_id drop constraint if exists network_id_check;
alter domain network_id
  add constraint network_id_check
  check (value in ('testnet', 'mainnet', 'devnet')) not valid;
