import { ENOUGH_UNITS, GRANT_UNITS } from './faucet-policy.ts';
import { DEFAULT_LANG, INTL_LOCALE, type Lang } from './lang.ts';

/**
 * What the "Cargar USDC" confirmation says.
 *
 * The button used to mint on click, so two taps took an empty wallet to 100
 * USDC with nothing on screen saying that was happening. It is play money,
 * but the button sits beside a real payment flow, and an action that changes
 * a balance should say how much before it does.
 *
 * Amounts come from the policy the faucet route enforces, so the copy cannot
 * promise a grant the server will not make.
 */

const SCALE = 1_000_000n;

/**
 * Token units as money: 500_000_000n -> "50,00", or "50.00" for an English
 * reader. Only the separators follow the language; the figure never does.
 *
 * Built by hand rather than through `Intl` because the input is a bigint and
 * going through a Number to format it is the one thing a token amount must not
 * do. The whole part still goes through `toLocaleString` — that is where the
 * thousands separator comes from, and it is the half that actually differs.
 */
export function usdcAmount(units: bigint, lang: Lang = DEFAULT_LANG): string {
  const whole = units / SCALE;
  const cents = ((units % SCALE) * 100n) / SCALE;
  const point = lang === 'en' ? '.' : ',';
  return `${whole.toLocaleString(INTL_LOCALE[lang])}${point}${cents.toString().padStart(2, '0')}`;
}

export interface FaucetConfirmCopy {
  title: string;
  body: string;
  /** Absent when there is nothing to confirm: the wallet already has enough. */
  confirm?: string;
  dismiss: string;
}

/**
 * `lang` is optional and defaults to Spanish, so the existing call site and the
 * copy test keep the answers they had. The amounts are formatted in the reader's
 * language too: "1.000,00" read as English is off by a factor of a thousand, and
 * this sentence exists to say how much before a balance moves.
 *
 * "practice USDC" rather than "test USDC" for the reason the mode copy gives —
 * a test mode reads like a developer setting somebody left switched on, and this
 * is a thing the shopper is meant to want.
 */
export function faucetConfirmCopy(
  balanceUnits: bigint | null,
  lang: Lang = DEFAULT_LANG,
): FaucetConfirmCopy {
  const grant = usdcAmount(GRANT_UNITS, lang);
  const enough = usdcAmount(ENOUGH_UNITS, lang);

  if (balanceUnits !== null && balanceUnits >= ENOUGH_UNITS) {
    if (lang === 'en') {
      return {
        title: 'You already have a practice balance',
        body: `You have ${usdcAmount(balanceUnits, lang)} practice USDC, enough to complete a purchase. Topping up switches back on when you drop below ${enough} USDC.`,
        dismiss: 'Got it',
      };
    }
    return {
      title: 'Ya tenés saldo de prueba',
      body: `Tenés ${usdcAmount(balanceUnits)} USDC de prueba, suficiente para completar una compra. La carga se habilita otra vez cuando bajás de ${enough} USDC.`,
      dismiss: 'Entendido',
    };
  }

  if (lang === 'en') {
    return {
      title: 'Add practice USDC',
      body: `We'll add ${grant} practice USDC to your account so you can try the payment. It isn't real money and it cannot be withdrawn. You can add ${grant} at a time up to ${enough} USDC.`,
      confirm: `Add ${grant} USDC`,
      dismiss: 'Cancel',
    };
  }

  return {
    title: 'Cargar USDC de prueba',
    body: `Vamos a sumar ${grant} USDC de prueba a tu billetera para que pruebes el pago. No es plata real y no se puede retirar. Podés cargar de a ${grant} hasta llegar a ${enough} USDC.`,
    confirm: `Cargar ${grant} USDC`,
    dismiss: 'Cancelar',
  };
}
