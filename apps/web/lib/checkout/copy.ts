import type { Lang } from '../lang.ts';

/** `$1.584,18`: pesos the way the store writes them. */
const pesos = (n: number) =>
  `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The escrow checkout's words. Nothing here is estimated: every line reports something that happened. */
export interface EscrowCopy {
  title: string;
  steps: [string, string, string];
  loginLead: string;
  loginCta: string;
  preparing: string;
  confirmLead: string;
  itemsLabel: string;
  shippingLabel: (option: string) => string;
  totalLabel: string;
  rateLabel: (source: string) => string;
  rateValue: (rate: number) => string;
  lockLabel: string;
  escrowNote: string;
  balanceLabel: string;
  short: string;
  faucetCta: string;
  faucetWorking: string;
  lockCta: (amount: string) => string;
  locking: string;
  lockedNote: string;
  phases: Record<string, string>;
  shoppingNote: string;
  doneTitle: string;
  doneLead: string;
  openStore: string;
  doneNote: string;
  refundedTitle: string;
  refundedLead: string;
  lockTx: string;
  settleTx: string;
  refundTx: string;
  close: string;
  finish: string;
  failed: string;
}

const ES: EscrowCopy = {
  title: 'Pagar el changuito',
  steps: ['Entrar', 'Bloquear USDC', 'Comprar'],
  loginLead: 'Entrá con tu email. Te creamos una billetera de Solana (devnet) y nosotros pagamos las comisiones.',
  loginCta: 'Entrar con email',
  preparing: 'Preparando el pedido…',
  confirmLead: 'Revisá antes de pagar: estos son los precios y el envío que Día cobra hoy a tu código postal.',
  itemsLabel: 'Productos',
  shippingLabel: (option) => `Envío (${option})`,
  totalLabel: 'Total en el súper',
  rateLabel: (source) => (source === 'belo' ? 'Cambio (Belo)' : 'Cambio'),
  rateValue: (rate) => `1 USDC = ${pesos(rate)}`,
  lockLabel: 'A bloquear',
  escrowNote:
    'La plata queda en un escrow en Solana, no con nosotros. Si la compra no llega al pago, vuelve a tu billetera sola.',
  balanceLabel: 'Tu saldo',
  short: 'No te alcanza. Cargá USDC de prueba para seguir.',
  faucetCta: 'Cargar 50 USDC de prueba',
  faucetWorking: 'Cargando…',
  lockCta: (amount) => `Bloquear ${amount} USDC y comprar`,
  locking: 'Firmando en tu billetera…',
  lockedNote: 'USDC bloqueado en el escrow.',
  phases: {
    queued: 'En la fila para comprar…',
    login: 'Entrando a Día…',
    empty_cart: 'Vaciando el carrito de Día…',
    shop: 'Cargando los productos en Día…',
    checkout: 'Pasando por la caja…',
    payment: 'Llegando al pago…',
  },
  shoppingNote: 'Un navegador en la nube está armando tu pedido en Día. Tarda un par de minutos.',
  doneTitle: '¡Compra completada!',
  doneLead: 'Tu changuito llegó al pago en Día y el escrow se liberó.',
  openStore: 'Abrir en Día',
  doneNote: 'El link abre tu carrito en la tienda para terminar la entrega y el pago ahí.',
  refundedTitle: 'No pudimos completar la compra',
  refundedLead: 'El escrow devolvió tus USDC a tu billetera.',
  lockTx: 'Bloqueo',
  settleTx: 'Liberación',
  refundTx: 'Devolución',
  close: 'Cerrar',
  finish: 'Listo',
  failed: 'Algo falló. Probá de nuevo.',
};

const EN: EscrowCopy = {
  title: 'Pay for the basket',
  steps: ['Sign in', 'Lock USDC', 'Shop'],
  loginLead: "Sign in with your email. We create a Solana (devnet) wallet for you and cover the fees.",
  loginCta: 'Sign in with email',
  preparing: 'Preparing the order…',
  confirmLead: "Check before paying: these are the prices and the delivery fee Día charges your postal code today.",
  itemsLabel: 'Products',
  shippingLabel: (option) => `Delivery (${option})`,
  totalLabel: 'Store total',
  rateLabel: (source) => (source === 'belo' ? 'Rate (Belo)' : 'Rate'),
  rateValue: (rate) => `1 USDC = ${pesos(rate)}`,
  lockLabel: 'To lock',
  escrowNote:
    "The money sits in an escrow on Solana, not with us. If the purchase doesn't reach payment, it goes back to your wallet on its own.",
  balanceLabel: 'Your balance',
  short: "Not enough. Load test USDC to continue.",
  faucetCta: 'Load 50 test USDC',
  faucetWorking: 'Loading…',
  lockCta: (amount) => `Lock ${amount} USDC and shop`,
  locking: 'Signing in your wallet…',
  lockedNote: 'USDC locked in the escrow.',
  phases: {
    queued: 'Waiting in line to shop…',
    login: 'Signing in to Día…',
    empty_cart: "Emptying Día's cart…",
    shop: 'Adding the products at Día…',
    checkout: 'Going through checkout…',
    payment: 'Reaching payment…',
  },
  shoppingNote: 'A browser in the cloud is building your order at Día. It takes a couple of minutes.',
  doneTitle: 'Purchase completed!',
  doneLead: 'Your basket reached payment at Día and the escrow was released.',
  openStore: 'Open in Día',
  doneNote: 'The link opens your cart at the store to finish delivery and payment there.',
  refundedTitle: "We couldn't complete the purchase",
  refundedLead: 'The escrow returned your USDC to your wallet.',
  lockTx: 'Lock',
  settleTx: 'Release',
  refundTx: 'Refund',
  close: 'Close',
  finish: 'Done',
  failed: 'Something failed. Try again.',
};

export function escrowCopy(lang: Lang): EscrowCopy {
  return lang === 'en' ? EN : ES;
}
