// readout.mjs - studbud beta read-out. Read-only: never writes to Redis.
// Usage:
//   npm i @upstash/redis
//   STUDBUD_INTEREST_KV_REST_API_URL=... STUDBUD_INTEREST_KV_REST_API_TOKEN=... node readout.mjs
//
// Reads events:u:<anonId> hashes (SCAN) and the events:durations list written by api/events.js.
// Users without `steps_total` (pre-0.1.1 installs) are excluded from the plan-size metrics, not counted as 0.
// Users without `intake_started` (older clients) are excluded from the intake-success metric.
// Also reads the interest:events list written by api/interest.js and reports UNIQUE clickers per coming-soon
// feature and per integration (repeat clicks from the same anon id count once; raw interest:count:* keys do not dedupe).
// Optional: STUDBUD_EXCLUDE_IDS=id1,id2 drops those anon install ids (e.g. your dev install) before summarizing.
// Note: the events:durations list is anonymous, so excluded ids' durations cannot be removed from it.

const DAY_MS = 86400000;
const PAY_PRICES = ['lt3', '3', '5', '8'];
const MIN_N = 30; // decision rule: don't apply thresholds to a denominator below this (worst-case error > ±18 points)

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

  // Intake success: users who typed into the intake box and then got a plan.
  // Cohort = users whose client sends intake_started. Older clients have plan_created but no intake_started,
  // so they are left out of BOTH sides instead of inflating the numerator.
  const started = users.filter((u) => num(u.intake_started) > 0);
  const startedAndPlanned = started.filter((u) => num(u.plan_created) > 0);
  out.usersStartedIntake = started.length;
  out.intakeSuccess = `${startedAndPlanned.length}/${started.length} (${pct(startedAndPlanned.length, started.length)})` +
    (started.length < MIN_N ? ` - n<${MIN_N}, anecdotal` : '');

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

// Coming-soon interest: unique anon ids per feature / integration from the interest:events list.
// Denominator is installs (users with any recorded event). Panel opens are not tracked, so this is a
// lower bound on interest among users who actually saw the cards.
export function summarizeInterest(events, installs, excludeIds = new Set()) {
  const rows = events
    .map((e) => {
      if (typeof e !== 'string') return e;
      try { return JSON.parse(e); } catch { return null; }
    })
    .filter((e) => e && typeof e.anonId === 'string' && typeof e.feature === 'string' && !excludeIds.has(e.anonId));

  const byFeature = {};
  const integrations = {};
  const integrationSets = {};
  for (const e of rows) {
    const f = (byFeature[e.feature] ||= { rawClicks: 0, ids: new Set() });
    f.rawClicks += 1;
    f.ids.add(e.anonId);
    for (const i of Array.isArray(e.integrations) ? e.integrations : []) {
      (integrationSets[i] ||= new Set()).add(e.anonId);
    }
  }

  const out = { features: {}, integrationsUniqueUsers: {} };
  for (const [name, f] of Object.entries(byFeature)) {
    out.features[name] = {
      uniqueUsers: f.ids.size,
      rawClicks: f.rawClicks,
      pctOfInstalls: pct(f.ids.size, installs),
    };
  }
  for (const [name, set] of Object.entries(integrationSets)) integrations[name] = set.size;
  out.integrationsUniqueUsers = integrations;
  out.note = installs < MIN_N ? `installs<${MIN_N}, anecdotal` : 'pctOfInstalls is a lower bound (panel opens are not tracked)';
  return out;
}

async function main() {
  const { Redis } = await import('@upstash/redis');
  const url = process.env.STUDBUD_INTEREST_KV_REST_API_URL;
  const token = process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Set STUDBUD_INTEREST_KV_REST_API_URL and _TOKEN');
  const redis = new Redis({ url, token });

  const exclude = new Set((process.env.STUDBUD_EXCLUDE_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, { match: 'events:u:*', count: 500 });
    cursor = String(next);
    keys.push(...batch.filter((k) => !exclude.has(k.slice('events:u:'.length))));
  } while (cursor !== '0');

  const users = [];
  for (let i = 0; i < keys.length; i += 100) {
    const p = redis.pipeline();
    for (const k of keys.slice(i, i + 100)) p.hgetall(k);
    for (const h of await p.exec()) if (h) users.push(h);
  }
  const durations = await redis.lrange('events:durations', 0, 999);

  const rawInterest = await redis.lrange('interest:events', 0, -1);
  const result = summarize(users, durations);
  result.interest = summarizeInterest(rawInterest, users.length, exclude);

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
