// api/checkout.js
// Vercel serverless function. Deploy path: /api/checkout
// Request:  { userId: string, plan: 'weekly' | 'semester' | 'yearly', currency?: 'usd' | 'cad' }  (all one-time passes; the group pass is a later step)
//   currency = what the wall showed (from /api/plan (wantPrices)). If it is missing the visitor's country decides (CA -> cad, else usd); see _lib/pricing.js.
// Response: { url: string }  (the extension opens it in a new tab, from a student click only)
//
// Requires env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_WEEKLY, STRIPE_PRICE_SEMESTER, STRIPE_PRICE_YEARLY, SITE_URL (no trailing slash).
// Pass lengths live in entitlement.js (PASS_DAYS). The plan name travels to the webhook in the session metadata.
// SITE_URL must serve /thanks.html and /cancelled.html (plain static pages are enough).
// The Stripe API version is not pinned here, so the account's default version applies.

import Stripe from 'stripe';
import { guard } from './_lib/guard.js';
import { USER_ID_RE } from './_lib/entitlement.js';
import { currencyFor } from './_lib/pricing.js';

let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const PLANS = {
  weekly: { mode: 'payment', priceEnv: 'STRIPE_PRICE_WEEKLY' },
  semester: { mode: 'payment', priceEnv: 'STRIPE_PRICE_SEMESTER' },
  yearly: { mode: 'payment', priceEnv: 'STRIPE_PRICE_YEARLY' },
};

export default async function handler(req, res) {
  // Guesses sized for a ~100-person beta: tune from real usage.
  if (!(await guard(req, res, { name: 'checkout', ipDailyCap: 100, globalDailyCap: 2000 }))) return;

  const { userId, plan, currency: shownCurrency } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Update StudBud to the latest version and try again.' });
  }
  const cfg = typeof plan === 'string' ? PLANS[plan] : undefined;
  if (!cfg) return res.status(400).json({ error: 'Unknown plan' });
  // The currency the wall showed (from /api/plan (wantPrices)), so the charge matches. Older clients send none: the visitor's country decides.
  const currency = currencyFor(req, shownCurrency);

  const price = process.env[cfg.priceEnv];
  if (!price || !process.env.SITE_URL) {
    console.error('[checkout] missing env var:', !price ? cfg.priceEnv : 'SITE_URL');
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const params = {
      mode: cfg.mode,
      line_items: [{ price, quantity: 1 }],
      currency, // 'usd' | 'cad': picks that amount from the Price's currency_options (the Price must have it)
      client_reference_id: userId, // the webhook maps the payment back to this install with it
      metadata: { plan }, // the webhook reads the pass length from this
      allow_promotion_codes: true, // promo and gift codes are entered on the Stripe page
      success_url: `${process.env.SITE_URL}/thanks.html`,
      cancel_url: `${process.env.SITE_URL}/cancelled.html`,
    };
    const session = await getStripe().checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout] session create failed:', err);
    return res.status(502).json({ error: 'Could not start checkout. Try again.' });
  }
}
