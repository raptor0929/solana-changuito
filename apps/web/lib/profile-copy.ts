import type { Lang } from './lang.ts';

/** The profile dialog's words. */
export interface ProfileCopy {
  title: string;
  avatarAria: string;
  tabDia: string;
  tabOrders: string;
  lead: string;
  email: string;
  password: string;
  passwordSaved: string;
  passwordHint: string;
  dni: string;
  dniHint: string;
  postcode: string;
  postcodeHint: string;
  save: string;
  saving: string;
  saved: string;
  failed: string;
  loading: string;
}

const ES: ProfileCopy = {
  title: 'Tu perfil',
  avatarAria: 'Abrir tu perfil',
  tabDia: 'Mis datos de Día',
  tabOrders: 'Mis compras',
  lead:
    'Con estos datos compramos en tu cuenta de Día cuando pagás con USDC. Se guardan cifrados y solo se usan para hacer tu pedido.',
  email: 'Email de Día',
  password: 'Contraseña de Día',
  passwordSaved: 'Guardada. Escribí una nueva para cambiarla.',
  passwordHint: 'No la mostramos nunca, ni a vos.',
  dni: 'DNI',
  dniHint: 'También se usa como documento del titular de la tarjeta.',
  postcode: 'Código postal',
  postcodeHint: 'Donde recibís el pedido. Cotizamos el envío acá.',
  save: 'Guardar',
  saving: 'Guardando…',
  saved: 'Listo, guardado.',
  failed: 'No pudimos guardar. Probá de nuevo.',
  loading: 'Cargando tu perfil…',
};

const EN: ProfileCopy = {
  title: 'Your profile',
  avatarAria: 'Open your profile',
  tabDia: 'My Día details',
  tabOrders: 'My purchases',
  lead:
    'We use these to buy in your Día account when you pay with USDC. They are stored encrypted and used only to place your order.',
  email: 'Día email',
  password: 'Día password',
  passwordSaved: 'Saved. Type a new one to change it.',
  passwordHint: 'We never show it, not even to you.',
  dni: 'DNI',
  dniHint: "Also used as the cardholder's document.",
  postcode: 'Postal code',
  postcodeHint: 'Where you get the order. Delivery is quoted here.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Done, saved.',
  failed: "We couldn't save. Try again.",
  loading: 'Loading your profile…',
};

export function profileCopy(lang: Lang): ProfileCopy {
  return lang === 'en' ? EN : ES;
}

/** Two letters for the avatar: from the email's name part, else the wallet address. */
export function initials(email: string | null | undefined, address: string | null | undefined): string {
  const name = (email ?? '').split('@')[0] ?? '';
  const parts = name.split(/[._\-+\s]+/).filter((p) => /[a-z]/i.test(p));
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  if (parts[0]) return parts[0].replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase();
  return (address ?? '?').slice(0, 2).toUpperCase();
}
