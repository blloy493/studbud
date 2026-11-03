// api/portal.js
// Vercel serverless function. Deploy path: /api/portal
// Request:  { userId: string }
// Response: { url: string }  (Stripe-hosted page where the student updates a card or cancels in one click)
//
// Requires env vars: STRIPE_SECRET_KEY, SITE_URL.
// Requires the Customer portal to be activated once in the Stripe dashboard (Settings, Billing, Customer portal),
// separately for sandbox and live mode. Without it, Stripe rejects the call and this returns 502.
// Only installs with a Stripe customer can open it, which in practice means monthly subscribers: a one-time
// semester pass may have no customer record in Stripe, and there is nothing to cancel on it anyway.

import Stripe from 'stripe';
import { guard } from './_lib/guard.js';
import { USER_ID_RE, customerFor } from './_lib/entitlement.js';

let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

export default async function handler(req, res) {
  if (!(await guard(req, res, { name: 'portal', ipDailyCap: 100, globalDailyCap: 2000 }))) return;

  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId' });
  }
  if (!process.env.SITE_URL) {
    console.error('[portal] SITE_URL is not set');
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const customer = await customerFor(userId);
    if (!customer) return res.status(404).json({ error: 'No subscription found for this install.' });
    const session = await getStripe().billingPortal.sessions.create({
      customer,
      return_url: `${process.env.SITE_URL}/thanks.html`, // thanks.html should read as a generic "all set, close this tab" page
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[portal] session create failed:', err);
    return res.status(502).json({ error: 'Could not open subscription settings. Try again.' });
  }
}
