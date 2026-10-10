//! Escrow for a grocery basket paid in USDC.
//!
//! The gap this exists to cover: the shopper's money leaves their wallet when
//! they press pay, but the basket is only real once an agent has carried it
//! through the supermarket's checkout. In between, a price can move, an item can
//! go out of stock, or the store can reject the cart. Something has to hold the
//! money across that gap and be able to give it back.
//!
//! ```text
//!   open(order_id, amount, basket_hash)        USDC: buyer -> vault (PDA)
//!     |
//!     +-- checkout reached  -> settle(basket_hash, receipt_hash) -> treasury
//!     |
//!     +-- checkout failed   -> refund()                          -> buyer
//! ```
//!
//! Three properties a plain transfer does not have:
//!
//! 1. The money is recoverable. A failed basket refunds without anyone's goodwill.
//! 2. The basket is committed. `basket_hash` pins the exact lines and total the
//!    shopper approved, so the resolver cannot settle against a different one.
//! 3. The receipt is auditable. `settle` stores the checkout run's hash, and
//!    every transition emits an event.
//!
//! And the property that stops it being a custodial box with extra steps: after
//! `deadline`, the buyer can refund themselves. The resolver's cooperation is
//! required for the happy path only.
//!
//! Ported from the Soroban contract this project started with; the auth rules
//! and error names are the same on purpose.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("BFa1gZL9kVVo8Mq5gaDRM5RiCG4NDiyHLbpymfXvLz9d");

/// Bounds on `timeout_secs`, so a caller cannot set a deadline that has already
/// passed (instant self-refund) or one so far out the money is effectively gone.
pub const MIN_TIMEOUT: i64 = 300; // 5 minutes
pub const MAX_TIMEOUT: i64 = 30 * 24 * 60 * 60; // 30 days

pub const CONFIG_SEED: &[u8] = b"config";
pub const ORDER_SEED: &[u8] = b"order";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod changuito_escrow {
    use super::*;

    /// One-time setup. There is no admin and no way to change these later:
    /// a resolver that could be swapped is a resolver that could be stolen.
    pub fn initialize(ctx: Context<Initialize>, resolver: Pubkey, treasury: Pubkey) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        cfg.resolver = resolver;
        cfg.treasury = treasury;
        cfg.mint = ctx.accounts.mint.key();
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    /// The buyer locks `amount` of the configured mint against `order_id`.
    /// An id can be opened once: `init` fails if the order already exists.
    pub fn open(
        ctx: Context<Open>,
        order_id: [u8; 32],
        amount: u64,
        basket_hash: [u8; 32],
        timeout_secs: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(
            (MIN_TIMEOUT..=MAX_TIMEOUT).contains(&timeout_secs),
            EscrowError::InvalidTimeout
        );

        let now = Clock::get()?.unix_timestamp;
        let order = &mut ctx.accounts.order;
        order.order_id = order_id;
        order.buyer = ctx.accounts.buyer.key();
        order.amount = amount;
        order.basket_hash = basket_hash;
        order.status = Status::Open;
        order.opened_at = now;
        order.deadline = now + timeout_secs;
        order.receipt_hash = [0u8; 32];
        order.bump = ctx.bumps.order;
        order.vault_bump = ctx.bumps.vault;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(Opened {
            order_id,
            buyer: order.buyer,
            amount,
            basket_hash,
            deadline: order.deadline,
        });
        Ok(())
    }

    /// The resolver releases the vault to the treasury once checkout reached
    /// the store's payment step. The basket hash must match what was opened.
    pub fn settle(ctx: Context<Settle>, basket_hash: [u8; 32], receipt_hash: [u8; 32]) -> Result<()> {
        let order = &mut ctx.accounts.order;
        require!(order.status == Status::Open, EscrowError::OrderClosed);
        require!(order.basket_hash == basket_hash, EscrowError::BasketMismatch);

        // Status first: nothing below can observe an Open order mid-transfer.
        order.status = Status::Settled;
        order.receipt_hash = receipt_hash;
        let amount = order.amount;
        let order_id = order.order_id;
        let bump = order.bump;
        let buyer = order.buyer;

        drain(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.treasury_token,
            &ctx.accounts.buyer,
            &ctx.accounts.order.to_account_info(),
            order_id,
            bump,
            amount,
        )?;

        emit!(Settled { order_id, buyer, amount, receipt_hash });
        Ok(())
    }

    /// Money back to the buyer. The resolver may refund at any time; the buyer
    /// only once the deadline has passed. Anyone else is refused.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        let caller = ctx.accounts.caller.key();
        let order = &mut ctx.accounts.order;
        require!(order.status == Status::Open, EscrowError::OrderClosed);

        let by_resolver = caller == cfg.resolver;
        let now = Clock::get()?.unix_timestamp;
        let buyer_after_deadline = caller == order.buyer && now >= order.deadline;
        require!(by_resolver || buyer_after_deadline, EscrowError::NotAuthorized);

        order.status = Status::Refunded;
        let amount = order.amount;
        let order_id = order.order_id;
        let bump = order.bump;
        let buyer = order.buyer;

        drain(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.buyer_token,
            &ctx.accounts.buyer,
            &ctx.accounts.order.to_account_info(),
            order_id,
            bump,
            amount,
        )?;

        emit!(Refunded { order_id, buyer, amount, self_service: !by_resolver });
        Ok(())
    }
}

