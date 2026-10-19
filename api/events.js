// api/events.js
// Vercel serverless function. Deploy path: /api/events
// Records anonymous usage events to Upstash Redis so beta value can be measured.
// Stores ONLY: an anonymous install ID, event names, per-day activity flags, plan sizes and plan durations.
// It never receives assignment text, answers or any other student content.
//
// Redis layout (2-3 commands per event):
//   events:u:<anonId>  HASH  { <event name>: count, "d:YYYY-MM-DD": 1, steps_total: sum of plan sizes }
//   events:durations   LIST  seconds from plan creation to completion (latest 1000)

import { Redis } from '@upstash/redis';
import { guard } from './_lib/guard.js';

// Limit-wall funnel: use_yes | use_no (would you use it), then pay_no, or pay_<yes|maybe>_<lt3|3|5|8>
// (would you pay + the most per month). The pay answer is part of the price event name so the pair stays together.
// waitlist_join: the student submitted an email to /api/waitlist (the email itself is never sent here).
// stuck_open: the student clicked "I'm stuck on this step" (the click only; the help request itself is counted in stuck.js).
// intake_started: the student typed or pasted into the intake box (sent by newer clients). Funnel denominator for
// intake success = users with intake_started > 0; numerator = users with plan_created > 0. Count only, no text.
// abandon_<reason>: the student discarded a plan in progress and tapped a reason (abandon_skip = no reason given).
// `steps` on these events = steps already completed in that plan (0-100); summed into abandon_steps_done so
// abandon_steps_done / total abandon events = average steps done at discard. Counts only, no text.
// finish_*, upgrade_click and price_* are no longer sent by the extension; kept so older installs still record.
const PAY_EVENTS = ['pay_no'];
for (const answer of ['yes', 'maybe']) {
  for (const price of ['lt3', '3', '5', '8']) PAY_EVENTS.push(`pay_${answer}_${price}`);
}
const ABANDON_EVENTS = ['abandon_many', 'abandon_unclear', 'abandon_wrong', 'abandon_other_way', 'abandon_other', 'abandon_skip'];
const EVENTS = new Set([
  'plan_created', 'steps_added', 'step_completed', 'plan_completed', 'finish_yes', 'finish_no',
  'limit_hit', 'upgrade_click', 'price_3', 'price_5', 'price_8', 'price_none',
  'use_yes', 'use_no', 'waitlist_join', 'stuck_open', 'intake_started',
  ...PAY_EVENTS,
  ...ABANDON_EVENTS,
]);
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

// Built lazily with the store's PREFIXED env var names (Redis.fromEnv() does not work here).
let redis;
function getRedis() {
  if (!redis) {
    const url = process.env.STUDBUD_INTEREST_KV_REST_API_URL;
    const token = process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN;
    if (!url || !token) throw new Error('Upstash env vars are not set');
    redis = new Redis({ url, token });
  }
  return redis;
}

export default async function handler(req, res) {
  if (!(await guard(req, res, { name: 'events', ipDailyCap: 5000, globalDailyCap: 20000 }))) return;

  const { anonId, name, elapsedSec, steps } = req.body || {};
  if (typeof anonId !== 'string' || !ID_RE.test(anonId)) {
    return res.status(400).json({ error: 'Invalid anonId' });
  }
  if (typeof name !== 'string' || !EVENTS.has(name)) {
    return res.status(400).json({ error: 'Unknown event' });
  }

  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `events:u:${anonId}`;
    const p = getRedis().pipeline();
    p.hincrby(key, name, 1);
    p.hset(key, { [`d:${day}`]: 1 }); // idempotent per-day flag -> active days = count of d:* fields
    // Plan size (optional; sent by 0.1.1+): steps at creation, plus steps_added when a worksheet question is
    // expanded into micro-steps. Older clients omit it, which is fine.
    // steps_total / plan_created = average steps per plan.
    if ((name === 'plan_created' || name === 'steps_added') && Number.isInteger(steps) && steps >= 1 && steps <= 100) {
      p.hincrby(key, 'steps_total', steps);
    }
    if (name.startsWith('abandon_') && Number.isInteger(steps) && steps >= 0 && steps <= 100) {
      p.hincrby(key, 'abandon_steps_done', steps);
    }
    if (name === 'plan_completed' && Number.isFinite(elapsedSec) && elapsedSec >= 0) {
      p.lpush('events:durations', Math.round(elapsedSec));
      p.ltrim('events:durations', 0, 999);
    }
    await p.exec();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Events endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
