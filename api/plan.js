// api/plan.js
// Vercel serverless function. Deploy path: /api/plan
// Request:  { userId: string }
// Response: { paid: boolean, exp: number (ms timestamp, 0 if never paid), canManage: boolean }
//   paid       true while paid access is active (exp is in the future)
//   exp        when paid access runs to; also lets the client tell "never paid" (0) from "lapsed" (past timestamp)
//   canManage  true if a Stripe customer exists for this install, so the billing portal can open (monthly plan)
// Fails soft: if Redis is unreachable it reports unpaid rather than erroring, so the widget keeps working.

import { guard } from './_lib/guard.js';
import { USER_ID_RE, paidUntil, customerFor } from './_lib/entitlement.js';

export default async function handler(req, res) {
  // Called on every widget open and a few times after checkout, so the caps are higher than checkout's.
  if (!(await guard(req, res, { name: 'plan', ipDailyCap: 2000, globalDailyCap: 20000 }))) return;

  const { userId } = req.body || {};
  if (typeof userId !== 'string' || !USER_ID_RE.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId' });
  }

  try {
    const [exp, cust] = await Promise.all([paidUntil(userId), customerFor(userId)]);
    return res.status(200).json({ paid: exp > Date.now(), exp, canManage: Boolean(cust) });
  } catch (err) {
    console.error('[plan] lookup failed:', err);
    return res.status(200).json({ paid: false, exp: 0, canManage: false });
  }
}
