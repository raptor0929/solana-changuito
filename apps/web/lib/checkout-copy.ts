/**
 * Every word the checkout flow says out loud, in one place.
 *
 * Same reason mode-copy.ts exists: lib/agent/prompt.ts forbids the model from
 * saying wallet, escrow, blockchain or the name of a network to a shopper, and
 * an app where the model is careful and the buttons are not would be a strange
 * one. Strings scattered through JSX cannot be checked; strings in a module
 * can, and lib/test/checkout-copy.test.ts runs the same regex over all of them.
 *
 * The second reason is the harder one. This flow has three steps that are easy
 * to describe dishonestly — a deposit the app cannot refund automatically, a
 * frame the app cannot see into, and a "paid" the store only half confirms.
 * Keeping the sentences together makes it obvious when one of them starts
 * claiming more than the code behind it knows.
 */
import { type NetworkId } from './deployments.ts';
import { DEFAULT_LANG, type Lang } from './lang.ts';

export interface CheckoutCopy {
  /** The dialog's own name. */
  title: string;
  depositTitle: string;
  /** What the shopper is being asked to send, and why. */
  depositLead: string;
  amountLabel: string;
  addressLabel: string;
  memoLabel: string;
  /** Under the memo field. It is the whole reason the money finds the order. */
  memoNote: string;
  waiting: string;
  confirmed: string;
  /**
   * Preview only. There is no wallet to send from and nothing to copy — the
   * demo wallet pays, one button, and the rest of the flow is unchanged.
   * Empty on the real side, where offering to pay for somebody would be a lie.
   */
  demoPayCta: string;
  demoPayWorking: string;
  /** The default reason, when the server has none worth reading out. */
  demoPayError: string;
  /**
   * Production only, and the mirror image of the demo trio above: here the
   * shopper's own money pays, from the account they are signed in to, in one
   * press. Empty in the test mode — a visitor with no session has no balance
   * to spend, which is the whole shape of preview.
   *
   * There is no companion sentence introducing the address and the código any
   * more. It used to sit under this button, and two ways to send one importe
   * side by side left the shopper working out which of them counted. Where
   * this button exists it is the answer; the address only comes back where no
   * button does. See `showManual` in CheckoutModal.
   */
  walletPayCta: string;
  walletPayWorking: string;
  /** Above the button. Says where the money comes off, since nothing else does. */
  walletPayLead: string;
  /** The default reason, when the outcome carries none worth reading out. */
  walletPayError: string;
  /** Not enough saldo. Checked before the press, so it is a sentence and not a refusal. */
  walletPayShort: string;
  /** Said once, plainly, because it is the part that cannot be undone by a button. */
  refundNote: string;
  checkoutTitle: string;
  checkoutLead: string;
  loginLead: string;
  loginCta: string;
  identified: string;
  openTab: string;
  /** Beside "abrir en una pestaña", so it does not read as a failure. */
  openTabNote: string;
  paidCta: string;
  checking: string;
  /** The optional card we provide — per basket in preview, one per customer in
   *  production, which is why these three are set per mode rather than shared.
   *  Optional in the copy too: the frame already takes the shopper's own card,
   *  and this must never read as the only way. */
  cardTitle: string;
  cardLead: string;
  cardCta: string;
  cardMinting: string;
  /**
   * The returning customer, production only. There is one card per person, so
   * a second deposit tops up the first — and somebody who is shown "Generar
   * una tarjeta" again will reasonably conclude they are about to be given a
   * second one, which is the one thing the product promises not to do.
   *
   * Empty in the test mode, where the card really is per-basket and there is
   * nothing to come back to.
   */
  cardAgainLead: string;
  cardAgainCta: string;
  /** Under the numbers. Says where they live, which is nowhere. */
  cardNote: string;
  cardNumberLabel: string;
  cardExpiryLabel: string;
  cardCvvLabel: string;
  cardFunded: string;
  /** The default reason, when the server has none worth reading out. */
  cardError: string;
  /** Printed under every card failure, whatever the reason: the frame still
   *  takes the shopper's own card, so no failure here is a dead end. */
  cardFallback: string;
  otpTitle: string;
  /** The field's own label, under the heading that already said it once. */
  otpLabel: string;
  otpWaiting: string;
  /** The code is on screen and running out; the countdown is beside it. */
  otpLead: string;
  otpExpired: string;
  /** Shown when the store corroborates. Deliberately not "confirmamos tu pago". */
  verified: string;
  /** Shown when it does not, which is not the same as "you did not pay". */
  unverified: string;
  unreachable: string;
  /** Says what went wrong and what happens next, with no automatic remedy implied. */
  failed: string;