/// Empty the vault into `to`, then close it and hand its rent to the buyer,
/// who paid it at `open`. The order PDA signs for both.
#[allow(clippy::too_many_arguments)]
fn drain<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    to: &Account<'info, TokenAccount>,
    rent_to: &AccountInfo<'info>,
    order: &AccountInfo<'info>,
    order_id: [u8; 32],
    bump: u8,
    amount: u64,
) -> Result<()> {
    let seeds: &[&[u8]] = &[ORDER_SEED, &order_id, &[bump]];
    let signer = &[seeds];
    token::transfer(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            Transfer {
                from: vault.to_account_info(),
                to: to.to_account_info(),
                authority: order.clone(),
            },
            signer,
        ),
        amount,
    )?;
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to.clone(),
            authority: order.clone(),
        },
        signer,
    ))
}

// ---------------------------------------------------------------- accounts --

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(order_id: [u8; 32])]
pub struct Open<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Order::INIT_SPACE,
        seeds = [ORDER_SEED, order_id.as_ref()],
        bump
    )]
    pub order: Account<'info, Order>,
    #[account(
        init,
        payer = buyer,
        seeds = [VAULT_SEED, order_id.as_ref()],
        bump,
        token::mint = mint,
        token::authority = order
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub resolver: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = resolver @ EscrowError::NotAuthorized)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ORDER_SEED, order.order_id.as_ref()], bump = order.bump, has_one = buyer)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [VAULT_SEED, order.order_id.as_ref()], bump = order.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, constraint = treasury_token.owner == config.treasury @ EscrowError::NotAuthorized)]
    pub treasury_token: Account<'info, TokenAccount>,
    /// CHECK: receives the vault's rent; pinned to `order.buyer` by `has_one`.
    #[account(mut)]
    pub buyer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [ORDER_SEED, order.order_id.as_ref()], bump = order.bump, has_one = buyer)]
    pub order: Account<'info, Order>,
    #[account(mut, seeds = [VAULT_SEED, order.order_id.as_ref()], bump = order.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.mint, token::authority = buyer)]
    pub buyer_token: Account<'info, TokenAccount>,
    /// CHECK: receives the vault's rent; pinned to `order.buyer` by `has_one`.
    #[account(mut)]
    pub buyer: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
}

// ------------------------------------------------------------------- state --

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub resolver: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Status {
    Open,
    Settled,
    Refunded,
}

/// Kept after the order closes, as the on-chain record of it. The vault is
/// what gets closed; this account costs ~0.002 SOL and is the receipt.
#[account]
#[derive(InitSpace)]
pub struct Order {
    pub order_id: [u8; 32],
    pub buyer: Pubkey,
    pub amount: u64,
    pub basket_hash: [u8; 32],
    pub status: Status,
    pub opened_at: i64,
    pub deadline: i64,
    pub receipt_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

// ------------------------------------------------------------------ events --

#[event]
pub struct Opened {
    pub order_id: [u8; 32],
    pub buyer: Pubkey,
    pub amount: u64,
    pub basket_hash: [u8; 32],
    pub deadline: i64,
}

#[event]
pub struct Settled {
    pub order_id: [u8; 32],
    pub buyer: Pubkey,
    pub amount: u64,
    pub receipt_hash: [u8; 32],
}

#[event]
pub struct Refunded {
    pub order_id: [u8; 32],
    pub buyer: Pubkey,
    pub amount: u64,
    pub self_service: bool,
}

// ------------------------------------------------------------------ errors --

#[error_code]
pub enum EscrowError {
    #[msg("the order is no longer open")]
    OrderClosed,
    #[msg("neither the resolver nor, after the deadline, the buyer")]
    NotAuthorized,
    #[msg("amount must be positive")]
    InvalidAmount,
    #[msg("timeout must be between 5 minutes and 30 days")]
    InvalidTimeout,
    #[msg("basket hash does not match the opened order")]
    BasketMismatch,
}
