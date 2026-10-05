// api/stats.js
// Vercel serverless function. Deploy path: /api/stats
// Beta metrics as JSON. Protected: set STATS_KEY in the Vercel project settings, then open
//   https://<your-app>.vercel.app/api/stats?key=<STATS_KEY>
// "users" = installs that created at least one plan. Installs that never started are invisible
// here; divide by installs from the Chrome Web Store dashboard for a per-install figure.

import { Redis } from '@upstash/redis';

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

const round2 = (x) => Math.round(x * 100) / 100;

export function summarize(rows, durations) {
  const num = (h, k) => Number(h[k] || 0);
  const totals = { plan_created: 0, step_completed: 0, plan_completed: 0, finish_yes: 0, finish_no: 0 };
  const byCompleted = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  let usersWithCompletion = 0;
  let activeDays = 0;
  const funnel = { usersHitLimit: 0, usersClickedUpgrade: 0, priceChoices: { '3': 0, '5': 0, '8': 0, none: 0 } };

  rows.forEach((h) => {
    Object.keys(totals).forEach((k) => { totals[k] += num(h, k); });
    const c = num(h, 'plan_completed');
    if (c > 0) usersWithCompletion += 1;
    byCompleted[c >= 3 ? '3+' : String(c)] += 1;
    activeDays += Object.keys(h).filter((k) => k.startsWith('d:')).length;
    if (num(h, 'limit_hit') > 0) funnel.usersHitLimit += 1;
    if (num(h, 'upgrade_click') > 0) funnel.usersClickedUpgrade += 1;
    Object.keys(funnel.priceChoices).forEach((p) => { if (num(h, `price_${p}`) > 0) funnel.priceChoices[p] += 1; });
  });

  const users = rows.length;
  const secs = durations.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const mid = secs.length / 2;
  const median = secs.length === 0 ? null : secs.length % 2 ? secs[(secs.length - 1) / 2] : (secs[mid - 1] + secs[mid]) / 2;
  const answered = totals.finish_yes + totals.finish_no;

  return {
    users,
    usersWithCompletion,
    totals,
    planCompletionRate: totals.plan_created ? round2(totals.plan_completed / totals.plan_created) : null,
    avgPlansCompletedPerUser: users ? round2(totals.plan_completed / users) : null,
    avgStepsCompletedPerUser: users ? round2(totals.step_completed / users) : null,
    avgActiveDaysPerUser: users ? round2(activeDays / users) : null,
    usersByCompletedPlans: byCompleted,
    selfReportedFinished: { yes: totals.finish_yes, no: totals.finish_no, yesRate: answered ? round2(totals.finish_yes / answered) : null },
    // Upgrade wall: of the users who hit the cap, how many clicked Upgrade, and what price they picked (users, not clicks).
    upgradeFunnel: {
      ...funnel,
      clickRate: funnel.usersHitLimit ? round2(funnel.usersClickedUpgrade / funnel.usersHitLimit) : null,
    },
    // Guards against "clicked Next through everything": completions faster than 2 minutes are suspect.
    completionTime: {
      samples: secs.length,
      medianMinutes: median === null ? null : round2(median / 60),
      shareUnder2Min: secs.length ? round2(secs.filter((s) => s < 120).length / secs.length) : null,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const expected = process.env.STATS_KEY;
  if (!expected) return res.status(503).json({ error: 'STATS_KEY is not configured' });
  const provided = (req.query && req.query.key) || req.headers['x-stats-key'];
  if (provided !== expected) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const r = getRedis();
    const keys = [];
    let cursor = '0';
    do {
      const [next, batch] = await r.scan(cursor, { match: 'events:u:*', count: 500 });
      cursor = String(next);
      keys.push(...batch);
    } while (cursor !== '0');

    let rows = [];
    if (keys.length > 0) {
      const p = r.pipeline();
      keys.forEach((k) => p.hgetall(k));
      rows = (await p.exec()).filter(Boolean);
    }
    const durations = await r.lrange('events:durations', 0, -1);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(summarize(rows, durations || []));
  } catch (err) {
    console.error('Stats endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