  /* ----------------------------------------------- the three steps, in order
   *
   * The dialog used to take the money first and show the súper second, so
   * there was nothing to number. Now the frame comes up first and the shopper
   * does three things in it, which is worth saying out loud on screen: most of
   * the confusion in testing was somebody not knowing whether it was their
   * turn to act or ours.
   */
  /** Rail label. */
  stepLogin: string;
  /** Rail label. */
  stepDelivery: string;
  /** Rail label. */
  stepPay: string;
  /**
   * After the "abrir en una pestaña" button while they are not recognised yet.
   * The tab is a different window and nothing brings them back from it, so the
   * copy has to. */
  loginReturn: string;
  /** Under the rail at step 2: pick a delivery and the importe appears. */
  deliveryLead: string;
  /** While we are watching for the slot. Says who is waiting on whom. */
  deliveryWaiting: string;
  /**
   * The escape hatch, shown only after a long wait with no slot. Some stores
   * do not show a reader with no session which delivery was chosen, and the
   * shopper should not be stuck behind a signal we cannot get. */
  deliveryDoneCta: string;
  /** Totals table. The store's own names are used when it sends them. */
  itemsLabel: string;
  shippingLabel: string;
  totalLabel: string;
  /** Above the importe: this is the exact number, envío included. */
  payLead: string;
  /** The total moved at the súper after the shopper had already paid. */
  driftTitle: string;
  driftPaid: string;
  driftNow: string;
  /** Never an accusation, and never a promise of a refund nobody automated. */
  driftLead: string;
  /**
   * Above the card at the last step. Says what to pay with it — **never that
   * it was loaded or topped up**, because on this deployment nothing was: the
   * card is loaded by hand and this flow does not touch it. */
  cardReadyLead: string;
  /** The rehearsal is not reading a real súper and should not imply it is. */
  rehearsalNote: string;
}

const COMMON = {
  title: 'Terminar la compra',
  amountLabel: 'Importe',
  addressLabel: 'Dirección',
  memoLabel: 'Código',
  memoNote: 'Va sí o sí: es lo que hace que el importe caiga en esta compra y no en otra.',
  waiting: 'Esperando que llegue…',
  confirmed: '¡Llegó! Ya podés seguir.',
  demoPayCta: '',
  demoPayWorking: '',
  demoPayError: '',
  walletPayCta: '',
  walletPayWorking: '',
  walletPayLead: '',
  walletPayError: '',
  walletPayShort: '',
  checkoutTitle: 'Pagá en el súper',
  checkoutLead: 'Esta es la página del súper, tal cual. Nosotros no vemos lo que pasa adentro.',
  loginLead: 'Para pagar necesitás entrar a tu cuenta del súper. Se abre en una pestaña aparte, en la página del súper, con la barra de direcciones a la vista.',
  loginCta: 'Entrar a mi cuenta del súper',
  identified: 'Listo, te reconoció el súper.',
  openTab: 'Abrir en una pestaña',
  openTabNote: 'Funciona igual de bien. Algunos navegadores no dejan iniciar sesión acá adentro.',
  paidCta: 'Ya lo pagué',
  checking: 'Chequeando con el súper…',
  verified: 'El súper nos confirma que el changuito se cerró.',
  unverified: 'El súper todavía nos muestra el changuito abierto. Si ya pagaste, seguí igual y revisalo en tu cuenta del súper.',
  unreachable: 'No pudimos chequearlo con el súper en este momento.',
  cardMinting: 'Generando…',
  cardAgainLead: '',
  cardAgainCta: '',
  cardNumberLabel: 'Número',
  cardExpiryLabel: 'Vence',
  cardCvvLabel: 'Código de seguridad',
  cardError: 'No pudimos generar la tarjeta.',
  cardFallback: 'Podés pagar con la tuya en el formulario del súper.',
  otpTitle: 'Código que te pide el súper',
  otpLabel: 'Código',
  otpWaiting: 'Si el súper te pide un código para confirmar, aparece acá.',
  otpLead: 'Ponelo en el formulario del súper antes de que venza.',
  otpExpired: 'Ese código venció. Pedí uno nuevo desde el formulario del súper y esperá acá.',
  stepLogin: 'Entrá a tu cuenta',
  stepDelivery: 'Elegí el envío',
  stepPay: 'Pagá el importe',
  loginReturn:
    'Cuando termines, volvé acá. Da lo mismo si seguís en la pestaña o acá adentro: el súper nos muestra el mismo changuito.',
  deliveryLead: 'Elegí cuándo y cómo te llega. Recién ahí sabemos el importe exacto, con el envío adentro.',
  deliveryWaiting: 'Esperando que elijas el envío en el súper…',
  deliveryDoneCta: 'Ya elegí el envío',
  itemsLabel: 'Productos',
  shippingLabel: 'Envío',
  totalLabel: 'Total',
  payLead: 'Este es el importe exacto del súper, con el envío adentro.',
  driftTitle: 'El total cambió en el súper',
  driftPaid: 'Pagaste',
  driftNow: 'Ahora dice',
  driftLead: 'Revisá el changuito antes de pagar en el súper. Si no te cierra, escribinos.',
  cardReadyLead: 'Usá esta tarjeta en el formulario del súper para pagar ese importe.',
  rehearsalNote: '',
} as const;

