import { DEFAULT_NETWORK, type NetworkId } from './deployments.ts';
import { DEFAULT_LANG, type Lang } from './lang.ts';

/**
 * What the app calls each mode, everywhere a number or a button appears.
 *
 * Two reasons this is a module and not a handful of ternaries in JSX.
 *
 * The first is a bug it fixes. Every "no es plata real" string the app had
 * lived in faucet-copy.ts and faucet-policy.ts — surfaces a visitor only
 * reaches if they are on the faucet allowlist. Everybody else saw a test
 * balance labelled plainly "USDC", beside a button that says Pagar, with no
 * qualifier anywhere. The app was presenting play money as real money to
 * almost everyone who looked at it. Driving the qualifier off the *mode*
 * rather than off faucet access fixes that for every visitor at once.
 *
 * The second is that the chrome has to obey the same rule as the agent:
 * lib/agent/prompt.ts forbids the model from saying testnet, wallet, escrow
 * or blockchain to a user, and it would be a strange app where the model is
 * careful and the buttons are not. So the names are "modo prueba" and "modo
 * real", and a test asserts none of the forbidden words got in.
 */

export interface ModeCopy {
  network: string;
  /** The mode's name, read by a screen reader off the badge. */
  label: string;
  /** The same at phone width, where two full labels do not fit. */
  short: string;
  /** Sits beside the balance. The whole honesty fix is this string. */
  balanceUnit: string;
  /** One line under the balance, explaining what the number is. */
  hint: string;
  /** The confirm button in the payment modal. */
  payLabel: (amount: string) => string;
  /** Prefixed to the note above that button. */
  payNote: string;
  /** What the order panel says while the money is held. */
  holdNote: string;
}

const PRUEBA: ModeCopy = {
  network: 'devnet',
  label: 'Modo prueba',
  short: 'Prueba',
  balanceUnit: 'USDC de prueba',
  hint: 'No es plata real: podés probar todo el pago sin gastar nada.',
  payLabel: (amount) => `Probar el pago de ${amount}`,
  payNote: 'Esto es una prueba: no se mueve plata real.',
  holdNote: 'Es una prueba, así que no se reservó plata real.',
};

const REAL: ModeCopy = {
  network: 'mainnet',
  label: 'Modo real',
  short: 'Real',
  balanceUnit: 'USDC',
  hint: 'Es plata real. Revisá el monto antes de confirmar.',
  payLabel: (amount) => `Pagar ${amount} USDC`,
  payNote: '',
  holdNote: '',
};

const COPY: Record<NetworkId, ModeCopy> = { devnet: PRUEBA };

/**
 * The mode's voice. `lang` is optional and defaults to Spanish, so every
 * existing caller — and `lib/test/mode-copy.test.ts` — keeps the answer it had.
 */
export function modeCopy(net: NetworkId = DEFAULT_NETWORK, lang: Lang = DEFAULT_LANG): ModeCopy {
  return lang === 'en' ? COPY_EN[net] : COPY[net];
}

/**
 * Both, safe one first. There is no toggle to order them for any more — see
 * ModeBadge — but the copy tests iterate this to check every mode's wording,
 * and that is worth more than the array's original caller.
 */
export const MODES: readonly ModeCopy[] = [PRUEBA, REAL];

/**
 * The masthead, for a visitor with no session — which is to say, preview.
 *
 * This replaces "Empezá a comprar", which was written when a signed-out
 * visitor could not do anything and had to sign in first. They can do
 * everything now: search, fill a basket, and watch a payment settle, on our
 * money. So the button is no longer an invitation to start, it is the door
 * out of the demo, and it has to say what is on the other side of it.
 *
 * It says "modo real" and not "iniciá sesión" because signing in is the
 * mechanism, not the consequence. The consequence is that the next payment
 * comes out of their own pocket, and a person who clicks a login button has
 * not agreed to that — they have agreed to log in.
 */
export const PREVIEW_MASTHEAD = {
  /** Sits under the badge, where the balance is in the other mode. */
  hint: 'Entrá con tu email para pagar.',
  /** The crossing. */
  action: 'Iniciar sesión',
} as const;

