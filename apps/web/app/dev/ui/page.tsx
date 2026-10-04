import { notFound } from 'next/navigation';

import { CartCard } from '../../../components/CartCard';
import { ProductGrid } from '../../../components/ProductGrid';
import { Fixtures } from './Fixtures';

/**
 * Every rendered block, with fixed data, on one page.
 *
 * The agent needs an API key and a live supermarket to produce a product
 * grid, which makes "does the card still look right" an expensive question.
 * This answers it in a page load, and covers the states that are awkward to
 * provoke on purpose: no image, on sale, out of stock, a cart the store has
 * complained about.
 */
export default function DevUi() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>fixtures</h1>
          <p className="tagline">Los bloques que dibuja el chat, con datos fijos.</p>
        </div>
      </header>
      <div className="thread">
        <Fixtures />

        <ProductGrid items={PRODUCTS} note="4 opciones de leche descremada en 1414" />
        <CartCard cart={CART} handoffUrl="https://diaonline.supermercadosdia.com.ar/checkout/" />
      </div>
    </main>
  );
}

const money = (centavos: number) => ({
  centavos,
  display: new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(centavos / 100),
});

const PRODUCTS = [
  {
    skuId: '1',
    productId: 'p1',
    name: 'Leche Descremada La Serenísima Larga Vida 1 L',
    brand: 'La Serenísima',
    sellerId: '1',
    price: money(189_900),
    listPrice: money(219_900),
    available: true,
    imageUrl: 'https://diaargentinaprod.vtexassets.com/unsafe/fit-in/300x300/center/middle/x.jpg',
    unitMultiplier: 1,
    measurementUnit: 'L',
  },
  {
    skuId: '2',
    productId: 'p2',
    name: 'Leche Descremada Ilolay Sachet 1 L',
    brand: 'Ilolay',
    sellerId: '1',
    price: money(154_500),
    available: true,
  },
  {
    skuId: '3',
    productId: 'p3',
    name: 'Leche Descremada DIA 1 L',
    brand: 'DIA',
    sellerId: '1',
    price: money(139_000),
    available: false,
  },
  {
    skuId: '4',
    productId: 'p4',
    name: 'Leche Descremada Sancor Larga Vida Botella 1 L',
    brand: 'Sancor',
    sellerId: '2',
    price: money(205_000),
    available: true,
    unitMultiplier: 1,
    measurementUnit: 'L',
  },
];

const CART = {
  retailer: 'dia',
  cartId: 'demo-cart',
  lines: [
    { index: 0, skuId: '2', name: 'Leche Descremada Ilolay Sachet 1 L', quantity: 2, sellerId: '1', unitPrice: money(154_500), lineTotal: money(309_000), available: true },
    { index: 1, skuId: '9', name: 'Pan Lactal Bimbo Artesano 500 g', quantity: 1, sellerId: '1', unitPrice: money(289_900), lineTotal: money(289_900), available: true },
    { index: 2, skuId: '3', name: 'Leche Descremada DIA 1 L', quantity: 1, sellerId: '1', unitPrice: money(139_000), lineTotal: money(0), available: false },
  ],
  total: money(598_900),
  messages: ['El precio de "Pan Lactal Bimbo Artesano 500 g" cambió desde la búsqueda.'],
};

