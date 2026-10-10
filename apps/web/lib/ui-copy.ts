/**
 * The words that were sitting in JSX.
 *
 * Every other copy module in here exists because a test sweeps it for the
 * vocabulary the agent is forbidden from using in front of a shopper. This one
 * exists for a duller reason: a string inside a component cannot follow the
 * language, and about fifty of them were. `checkout-copy.ts`, `mode-copy.ts`,
 * `orders-copy.ts` and `faucet-copy.ts` already own the words of the payment
 * flow and are not moved in here — this is the chrome around them, the labels,
 * the empty states and the buttons that had never needed a home.
 *
 * Grouped by the component that says them rather than by kind, because that is
 * how they get read: somebody editing `CartRail` wants the four words that rail
 * says, not every "Total" in the app. Two components saying the same word twice
 * is cheaper than a shared `common.total` that quietly changes in three places.
 *
 * Same rule as the rest: the Spanish is the original and the English is beside
 * it, keyed identically, selected by `uiCopy(lang)`. The interfaces are what
 * stop a key being added to one language and forgotten in the other — without
 * them a missing key is a silent `undefined` on screen.
 */
import { DEFAULT_LANG, type Lang } from './lang.ts';

export interface CartCopy {
  /** The panel's accessible name. "Carrito" is the plain word; the title is the joke. */
  aria: string;
  title: string;
  total: string;
  payCta: string;
  /** `openAt('Dia')` -> "Abrir en Dia". */
  openAt: (store: string) => string;
  /** One is a sentence, several is a count. Both say the same thing. */
  oosOne: string;
  oosMany: (n: number) => string;
}

export interface RailCopy {
  cartAria: string;
  cartTitle: string;
  paidAria: string;
  paidTitle: string;
  paid: string;
  total: string;
  empty: string;
  oosOne: string;
  oosMany: (n: number) => string;
  /** Under a finished order: what was paid and which order it was. */
  ref: (amount: string, orderId: string) => string;
}

export interface HistoryCopy {
  aria: string;
  title: string;
  close: string;
  newChat: string;
  empty: string;
  toggleAria: string;
  /** The chip on a row. `none` has no chip at all, so it is not here. */
  open: string;
  paid: string;
}

export interface GridCopy {
  aria: string;
  outOfStock: string;
}

export interface CopyFieldCopy {
  copy: string;
  copied: string;
  /** Spoken, not shown: "Copiar número". The label arrives lowercased. */
  copyAria: (label: string) => string;
}

export interface WalletCopy {
  label: string;
  unconfigured: string;
  refreshing: string;
  verifying: string;
  fundCta: string;
  funding: string;
  funded: string;
  /** The amount is already formatted for the reader. */
  fundedAmount: (amount: string) => string;
  fundProofFailed: string;
  /** The `title` on the address button, which is also how it says what it does. */
  addressTitle: (address: string) => string;
  cardAria: string;
  purchasesAria: string;
  signOutAria: string;
}

export interface PaymentCopy {
  aria: string;
  title: string;
  close: string;
  storeTotal: string;
  rate: string;
  balance: string;
  /** Points at the top-up button, and only where that button exists. */
  shortFundable: string;
  short: string;
  note: string;
  networkRefused: string;
  signing: string;
  verifying: string;
  startCta: string;
  cancel: string;
  /** The address is already shortened by the caller. */
  from: (address: string) => string;
}

export interface OrderCopy {
  /** The panel's own heading while the money is held. The unit comes from the mode. */
  held: (amount: string, unit: string) => string;
  viewTx: string;
  settled: string;
  refunded: string;
  /** After it closed, one way or the other. */
  settledNote: (amount: string, unit: string) => string;
  refundedNote: (amount: string, unit: string) => string;
  close: string;
  hold: string;
  confirmation: string;
  refund: string;
  receipt: string;
  /** The amount is the store's own string, unchanged. */
  lead: (amount: string) => string;
  openCart: string;
  doneCta: string;
  confirming: string;
  refunding: string;
  refundFailed: string;
  proofFailed: string;
}