const PRUEBA: CheckoutCopy = {
  ...COMMON,
  // It used to ask them to send the importe themselves. Nobody in this mode
  // has anywhere to send it *from* — that is the whole shape of preview — so
  // the sentence now says who pays, because "es una prueba" alone leaves a
  // reader wondering what they are about to be charged.
  depositTitle: 'El importe',
  depositLead: 'Es una prueba y la ponemos nosotros: tocá el botón y seguimos.',
  demoPayCta: 'Pagar con nuestra plata',
  demoPayWorking: 'Pagando…',
  demoPayError: 'No pudimos hacer el pago de prueba. Probá de nuevo.',
  // Per basket here, and it really does close with the window: preview has no
  // session, so no owner, so `keepsOneCard` is false and the card really is
  // born for this basket. This is the only mode that may say so.
  cardTitle: 'Tarjeta de un solo uso',
  cardLead: 'Podés pagar con tu tarjeta de siempre en el formulario del súper. O, si preferís no ponerla, te damos una que sirve una sola vez y nada más que para esta compra.',
  cardCta: 'Generar una tarjeta',
  // Per basket here, and it really does close with the window.
  cardNote: 'Copiala en el formulario del súper. No la guardamos en ningún lado: cuando cerrás esta ventana, la tarjeta se cierra con ella.',
  cardFunded: 'Tiene justo el importe de esta compra y no se puede usar para otra cosa.',
  refundNote: 'Es una prueba, así que no se mueve plata real.',
  failed: 'Algo salió mal. Como es una prueba, no hay nada que devolver.',
  rehearsalNote: 'Es una prueba: no estamos mirando un súper de verdad, así que el importe sale del changuito.',
};

const REAL: CheckoutCopy = {
  ...COMMON,
  // "Mandá" was the only instruction here, and for a shopper signed in with
  // dollars already loaded it was busywork: copy an address out of one app and
  // into another to reach an account we control, when the balance on screen
  // could simply pay. So the title stops issuing an instruction and the lead
  // names both ways, in the order they are offered.
  depositTitle: 'El importe',
  depositLead: 'Se paga con los dólares que tenés en tu cuenta. Si los tenés en otro lado, también podés mandarlos a mano.',
  walletPayCta: 'Pagar con mis dólares',
  walletPayWorking: 'Pagando…',
  walletPayLead: 'Lo descontamos de tu saldo. No hay nada que copiar.',
  walletPayError: 'No pudimos hacer el pago. Probá de nuevo.',
  // Deliberately not "cargá dólares arriba": this dialog has no funding
  // control in it, and pointing at one that is not on screen is worse than
  // saying only the part that is true.
  walletPayShort: 'No te alcanza el saldo para este pago.',
  // One card per customer, kept and topped up — which is what the code has
  // done since `keepsOneCard` landed. The old shared wording called it single
  // use, and a shopper who read it and then saw the same last4 twice would be
  // right to wonder which of the two the app was lying about.
  cardTitle: 'Tu tarjeta para el súper',
  cardLead: 'Podés pagar con tu tarjeta de siempre en el formulario del súper. O, si preferís no ponerla, te damos una tuya que usás en cada compra.',
  cardCta: 'Generar mi tarjeta',
  cardAgainLead: 'Es la misma de siempre: le sumamos el importe de esta compra y seguís con ella.',
  cardAgainCta: 'Usar mi tarjeta',
  // Not "se cierra con la ventana": this one does not. The numbers still live
  // nowhere — they are asked for again each time the card is shown — and that
  // is the promise this sentence has to keep without overclaiming the rest.
  cardNote: 'Copiala en el formulario del súper. No la guardamos en ningún lado: cada vez que la necesites te la mostramos de nuevo.',
  // The balance, not the basket. A kept card can carry change from the last
  // shop, so "justo el importe de esta compra" would be wrong about the one
  // number the shopper is looking at.
  cardFunded: 'Ese es el saldo que tiene ahora, y solo sirve para el súper.',
  // No automated outbound payment exists, and none is going to be implied.
  refundNote: 'Si algo sale mal, te devolvemos el importe a mano. No es automático.',
  failed: 'No pudimos completar la compra. Escribinos y te devolvemos el importe a mano.',
};

