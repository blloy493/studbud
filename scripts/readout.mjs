// readout.mjs - studbud beta read-out. Read-only: never writes to Redis.
// Usage:
//   npm i @upstash/redis
//   STUDBUD_INTEREST_KV_REST_API_URL=... STUDBUD_INTEREST_KV_REST_API_TOKEN=... node readout.mjs
//
// Reads events:u:<anonId> hashes (SCAN) and the events:durations list written by api/events.js.
// Users without `steps_total` (pre-0.1.1 installs) are excluded from the plan-size metrics, not counted as 0.

const DAY_MS = 86400000;
const PAY_PRICES = ['lt3', '3', '5', '8'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dayNum = (iso) => Math.floor(Date.parse(iso) / DAY_MS);

export function summarize(users, durations, todayIso = new Date().toISOString().slice(0, 10)) {
  const today = dayNum(todayIso);
  const out = {};

  const withDays = users.map((u) => {
    const days = Object.keys(u).filter((k) => k.startsWith('d:')).map((k) => dayNum(k.slice(2))).sort((a, b) => a - b);
    return { u, days, first: days[0] };
  });

  // Reach
  out.installs = users.length;
  const planners = users.filter((u) => num(u.plan_created) > 0);
  out.usersWithPlan = planners.length;

  // Completion
  const created = sum(users.map((u) => num(u.plan_created)));
  const completed = sum(users.map((u) => num(u.plan_completed)));
  out.plansCreated = created;
  out.plansCompleted = completed;
  out.planCompletionRate = pct(completed, created);
  out.usersWithCompletion = users.filter((u) => num(u.plan_completed) > 0).length;

  // Plan size and step depth (only users who reported steps_total)
  const sized = users.filter((u) => num(u.steps_total) > 0);
  out.usersWithStepData = sized.length;
  const sizedPlans = sum(sized.map((u) => num(u.plan_created)));
  const sizedSteps = sum(sized.map((u) => num(u.steps_total)));
  out.avgStepsPerPlan = sizedPlans ? (sizedSteps / sizedPlans).toFixed(1) : 'n/a';
  out.stepDepth = pct(sum(sized.map((u) => num(u.step_completed))), sizedSteps);

  // Time to complete (seconds -> minutes)
  const med = median(durations.map(num));
  out.durationSamples = durations.length;
  out.medianMinutesToComplete = med === null ? 'n/a' : (med / 60).toFixed(1);

  // Retention: only cohorts old enough to have had the chance to return
  const d1Elig = withDays.filter((x) => x.first !== undefined && today - x.first >= 1);
  const d7Elig = withDays.filter((x) => x.first !== undefined && today - x.first >= 7);
  out.d1 = `${d1Elig.filter((x) => x.days.includes(x.first + 1)).length}/${d1Elig.length}`;
  out.d7 = `${d7Elig.filter((x) => x.days.some((d) => d >= x.first + 7)).length}/${d7Elig.length} (any activity on/after day 7)`;
  const dist = {};
  for (const x of withDays) dist[x.days.length] = (dist[x.days.length] || 0) + 1;
  out.activeDaysDistribution = dist;

  // Limit wall
  const c = (k) => users.filter((u) => num(u[k]) > 0).length;
  out.limitHit = c('limit_hit');
  out.useYes = c('use_yes');
  out.useNo = c('use_no');
  out.payNo = c('pay_no');
  out.payAnswers = {};
  for (const a of ['yes', 'maybe']) {
    for (const p of PAY_PRICES) out.payAnswers[`${a}_${p}`] = c(`pay_${a}_${p}`);
  }
  out.waitlistJoins = c('waitlist_join');
  out.stuckOpen = c('stuck_open');
  return out;
}

async function main() {
  const { Redis } = await import('@upstash/redis');
  const url = process.env.STUDBUD_INTEREST_KV_REST_API_URL;
  const token = process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Set STUDBUD_INTEREST_KV_REST_API_URL and _TOKEN');
  const redis = new Redis({ url, token });

  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'events:u:*', count: 500 });
    cursor = String(next);
    keys.push(...batch);
  } while (cursor !== '0');

  const users = [];
  for (let i = 0; i < keys.length; i += 100) {
    const p = redis.pipeline();
    for (const k of keys.slice(i, i + 100)) p.hgetall(k);
    for (const h of await p.exec()) if (h) users.push(h);
  }
  const durations = await redis.lrange('events:durations', 0, 999);

  console.log(JSON.stringify(summarize(users, durations), null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