export interface ChatCopy {
  hi: string;
  greeting: string;
  starterLead: string;
  searching: string;
  signInLead: string;
  loginUnconfigured: string;
  receiptAria: string;
  receiptTitle: string;
  /** Link out of the receipt to the store's own order list. */
  orderAtStore: string;
  total: string;
  stopAria: string;
  undelivered: string;
  dropped: string;
  undeliveredLogin: string;
  retry: string;
  retryAria: string;
  closed: string;
  newChat: string;
  stop: string;
  send: string;
  /** Mic control. The stop label replaces it while dictation is open. */
  voice: string;
  voiceStop: string;
  /** Shown while the recognizer is open, under the composer. */
  listening: string;
  attach: string;
  camera: string;
  /** Shown when the browser refuses the camera, and when the stream fails. */
  cameraDenied: string;
  cameraFailed: string;
  /** The two controls on the desktop capture sheet. */
  shutter: string;
  cancelCam: string;
  removePhoto: string;
  /** Alt for the photo on the user's bubble. */
  photoAlt: string;
  /** Alt for the thumbnail still sitting in the composer. */
  previewAlt: string;
  /** Sent when they attach a photo and do not type. The model needs a sentence. */
  photoOnly: string;
  voiceUnsupported: string;
  voiceDenied: string;
  voiceMissed: string;
  voiceFailed: string;
  photoUnread: string;
  photoHuge: string;
  /** Under the receipt: what was paid, and which order it was. */
  paidRef: (amount: string, orderId: string) => string;
  /** Rotating composer prompts. Each long one has a short twin for phones. */
  placeholders: readonly { readonly long: string; readonly short: string }[];
}

export interface GateCopy {
  checkingTitle: string;
  checkingBody: string;
  widgetTitle: string;
  widgetBody: string;
  blockedTitle: string;
  blockedBody: string;
  retry: string;
  startFailed: string;
  widgetFailed: string;
  widgetExpired: string;
  cookieMissing: string;
  verifyFailed: string;
  stillNeeded: string;
}

export interface CheckoutUiCopy {
  close: string;
  continueCta: string;
  cancel: string;
  loggedIn: string;
  anyway: string;
  preparing: string;
  signInToPay: string;
  sessionFailed: string;
  prepareFailed: string;
  prepareOffline: string;
}

export interface CardFaceCopy {
  number: string;
  expiry: string;
  cvv: string;
}

export interface UiCopy {
  cart: CartCopy;
  rail: RailCopy;
  history: HistoryCopy;
  grid: GridCopy;
  field: CopyFieldCopy;
  wallet: WalletCopy;
  payment: PaymentCopy;
  order: OrderCopy;
  chat: ChatCopy;
  gate: GateCopy;
  checkout: CheckoutUiCopy;
  card: CardFaceCopy;
  /** Every dialog's ✕. One key, because it is one word. */
  close: string;
  purchasesUnconfigured: string;
  reportBug: string;
}