export const CHECKOUT_MODES = [PRUEBA, REAL] as const;

/**
 * The flow's words. `lang` is optional and defaults to Spanish, so every
 * existing caller — and the copy test — keeps the answer it had.
 */
export function checkoutCopy(net: NetworkId, lang: Lang = DEFAULT_LANG): CheckoutCopy {
  if (lang === 'en') return MODES_EN[net];
  void net;
  return PRUEBA;
}

/* ------------------------------------------------------------------------- *
 * English
 *
 * `CHECKOUT_MODES` and `checkoutCopy(net)` above still answer in Spanish, and
 * `lib/test/checkout-copy.test.ts` still reads them. Every rule that file
 * encodes is a rule about what the app may claim, not about Spanish, so the
 * English below keeps all of them — and they are the interesting part of this
 * translation, not the sentences:
 *
 * - `verified` says the **cart closed**, never that the payment was confirmed.
 *   The store's public API cannot show us an order.
 * - `unverified` never reads as "you did not pay".
 * - `openTabNote` reads as an equal path, not a failure.
 * - `memoNote` says the code is not optional.
 * - `cardLead` names the shopper's own card first, in both modes, because the
 *   frame takes it for free and a deployment with no card provider still works.
 * - `cardNote` promises the numbers are not kept, and **only the practice mode**
 *   says the card dies with the window — in real mode it does not, and a shopper
 *   who believed it would not come back for a card that still has money.
 * - `cardFunded` is this basket's amount in practice and the card's *current
 *   balance* in real mode, because a kept card carries change.
 * - The one-press pay words exist only in the mode where the money is the
 *   shopper's, and the demo-pay words only where it is ours. Empty, not absent:
 *   the panels key off the emptiness.
 * - `refundNote` and `failed` say a real refund is done **by hand**. There is no
 *   outbound payment path in this deployment and no key to sign one with.
 * ------------------------------------------------------------------------- */