/**
 * When the number beside the balance cannot be read.
 *
 * Its own string because it used to be whatever the failure happened to say.
 * `useBalances` parsed the response body before checking the status, so a
 * gateway that answered with an HTML error page produced a SyntaxError, and
 * the hook painted its text — `Unexpected token '<', "<!DOCTYPE "…` — in red
 * beside the balance. A server message is written for whoever reads the log,
 * and it is in English, and it names machinery; none of that belongs on a
 * shopper's screen, whatever went wrong.
 *
 * So there is exactly one thing this says, and it is the only thing the
 * shopper can act on: we could not read it, and looking again is free. The
 * number itself already renders as `-` when there is nothing to show, so this
 * line is the explanation and not the absence.
 */
export const BALANCE = {
  unavailable: 'No pudimos leer tu saldo ahora. Probá de nuevo en un rato.',
} as const;

/**
 * The one-time step before the first real payment.
 *
 * Nobody asked for this and nobody will understand why it exists, so the copy
 * does not try to explain the ledger — it says what it costs (nothing), how
 * often it happens (once) and what happens if they would rather not (modo
 * prueba is still there). "Habilitar los dólares" rather than anything truer,
 * because the true word is on the forbidden list and the effect really is
 * that dollars can now reach the account.
 *
 * The way out used to be "seguir en modo prueba". It is not, any more: the
 * mode is the session (lib/app-mode.ts), so offering preview to somebody who
 * is signed in would mean signing them out to keep the promise. The way out
 * is now simply back to the basket, which is where they were.
 */
export const TRUSTLINE = {
  title: 'Falta un paso, una sola vez',
  body: 'Para poder recibir dólares en tu cuenta hay que habilitarlos. Es gratis, tarda unos segundos y no se vuelve a pedir.',
  action: 'Habilitar los dólares',
  working: 'Habilitando…',
  /** Shown when the signature was refused or the network said no. */
  failed: 'No se pudo habilitar. Podés volver a intentar, o dejarlo para después.',
  /** The way out, so a refusal is not a dead end. */
  back: 'Volver al carrito',
} as const;

/**
 * The dialog that hands the shopper their own address so somebody can send
 * money to it.
 *
 * The premise is that they are about to withdraw dollars from wherever they
 * already keep them — Lemon, Belo, Buenbit, Binance — into changuito. Which
 * means the copy has exactly two jobs: give them the address in both forms
 * they might need it (a camera and a clipboard), and name the two ways the
 * transfer can arrive as nothing.
 *
 * Those two are why this says more than "here is your address":
 *
 * - **The network.** A USDC withdrawal asks which chain, and a shopper who
 *   picks Ethereum or Tron sends real money to an address that does not exist
 *   there. It is unrecoverable and it is the single most common way this goes
 *   wrong, so it is the first thing on the screen and it is the one place the
 *   word "Stellar" is allowed to appear — the forbidden list in the agent
 *   prompt is about unprompted blockchain talk in a shopping conversation, and
 *   this is a withdrawal form asking a question only that word answers.
 * - **The asset.** Same address, wrong token, same outcome.
 *
 * No memo: this is the shopper's own wallet, not an exchange's pooled account,
 * and a memo field left empty is correct. Said out loud because every
 * withdrawal form asks, and a shopper who does not know invents one.
 */
export const RECEIVE = {
  title: 'Cargar dólares',
  /** Above the QR. What they are looking at, in case they opened this by accident. */
  lead: 'Esta es tu dirección. Mandá USDC acá desde donde los tengas.',
  qrAlt: 'Código QR con tu dirección',
  addressLabel: 'Tu dirección',
  /** The two answers a withdrawal form asks for, as a list so neither is prose. */
  facts: ['Red: Solana (devnet)', 'Moneda: USDC de prueba', 'Memo: no hace falta'] as readonly string[],
  /** The unrecoverable mistake, said plainly rather than as a warning icon. */
  warn: 'Si elegís otra red, el dinero no llega y no se puede recuperar.',
  dismiss: 'Listo',
} as const;

