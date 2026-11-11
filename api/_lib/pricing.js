// api/_lib/pricing.js
// Decides which currency a student is shown and charged, and reads the plan prices from Stripe so the wall never
// shows an amount that differs from what Checkout charges.
//
// Currency: CAD for visitors in Canada, USD for everyone else. The country comes from the `x-vercel-ip-country` request
// header that Vercel adds. A student on a VPN or travelling gets the other currency; that is accepted.
//
// Prices: each plan's Stripe Price (STRIPE_PRICE_WEEKLY / _SEMESTER / _YEARLY, the same env vars checkout.js uses) must have
// an amount in both currencies. Assumption: ONE Price per plan that carries both currencies as currency_options (not a separate
// Price per currency). If you created separate Prices per currency instead, this needs a different lookup.
//
// Prices are cached in memory for 10 minutes per currency (per serverless instance), so a price change in Stripe shows up
// within about 10 minutes and the wall does not call Stripe on every view.

import Stripe from 'stripe';

export const CURRENCIES = ['usd', 'cad'];
export const PRICE_ENV = {
  weekly: 'STRIPE_PRICE_WEEKLY',
  semester: 'STRIPE_PRICE_SEMESTER',
  yearly: 'STRIPE_PRICE_YEARLY',
};

const TTL_MS = 10 * 60 * 1000;
const cache = new Map(); // currency -> { at, data }

let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

// `requested` is the currency the client was shown (sent back to checkout.js) so the charge matches the wall even if the
// student's IP changed in between. Anything that is not a supported currency is ignored.
export function currencyFor(req, requested) {
  if (typeof requested === 'string' && CURRENCIES.includes(requested.toLowerCase())) return requested.toLowerCase();
  const country = String((req.headers && req.headers['x-vercel-ip-country']) || '').toUpperCase();
  return country === 'CA' ? 'cad' : 'usd';
}

// Amount in minor units (cents) for `currency`, or null if the Price has none. The Price's own currency is its default;
// the others are in currency_options.
export function priceAmount(price, currency) {
  if (price.currency === currency && Number.isInteger(price.unit_amount)) return price.unit_amount;
  const opt = price.currency_options && price.currency_options[currency];
  return opt && Number.isInteger(opt.unit_amount) ? opt.unit_amount : null;
}

// "$5", "$12.50". No currency code: the UI adds "CAD" / "USD" beside it.
export function formatAmount(minor, currency) {
  return new Intl.NumberFormat(currency === 'cad' ? 'en-CA' : 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
  }).format(minor / 100);
}

// { weekly: { amount, currency, display }, semester: {...}, yearly: {...} }. Throws if a price is missing or has no amount in
// `currency`; the caller decides how to fail (api/plan.js fails soft).
export async function getPrices(currency) {
  const hit = cache.get(currency);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const entries = await Promise.all(
    Object.entries(PRICE_ENV).map(async ([plan, envName]) => {
      const id = process.env[envName];
      if (!id) throw new Error(`${envName} is not set`);
      const price = await getStripe().prices.retrieve(id, { expand: ['currency_options'] });
      const amount = priceAmount(price, currency);
      if (amount === null) throw new Error(`${plan} price has no ${currency} amount`);
      return [plan, { amount, currency, display: formatAmount(amount, currency) }];
    })
  );
  const data = Object.fromEntries(entries);
  cache.set(currency, { at: Date.now(), data });
  return data;
}
