// api/plan.js
// Vercel serverless function. Deploy path: /api/plan
// Request:  { userId: string }
// Response: { paid, exp, canManage, tier, trialStarted, trialEndsAt, remaining, allowance, resetsAt }
//   paid          true while paid access is active (exp is in the future)
//   exp           when paid access runs to; also lets the client tell "never paid" (0) from "lapsed" (past timestamp)
//   canManage     true if a Stripe customer exists for this install, so the billing portal can open (old monthly subscribers only)
//   tier          'paid' | 'trial' | 'free'  ('unknown' if Redis is unreachable: the client must NOT show a wall for it)
//   trialStarted  false = the 14-day trial is available but starts at the first completed plan
//   trialEndsAt   ms timestamp the trial ends (0 until it starts)
//   remaining     { plan, stuck, chat } uses left this month on the free tier (not consumed during trial or paid)
//   allowance     { plan, stuck, chat } the monthly totals, so the UI can show "2 of 3 left"
//   resetsAt      ms timestamp of the next monthly reset (00:00 UTC on the 1st)
// paid / exp / canManage keep their old meaning, so installed clients keep working.
// Fails soft: if Redis is unreachable it reports tier 'unknown' rather than erroring, so the widget keeps working.

import { guard } from './_lib/guard.js';
import { USER_ID_RE, getStatus, customerFor, limits } from './_lib/entitlement.js';

export default async function handler(req, res) {
  // Called on every widget open and a few times after checkout, so the caps are higher than checkout's.
  if (!(await guard(req, res, { name: 'plan', ipDailyCap: 2000, globalDailyCap: 20000 }))) return;

  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const [status, cust] = await Promise.all([getStatus(userId), customerFor(userId)]);
    return res.status(200).json({
      paid: status.tier === 'paid',
      exp: status.exp,
      canManage: Boolean(cust),
      tier: status.tier,
      trialStarted: Boolean(status.trialStarted),
      trialEndsAt: status.trialEndsAt || 0,
      remaining: status.remaining,
      allowance: limits().allow,
      resetsAt: status.resetsAt,
    });
  } catch (err) {
    console.error('[plan] lookup failed:', err);
    return res.status(200).json({ paid: false, exp: 0, canManage: false, tier: 'unknown' });
  }
}