const ES: UiCopy = {
  cart: {
    aria: 'Carrito',
    title: 'Tu changuito',
    total: 'Total',
    payCta: 'Proceder al pago',
    openAt: (store) => `Abrir en ${store}`,
    oosOne: '1 producto quedó sin stock.',
    oosMany: (n) => `${n} productos quedaron sin stock.`,
  },
  rail: {
    cartAria: 'Tu changuito',
    cartTitle: 'Tu changuito',
    paidAria: 'Tu compra',
    paidTitle: 'Tu compra',
    paid: 'Pagado',
    total: 'Total',
    empty: 'Todavía no hay nada acá. Contale a Changuito qué necesitás y lo va llenando.',
    oosOne: '1 producto sin stock.',
    oosMany: (n) => `${n} productos sin stock.`,
    ref: (amount, orderId) => `Pagaste ${amount} · pedido ${orderId}`,
  },
  history: {
    aria: 'Tus compras',
    title: 'Tus compras',
    close: 'Cerrar',
    newChat: 'Nueva compra',
    empty: 'Acá van a quedar tus compras para que las revises cuando quieras.',
    toggleAria: 'Tus conversaciones',
    open: 'En curso',
    paid: 'Pagado',
  },
  grid: {
    aria: 'Productos encontrados',
    outOfStock: 'Sin stock',
  },
  field: {
    copy: 'Copiar',
    copied: 'Copiado',
    copyAria: (label) => `Copiar ${label}`,
  },
  wallet: {
    label: 'Tu pago',
    unconfigured: 'pago no configurado',
    refreshing: 'actualizando…',
    verifying: 'verificando sesión…',
    fundCta: 'Cargar USDC',
    funding: 'Cargando…',
    funded: 'Listo: saldo de prueba cargado.',
    fundedAmount: (amount) => `+${amount} USDC de prueba.`,
    fundProofFailed: 'No pudimos confirmar tu sesión para cargar USDC. Probá de nuevo.',
    addressTitle: (address) => `${address}. Clic para ver el QR y copiarla`,
    cardAria: 'Mi tarjeta',
    purchasesAria: 'Mis compras',
    signOutAria: 'Salir',
  },
  payment: {
    aria: 'Confirmar el pago',
    title: 'Confirmar y pagar',
    close: 'Cerrar',
    storeTotal: 'Total en el super',
    rate: 'Tipo de cambio',
    balance: 'Tu saldo',
    shortFundable: 'No te alcanza el saldo. Cargá USDC arriba y volvé a intentar.',
    short: 'No te alcanza el saldo para este pago.',
    note: 'El monto queda reservado hasta que completes la compra en el súper. Si no se concreta, vuelve a tu saldo. Pagá con tarjeta o USDC.',
    networkRefused: 'la red rechazó la transacción',
    signing: 'Confirmando…',
    verifying: 'Verificando sesión…',
    startCta: 'Empezá a comprar',
    cancel: 'Cancelar',
    from: (address) => `Desde ${address}`,
  },
  order: {
    held: (amount, unit) => `Pago reservado · ${amount} ${unit}`,
    viewTx: 'ver transacción ↗',
    settled: '✓ Tu changuito está pago',
    refunded: 'Orden reembolsada',
    settledNote: (amount, unit) =>
      `${amount} ${unit} quedaron confirmados. Retirá el pedido en el súper.`,
    refundedNote: (amount, unit) => `${amount} ${unit} volvieron a tu saldo. No se cobró nada.`,
    close: 'Cerrar',
    hold: 'Reserva',
    confirmation: 'Confirmación',
    refund: 'Reembolso',
    receipt: 'Comprobante del pago',
    lead: (amount) =>
      `Tu pago quedó reservado. Completá el carrito de ${amount} en el súper y volvé acá para confirmarlo, o pedí el reembolso si no se pudo.`,
    openCart: 'Abrir el carrito',
    doneCta: 'Ya lo completé',
    confirming: 'Confirmando…',
    refunding: 'Reembolsando…',
    refundFailed: 'No se pudo',
    proofFailed: 'Necesitamos que confirmes con la billetera que pagó la orden. Probá de nuevo.',
  },
  chat: {
    hi: 'Hola 👋',
    greeting: 'Changuito te ayuda a armar tus compras en el supermercado.',
    starterLead: 'Probá con:',
    searching: 'Buscando en el súper…',
    signInLead: 'Para seguir, iniciá sesión',
    loginUnconfigured: 'El inicio de sesión no está configurado en este build.',
    receiptAria: 'Tu compra',
    receiptTitle: 'Compra pagada',
    // "Seguí" rather than "ver": the store's page is where the delivery gets
    // tracked, and that is the reason to open it.
    orderAtStore: 'Seguí el pedido en el súper',
    total: 'Total',
    stopAria: 'Parar respuesta',
    undelivered: 'No se envió',
    dropped: 'Se cortó antes de responder',
    undeliveredLogin: 'No se envió. Iniciá sesión y lo reenviamos',
    retry: 'Reintentar',
    retryAria: 'Reintentar enviar este mensaje',
    closed: 'Esta compra ya está cerrada. Empezá un chat nuevo para pedir otra cosa.',
    newChat: 'Nueva compra',
    stop: 'Parar',
    send: 'Enviar',
    voice: 'Buscar por voz',
    voiceStop: 'Parar el dictado',
    listening: 'Escuchando… hablá y lo busco.',
    attach: 'Adjuntar una imagen',
    camera: 'Sacar una foto',
    cameraDenied: 'Necesitamos permiso para usar la cámara.',
    cameraFailed: 'No pudimos abrir la cámara.',
    shutter: 'Usar esta foto',
    cancelCam: 'Cancelar',
    removePhoto: 'Quitar la imagen',
    photoAlt: 'Imagen que enviaste',
    previewAlt: 'Foto para buscar',
    photoOnly: 'Buscá esto en el súper.',
    voiceUnsupported: 'Este navegador no dicta. Probá con Chrome.',
    voiceDenied: 'Necesitamos permiso para usar el micrófono.',
    voiceMissed: 'No escuché nada. Probá de nuevo.',
    voiceFailed: 'No pude usar el micrófono. Probá de nuevo.',
    photoUnread: 'No pude leer esa imagen. Probá con otra foto.',
    photoHuge: 'La foto es muy pesada. Probá con otra.',
    paidRef: (amount, orderId) => `Pagaste ${amount} · pedido ${orderId}`,
    placeholders: [
      {
        long: '¿Qué necesitás del súper? Contanos para cuántos cocinás y te armamos la lista de lo que necesitás.',
        short: '¿Qué necesitás del súper y para cuántos?',
      },
      {
        long: '¿Asado, milanesas o algo light? Decime para cuántos y Changuito arma la lista.',
        short: '¿Asado, milanesas o algo light?',
      },
      {
        long: 'Contame la receta y para cuántos cocinás. Yo me encargo del súper.',
        short: 'Decime qué cocinás y para cuántos.',
      },
      {
        long: '¿Semana laboral o juntada? Decime cuántos son y qué comen, y armamos el carrito.',
        short: '¿Semana laboral o juntada?',
      },
    ],
  },
  gate: {
    checkingTitle: 'Un segundo…',
    checkingBody: 'Confirmamos que sos una persona antes de armar el súper.',
    widgetTitle: 'Confirmá que sos una persona',
    widgetBody: 'Es un paso corto. Después podés armar el súper.',
    blockedTitle: 'Hace falta una verificación',
    blockedBody: 'Ahora no podemos confirmar que sos una persona. Reintentá en un rato.',
    retry: 'Reintentar',
    startFailed: 'No pudimos iniciar la verificación. Reintentá.',
    widgetFailed: 'La verificación falló. Probá de nuevo.',
    widgetExpired: 'La verificación venció. Probá de nuevo.',
    cookieMissing: 'La verificación no quedó guardada en este navegador. Probá de nuevo.',
    verifyFailed: 'No pudimos verificar que sos una persona.',
    stillNeeded: 'Confirmá que sos una persona para seguir.',
  },
  checkout: {
    close: 'Cerrar',
    continueCta: 'Seguir',
    cancel: 'Cancelar',
    loggedIn: 'Ya ingresé',
    anyway: 'Seguir igual',
    preparing: 'Preparando…',
    signInToPay: 'Iniciá sesión con tu cuenta para pagar.',
    sessionFailed: 'No pudimos confirmar tu sesión. Probá de nuevo.',
    prepareFailed: 'No pudimos preparar el pago.',
    prepareOffline: 'No pudimos preparar el pago. Revisá la conexión y volvé a intentar.',
  },
  card: {
    number: 'Número',
    expiry: 'Vence',
    cvv: 'CVV',
  },
  close: 'Cerrar',
  purchasesUnconfigured: 'Falta configurar el inicio de sesión en esta instalación.',
  reportBug: 'Reportar un bug',
};