const COMMON_EN = {
  title: 'Finish your purchase',
  amountLabel: 'Amount',
  addressLabel: 'Address',
  memoLabel: 'Code',
  memoNote: "It is required: it's what makes the amount land on this purchase and not another one.",
  waiting: 'Waiting for it to arrive…',
  confirmed: "It's here. You can carry on.",
  demoPayCta: '',
  demoPayWorking: '',
  demoPayError: '',
  walletPayCta: '',
  walletPayWorking: '',
  walletPayLead: '',
  walletPayError: '',
  walletPayShort: '',
  checkoutTitle: 'Pay at the store',
  checkoutLead: "This is the store's own page, exactly as it is. We cannot see what happens inside it.",
  loginLead:
    "To pay you need to sign in to your store account. It opens in a separate tab, on the store's own page, with the address bar in view.",
  loginCta: 'Sign in to my store account',
  identified: "You're recognised by the store.",
  openTab: 'Open in a tab',
  openTabNote: 'Works just as well. Some browsers will not let you sign in from in here.',
  paidCta: "I've paid",
  checking: 'Checking with the store…',
  verified: 'The store confirms the cart was closed.',
  unverified:
    'The store still shows the cart as open. If you have already paid, carry on and check it in your store account.',
  unreachable: "We couldn't check with the store just now.",
  cardMinting: 'Creating…',
  cardAgainLead: '',
  cardAgainCta: '',
  cardNumberLabel: 'Number',
  cardExpiryLabel: 'Expires',
  cardCvvLabel: 'Security code',
  cardError: "We couldn't create the card.",
  cardFallback: "You can pay with your own in the store's form.",
  otpTitle: 'The code the store asks you for',
  otpLabel: 'Code',
  otpWaiting: 'If the store asks for a code to confirm, it appears here.',
  otpLead: "Put it in the store's form before it expires.",
  otpExpired: "That code expired. Ask for a new one from the store's form and wait here.",
  stepLogin: 'Sign in',
  stepDelivery: 'Choose delivery',
  stepPay: 'Pay the amount',
  loginReturn:
    'When you are done, come back here. It makes no difference whether you carry on in the tab or in here — the store shows us the same cart.',
  deliveryLead:
    'Choose when and how it arrives. Only then do we know the exact amount, delivery included.',
  deliveryWaiting: 'Waiting for you to choose delivery at the store…',
  deliveryDoneCta: "I've chosen delivery",
  itemsLabel: 'Items',
  shippingLabel: 'Delivery',
  totalLabel: 'Total',
  payLead: "This is the store's exact amount, delivery included.",
  driftTitle: 'The total changed at the store',
  driftPaid: 'You paid',
  driftNow: 'Now it says',
  driftLead: 'Check the cart before paying at the store. If it does not add up, write to us.',
  cardReadyLead: "Use this card in the store's form to pay that amount.",
  rehearsalNote: '',
} as const;

const PRACTICE_EN: CheckoutCopy = {
  ...COMMON_EN,
  depositTitle: 'The amount',
  depositLead: "This is practice and we're paying: press the button and we'll carry on.",
  demoPayCta: 'Pay with our money',
  demoPayWorking: 'Paying…',
  demoPayError: "We couldn't make the practice payment. Try again.",
  // The only mode allowed to say the card dies with the window, because here
  // it does: no session, so no owner, so `keepsOneCard` is false.
  cardTitle: 'Single-use card',
  cardLead:
    "You can pay with your usual card in the store's form. Or, if you'd rather not enter it, we'll give you one that works once and only for this purchase.",
  cardCta: 'Create a card',
  cardNote:
    "Copy it into the store's form. We don't save it anywhere: when you close this window, the card closes with it.",
  cardFunded: "It holds exactly this purchase's amount and cannot be used for anything else.",
  refundNote: "This is practice, so no real money moves.",
  failed: "Something went wrong. Since this is practice, there's nothing to refund.",
  rehearsalNote:
    "This is practice: we aren't reading a real store, so the amount comes from the cart.",
};

const LIVE_EN: CheckoutCopy = {
  ...COMMON_EN,
  depositTitle: 'The amount',
  depositLead:
    'It comes out of the dollars in your account. If you keep them somewhere else, you can also send them by hand.',
  walletPayCta: 'Pay with my dollars',
  walletPayWorking: 'Paying…',
  walletPayLead: "We take it off your balance. There's nothing to copy.",
  walletPayError: "We couldn't make the payment. Try again.",
  // Points nowhere: there is no funding control in this dialog.
  walletPayShort: "Your balance isn't enough for this payment.",
  cardTitle: 'Your card for the store',
  cardLead:
    "You can pay with your usual card in the store's form. Or, if you'd rather not enter it, we'll give you one of your own that you use on every purchase.",
  cardCta: 'Create my card',
  cardAgainLead: "It's the same one as always: we add this purchase's amount and you carry on with it.",
  cardAgainCta: 'Use my card',
  // Not "closes with the window": this one does not. The numbers still live
  // nowhere, which is the promise this sentence keeps without overclaiming.
  cardNote:
    "Copy it into the store's form. We don't save it anywhere: every time you need it we show it to you again.",
  // The balance, not the basket. A kept card can carry change.
  cardFunded: "That's the balance it has right now, and it only works at the store.",
  refundNote: "If something goes wrong we refund the amount by hand. It isn't automatic.",
  failed: "We couldn't complete the purchase. Write to us and we'll refund the amount by hand.",
};

const MODES_EN: Record<NetworkId, CheckoutCopy> = { devnet: PRACTICE_EN };
