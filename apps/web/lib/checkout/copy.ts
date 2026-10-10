import type { Lang } from '../lang.ts';

/** The escrow checkout's words. Nothing here is estimated: every line reports something that happened. */
export interface EscrowCopy {
  title: string;
  steps: [string, string, string];
  loginLead: string;
  loginCta: string;
  preparing: string;
  subtotalLabel: string;
  shippingLabel: string;
  totalLabel: string;
  rateLabel: string;
  lockLabel: string;
  rateNote: (source: string) => string;
  diaTitle: string;
  diaLead: string;
  emailLabel: string;
  passwordLabel: string;
  dniLabel: string;
  addressMore: string;
  streetLabel: string;
  numberLabel: string;
  phoneLabel: string;
  diaMissing: string;
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
  doneLead: (orderId: string | null) => string;
  openStore: string;
  doneNote: string;
  refundedTitle: string;
  refundedLead: string;
  declinedLead: string;
  lockTx: string;
  settleTx: string;
  refundTx: string;
  close: string;
  finish: string;
  failed: string;
}

const ES: EscrowCopy = {
  title: 'Confirmar la compra',
  steps: ['Entrar', 'Confirmar y bloquear', 'Comprar'],
  loginLead: 'Entrá con tu email. Te creamos una billetera de Solana (devnet) y nosotros pagamos las comisiones.',
  loginCta: 'Entrar con email',
  preparing: 'Preparando el pedido…',
  subtotalLabel: 'Productos',
  shippingLabel: 'Envío',
  totalLabel: 'Total en Día',
  rateLabel: 'Cotización',
  lockLabel: 'Se bloquean',
  rateNote: (source) => `Cotización ${source} del momento. El envío es el que cobra Día a tu código postal.`,
  diaTitle: 'Tu cuenta de Día',
  diaLead:
    'Compramos en tu cuenta, así el pedido es tuyo y llega a tu dirección guardada. Usamos estos datos solo para esta compra: no los guardamos.',
  emailLabel: 'Email',
  passwordLabel: 'Contraseña',
  dniLabel: 'DNI',
  addressMore: '¿Tu cuenta de Día no tiene una dirección guardada?',
  streetLabel: 'Calle',
  numberLabel: 'Número',
  phoneLabel: 'Teléfono',
  diaMissing: 'Completá email, contraseña y DNI de tu cuenta de Día.',
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
    checkout: 'Eligiendo envío y pasando por la caja…',
    payment: 'Pagando con tarjeta…',
    placed: 'Pedido hecho.',
  },
  shoppingNote: 'Un navegador en la nube está armando y pagando tu pedido en Día. Tarda un par de minutos.',
  doneTitle: '¡Compra completada!',
  doneLead: (id) => (id ? `Día aceptó tu pedido n.º ${id} y el escrow se liberó.` : 'Día aceptó tu pedido y el escrow se liberó.'),
  openStore: 'Abrir en Día',
  doneNote: 'Lo ves en "Mis pedidos" de tu cuenta de Día.',
  refundedTitle: 'No pudimos completar la compra',
  refundedLead: 'El escrow devolvió tus USDC a tu billetera.',
  declinedLead: 'Día rechazó el pago con tarjeta. El escrow devolvió tus USDC a tu billetera.',
  lockTx: 'Bloqueo',
  settleTx: 'Liberación',
  refundTx: 'Devolución',
  close: 'Cerrar',
  finish: 'Listo',
  failed: 'Algo falló. Probá de nuevo.',
};

const EN: EscrowCopy = {
  title: 'Confirm the purchase',
  steps: ['Sign in', 'Confirm and lock', 'Shop'],
  loginLead: "Sign in with your email. We create a Solana (devnet) wallet for you and cover the fees.",
  loginCta: 'Sign in with email',
  preparing: 'Preparing the order…',
  subtotalLabel: 'Products',
  shippingLabel: 'Delivery',
  totalLabel: 'Total at Día',
  rateLabel: 'Rate',
  lockLabel: 'To lock',
  rateNote: (source) => `Live ${source} rate. Delivery is what Día charges to your postal code.`,
  diaTitle: 'Your Día account',
  diaLead:
    "We buy in your account, so the order is yours and goes to your saved address. We use these only for this purchase and don't keep them.",
  emailLabel: 'Email',
  passwordLabel: 'Password',
  dniLabel: 'DNI',
  addressMore: 'No address saved in your Día account?',
  streetLabel: 'Street',
  numberLabel: 'Number',
  phoneLabel: 'Phone',
  diaMissing: 'Fill in your Día email, password and DNI.',
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
    checkout: 'Choosing delivery and going through checkout…',
    payment: 'Paying by card…',
    placed: 'Order placed.',
  },
  shoppingNote: 'A browser in the cloud is building and paying for your order at Día. It takes a couple of minutes.',
  doneTitle: 'Purchase completed!',
  doneLead: (id) => (id ? `Día accepted order #${id} and the escrow was released.` : 'Día accepted your order and the escrow was released.'),
  openStore: 'Open in Día',
  doneNote: 'You can see it under "My orders" in your Día account.',
  refundedTitle: "We couldn't complete the purchase",
  refundedLead: 'The escrow returned your USDC to your wallet.',
  declinedLead: 'Día declined the card payment. The escrow returned your USDC to your wallet.',
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