const EN: UiCopy = {
  cart: {
    aria: 'Cart',
    // The brand name is the word for the trolley, so it stays. Translating it
    // would rename the product on one of the two screens it appears on.
    title: 'Your changuito',
    total: 'Total',
    payCta: 'Proceed to checkout',
    openAt: (store) => `Open in ${store}`,
    oosOne: '1 item went out of stock.',
    oosMany: (n) => `${n} items went out of stock.`,
  },
  rail: {
    cartAria: 'Your changuito',
    cartTitle: 'Your changuito',
    paidAria: 'Your purchase',
    paidTitle: 'Your purchase',
    paid: 'Paid',
    total: 'Total',
    empty: "There's nothing here yet. Tell Changuito what you need and it fills up.",
    oosOne: '1 item out of stock.',
    oosMany: (n) => `${n} items out of stock.`,
    ref: (amount, orderId) => `You paid ${amount} · order ${orderId}`,
  },
  history: {
    aria: 'Your purchases',
    title: 'Your purchases',
    close: 'Close',
    newChat: 'New purchase',
    empty: 'Your purchases will be kept here for whenever you want to look back.',
    // Conversations, not purchases: the other control a few pixels away is the
    // purchases one, and two names for two things.
    toggleAria: 'Your conversations',
    open: 'In progress',
    paid: 'Paid',
  },
  grid: {
    aria: 'Products found',
    outOfStock: 'Out of stock',
  },
  field: {
    copy: 'Copy',
    copied: 'Copied',
    copyAria: (label) => `Copy ${label}`,
  },
  wallet: {
    label: 'Your payment',
    unconfigured: 'payment not configured',
    refreshing: 'updating…',
    verifying: 'checking your session…',
    fundCta: 'Add USDC',
    funding: 'Adding…',
    funded: 'Done: practice balance added.',
    fundedAmount: (amount) => `+${amount} practice USDC.`,
    fundProofFailed: "We couldn't confirm your session to add USDC. Try again.",
    addressTitle: (address) => `${address}. Click to see the QR and copy it`,
    cardAria: 'My card',
    purchasesAria: 'My purchases',
    signOutAria: 'Sign out',
  },
  payment: {
    aria: 'Confirm the payment',
    title: 'Confirm and pay',
    close: 'Close',
    storeTotal: 'Store total',
    rate: 'Exchange rate',
    balance: 'Your balance',
    shortFundable: "Your balance isn't enough. Add USDC above and try again.",
    short: "Your balance isn't enough for this payment.",
    note: "The amount is held until you complete the purchase at the store. If it doesn't go through, it comes back to your balance. Pay by card or with USDC.",
    networkRefused: 'the transaction was refused',
    signing: 'Confirming…',
    verifying: 'Checking your session…',
    startCta: 'Start shopping',
    cancel: 'Cancel',
    from: (address) => `From ${address}`,
  },
  order: {
    held: (amount, unit) => `Payment held · ${amount} ${unit}`,
    viewTx: 'see the transaction ↗',
    settled: '✓ Your changuito is paid',
    refunded: 'Order refunded',
    settledNote: (amount, unit) => `${amount} ${unit} confirmed. Collect your order at the store.`,
    refundedNote: (amount, unit) =>
      `${amount} ${unit} came back to your balance. Nothing was charged.`,
    close: 'Close',
    hold: 'Hold',
    confirmation: 'Confirmation',
    refund: 'Refund',
    receipt: 'Payment receipt',
    lead: (amount) =>
      `Your payment is on hold. Complete the ${amount} cart at the store and come back here to confirm it, or ask for a refund if it didn't work out.`,
    openCart: 'Open the cart',
    doneCta: "I've completed it",
    confirming: 'Confirming…',
    refunding: 'Refunding…',
    refundFailed: "It didn't work",
    proofFailed: 'We need you to confirm, from the account that paid the order, that it was you. Try again.',
  },
  chat: {
    hi: 'Hi 👋',
    greeting: 'Changuito helps you put your supermarket shop together.',
    starterLead: 'Try:',
    searching: 'Looking through the store…',
    signInLead: 'To carry on, sign in',
    loginUnconfigured: 'Signing in is not configured in this build.',
    receiptAria: 'Your purchase',
    receiptTitle: 'Purchase paid',
    orderAtStore: 'Track the order at the store',
    total: 'Total',
    stopAria: 'Stop the reply',
    undelivered: "It didn't send",
    dropped: 'It cut out before replying',
    undeliveredLogin: "It didn't send. Sign in and we'll send it again",
    retry: 'Try again',
    retryAria: 'Try sending this message again',
    closed: 'This purchase is closed. Start a new chat to ask for something else.',
    newChat: 'New purchase',
    stop: 'Stop',
    send: 'Send',
    voice: 'Search by voice',
    voiceStop: 'Stop dictation',
    listening: "Listening… speak and I'll search.",
    attach: 'Attach an image',
    camera: 'Take a photo',
    cameraDenied: 'We need permission to use the camera.',
    cameraFailed: 'We could not open the camera.',
    shutter: 'Use this photo',
    cancelCam: 'Cancel',
    removePhoto: 'Remove the image',
    photoAlt: 'Image you sent',
    previewAlt: 'Photo to search',
    photoOnly: 'Find this at the store.',
    voiceUnsupported: "This browser can't dictate. Try Chrome.",
    voiceDenied: 'We need permission to use the microphone.',
    voiceMissed: "I didn't hear anything. Try again.",
    voiceFailed: "I couldn't use the microphone. Try again.",
    photoUnread: "I couldn't read that image. Try another photo.",
    photoHuge: 'That photo is too large. Try another one.',
    paidRef: (amount, orderId) => `You paid ${amount} · order ${orderId}`,
    // The stores are Argentine and so is the money, so the shop the shopper
    // is describing is the same one either way. Only the asking changes.
    placeholders: [
      {
        long: 'What do you need from the store? Tell us how many you cook for and we put the list together.',
        short: 'What do you need, and for how many?',
      },
      {
        long: 'A roast, milanesas or something light? Say how many and Changuito makes the list.',
        short: 'A roast, milanesas or something light?',
      },
      {
        long: 'Tell me the recipe and how many you cook for. I take care of the store.',
        short: 'Tell me what you are cooking, and for how many.',
      },
      {
        long: 'A work week or a get-together? Say how many and what they eat, and we fill the trolley.',
        short: 'A work week or a get-together?',
      },
    ],
  },
  gate: {
    checkingTitle: 'One second…',
    checkingBody: "We're confirming you're a person before we start shopping.",
    widgetTitle: "Confirm you're a person",
    widgetBody: "It's a short step. Then you can start shopping.",
    blockedTitle: 'A check is needed',
    blockedBody: "We can't confirm you're a person right now. Try again in a bit.",
    retry: 'Try again',
    startFailed: "We couldn't start the check. Try again.",
    widgetFailed: 'The check failed. Try again.',
    widgetExpired: 'The check expired. Try again.',
    cookieMissing: "The check wasn't saved in this browser. Try again.",
    verifyFailed: "We couldn't verify that you're a person.",
    stillNeeded: "Confirm you're a person to carry on.",
  },
  checkout: {
    close: 'Close',
    continueCta: 'Carry on',
    cancel: 'Cancel',
    loggedIn: "I'm signed in",
    anyway: 'Carry on anyway',
    preparing: 'Getting ready…',
    signInToPay: 'Sign in with your account to pay.',
    sessionFailed: "We couldn't confirm your session. Try again.",
    prepareFailed: "We couldn't set up the payment.",
    prepareOffline: "We couldn't set up the payment. Check your connection and try again.",
  },
  card: {
    number: 'Number',
    expiry: 'Expires',
    cvv: 'CVV',
  },
  close: 'Close',
  purchasesUnconfigured: 'Signing in has not been configured in this installation.',
  reportBug: 'Report a bug',
};

export function uiCopy(lang: Lang = DEFAULT_LANG): UiCopy {
  return lang === 'en' ? EN : ES;
}
