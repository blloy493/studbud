// api/plan.js
// Vercel serverless function. Deploy path: /api/plan
// Request:  { userId: string, wantPrices?: true }
// Response: { paid, exp, canManage, tier, trialStarted, trialEndsAt, remaining, allowance, resetsAt, window }
//   paid          true while paid access is active (exp is in the future)
//   exp           when paid access runs to; also lets the client tell "never paid" (0) from "lapsed" (past timestamp)
//   canManage     true if a Stripe customer exists for this install, so the billing portal can open (old monthly subscribers only)
//   tier          'paid' | 'trial' | 'free'  ('unknown' if Redis is unreachable: the client must NOT show a wall for it)
//   trialStarted  false = no trial running. With the timed trial off (TRIAL_DAYS=0, the paywall test) it is always false and
//                 tier is 'free' until the student pays; with TRIAL_DAYS>0 it means the trial starts at the first completed plan
//   trialEndsAt   ms timestamp the trial ends (0 until it starts, and always 0 with the timed trial off)
//   remaining     { plan, stuck, chat } uses left in the free window (not consumed during trial or paid)
//   allowance     { plan, stuck, chat } the totals for that window, so the UI can show "2 of 3 left"
//   window        'lifetime' = the free allowance never resets (3 free plans, then the wall) | 'month' = monthly trickle
//   resetsAt      ms timestamp of the next monthly reset (00:00 UTC on the 1st); 0 when window is 'lifetime': do NOT print a date
// With wantPrices:true the response also carries { currency: 'usd' | 'cad', prices: { weekly, semester, yearly } | null }
//   each price = { amount: minor units (cents), currency, display: '$5' } (the UI adds the "CAD" / "USD" label). Send wantPrices only when
//   the wall is about to be shown. prices is null if Stripe could not be read: show the plans with "price shown at checkout" instead of
//   amounts. Send the `currency` you showed to /api/checkout so the charge matches the wall. See _lib/pricing.js.
// paid / exp / canManage keep their old meaning, so installed clients keep working.
// Fails soft: if Redis is unreachable it reports tier 'unknown' rather than erroring, so the widget keeps working.

import { guard } from './_lib/guard.js';
import { USER_ID_RE, getStatus, customerFor, limits } from './_lib/entitlement.js';
import { currencyFor, getPrices } from './_lib/pricing.js';

export default async function handler(req, res) {
  // Called on every widget open and a few times after checkout, so the caps are higher than checkout's.
  if (!(await guard(req, res, { name: 'plan', ipDailyCap: 2000, globalDailyCap: 20000 }))) return;

  const { userId, wantPrices } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const [status, cust] = await Promise.all([getStatus(userId), customerFor(userId)]);
    const out = {
      paid: status.tier === 'paid',
      exp: status.exp,
      canManage: Boolean(cust),
      tier: status.tier,
      trialStarted: Boolean(status.trialStarted),
      trialEndsAt: status.trialEndsAt || 0,
      remaining: status.remaining,
      allowance: limits().allow,
      resetsAt: status.resetsAt,
      window: status.window,
    };
    if (wantPrices === true) {
      out.currency = currencyFor(req);
      try {
        out.prices = await getPrices(out.currency);
      } catch (err) {
        console.error('[plan] prices lookup failed:', err);
        out.prices = null; // fail soft: the wall shows the plans without amounts
      }
    }
    return res.status(200).json(out);
  } catch (err) {
    console.error('[plan] lookup failed:', err);
    return res.status(200).json({ paid: false, exp: 0, canManage: false, tier: 'unknown' });
  }
}