/* ------------------------------------------------------------------------- *
 * English
 *
 * Everything above is the Spanish original, untouched: `MODES`, `modeCopy`,
 * `PREVIEW_MASTHEAD`, `BALANCE` and `TRUSTLINE` still export the exact strings
 * `lib/test/mode-copy.test.ts` reads, and `modeCopy(net)` with one argument
 * still answers in Spanish. English is a second set of the same keys, selected
 * beside them.
 *
 * The vocabulary rule is not about Spanish. "Practice mode" and "Real mode" are
 * the English names, and neither says testnet, chain or wallet, for the reason
 * the header gives: it would be a strange app where the model is careful in one
 * language and the buttons are careless in the other.
 *
 * "Practice" rather than "Test": a test mode reads like a developer setting
 * somebody left switched on, and this is a mode the shopper is meant to want.
 * ------------------------------------------------------------------------- */

const PRACTICE: ModeCopy = {
  network: 'devnet',
  label: 'Practice mode',
  short: 'Practice',
  balanceUnit: 'practice USDC',
  hint: 'Not real money: you can try the whole payment without spending anything.',
  payLabel: (amount) => `Try paying ${amount}`,
  payNote: 'This is practice: no real money moves.',
  holdNote: "It's practice, so no real money was held.",
};

const LIVE: ModeCopy = {
  network: 'mainnet',
  label: 'Real mode',
  short: 'Real',
  balanceUnit: 'USDC',
  hint: "This is real money. Check the amount before you confirm.",
  payLabel: (amount) => `Pay ${amount} USDC`,
  payNote: '',
  holdNote: '',
};

const COPY_EN: Record<NetworkId, ModeCopy> = { devnet: PRACTICE };

export const MODES_EN: readonly ModeCopy[] = [PRACTICE, LIVE];

export const PREVIEW_MASTHEAD_EN = {
  hint: 'Sign in with your email to pay.',
  action: 'Sign in',
} as const;

export const BALANCE_EN = {
  unavailable: "We couldn't read your balance just now. Try again in a bit.",
} as const;

export const TRUSTLINE_EN = {
  title: 'One step, one time',
  body: 'Before your account can receive dollars, they have to be switched on. It’s free, it takes a few seconds, and you won’t be asked again.',
  action: 'Switch on dollars',
  working: 'Switching on…',
  failed: "That didn't work. You can try again, or leave it for later.",
  back: 'Back to the cart',
} as const;

const RECEIVE_EN = {
  title: 'Add dollars',
  lead: 'This is your address. Send USDC here from wherever you keep it.',
  qrAlt: 'QR code with your address',
  addressLabel: 'Your address',
  facts: ['Network: Solana (devnet)', 'Asset: test USDC', 'Memo: not needed'] as readonly string[],
  warn: "If you pick a different network the money will not arrive, and it cannot be recovered.",
  dismiss: 'Done',
} as const;

/*
 * The selectors.
 *
 * Each return type is a named interface rather than `typeof PREVIEW_MASTHEAD`,
 * because the Spanish objects are `as const` and that would make the literal
 * Spanish sentence the type — an English return would not assign to it. The
 * interfaces are also what keeps a key from being added to one language and
 * forgotten in the other.
 */

export interface PreviewMastheadCopy {
  hint: string;
  action: string;
}

export interface BalanceCopy {
  unavailable: string;
}

export interface TrustlineCopy {
  title: string;
  body: string;
  action: string;
  working: string;
  failed: string;
  back: string;
}

export interface ReceiveCopy {
  title: string;
  lead: string;
  qrAlt: string;
  addressLabel: string;
  facts: readonly string[];
  warn: string;
  dismiss: string;
}

/** Both modes' wording in one language, for the places that iterate them. */
export function modes(lang: Lang): readonly ModeCopy[] {
  return lang === 'en' ? MODES_EN : MODES;
}

export function previewMasthead(lang: Lang): PreviewMastheadCopy {
  return lang === 'en' ? PREVIEW_MASTHEAD_EN : PREVIEW_MASTHEAD;
}

export function balanceCopy(lang: Lang): BalanceCopy {
  return lang === 'en' ? BALANCE_EN : BALANCE;
}

export function trustlineCopy(lang: Lang): TrustlineCopy {
  return lang === 'en' ? TRUSTLINE_EN : TRUSTLINE;
}

export function receiveCopy(lang: Lang): ReceiveCopy {
  return lang === 'en' ? RECEIVE_EN : RECEIVE;
}
