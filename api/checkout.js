// api/checkout.js
// Vercel serverless function. Deploy path: /api/checkout
// Request:  { userId: string, plan: 'monthly' | 'semester' }
// Response: { url: string }  (the extension opens it in a new tab, from a student click only)
//
// Requires env vars: STRIPE_SECRET_KEY, STRIPE_PRICE_MONTHLY, STRIPE_PRICE_SEMESTER, SITE_URL (no trailing slash).
// SITE_URL must serve /thanks.html and /cancelled.html (plain static pages are enough).
// The Stripe API version is not pinned here, so the account's default version applies.

import Stripe from 'stripe';
import { guard } from './_lib/guard.js';
import { USER_ID_RE } from './_lib/entitlement.js';

let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

const PLANS = {
  monthly: { mode: 'subscription', priceEnv: 'STRIPE_PRICE_MONTHLY' },
  semester: { mode: 'payment', priceEnv: 'STRIPE_PRICE_SEMESTER' },
};

export default async function handler(req, res) {
  // Guesses sized for a ~100-person beta: tune from real usage.
  if (!(await guard(req, res, { name: 'checkout', ipDailyCap: 100, globalDailyCap: 2000 }))) return;

  const { userId, plan } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Update StudBud to the latest version and try again.' });
  }
  const cfg = typeof plan === 'string' ? PLANS[plan] : undefined;
  if (!cfg) return res.status(400).json({ error: 'Unknown plan' });

  const price = process.env[cfg.priceEnv];
  if (!price || !process.env.SITE_URL) {
    console.error('[checkout] missing env var:', !price ? cfg.priceEnv : 'SITE_URL');
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const params = {
      mode: cfg.mode,
      line_items: [{ price, quantity: 1 }],
      client_reference_id: userId, // the webhook maps the payment back to this install with it
      allow_promotion_codes: true, // beta codes are entered on the Stripe page
      success_url: `${process.env.SITE_URL}/thanks.html`,
      cancel_url: `${process.env.SITE_URL}/cancelled.html`,
    };
    if (cfg.mode === 'subscription') {
      params.subscription_data = { metadata: { userId } };
      params.payment_method_collection = 'if_required'; // a 100%-off code skips the card form (subscription mode only)
    }
    const session = await getStripe().checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[checkout] session create failed:', err);
    return res.status(502).json({ error: 'Could not start checkout. Try again.' });
  }
}
