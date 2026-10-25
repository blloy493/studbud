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
// Unlimited-beta unlock funnel (summarizeUnlock): reads the beta:granted set (written only by api/feedback.js), the
// beta:plans:<anonId> lifetime plan counters (api/breakdown.js) and the feedback:responses list. Free text is never printed.
// Optional: STUDBUD_EXCLUDE_IDS=id1,id2 drops those anon install ids (e.g. your dev install) before summarizing.
// Note: the events:durations list is anonymous, so excluded ids' durations cannot be removed from it.

const DAY_MS = 86400000;
const PAY_PRICES = ['lt3', '3', '5', '8'];
const FREE_PLAN_LIMIT = 3;        // keep in sync with BETA_PLAN_LIMIT in api/breakdown.js
const PAY_SURVEY_AFTER_PLANS = 3; // keep in sync with PAY_SURVEY_AFTER_PLANS in content.js
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

  // Abandon reasons: a student discarded a plan in progress and tapped a reason (abandon_skip = no reason).
  // Counts are DISCARD EVENTS (one student can discard more than once), not users.
  // avgStepsDoneAtDiscard only uses users whose clients reported abandon_steps_done.
  const ABANDON_KEYS = ['many', 'unclear', 'wrong', 'other_way', 'other', 'skip'];
  const abandonOf = (u) => sum(ABANDON_KEYS.map((k) => num(u[`abandon_${k}`])));
  const byReason = {};
  for (const k of ABANDON_KEYS) byReason[k] = sum(users.map((u) => num(u[`abandon_${k}`])));
  const totalDiscards = sum(ABANDON_KEYS.map((k) => byReason[k]));
  const withSteps = users.filter((u) => u.abandon_steps_done !== undefined);
  const stepEvents = sum(withSteps.map(abandonOf));
  out.abandon = {
    totalDiscards,
    usersWhoDiscarded: users.filter((u) => abandonOf(u) > 0).length,
    discardsPerPlanCreated: pct(totalDiscards, created),
    byReason,
    avgStepsDoneAtDiscard: stepEvents ? (sum(withSteps.map((u) => num(u.abandon_steps_done))) / stepEvents).toFixed(1) : 'n/a',
  };
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

// Unlimited-beta unlock funnel. Inputs are plain data so this stays testable:
//   feedbackRows: feedback:responses entries (JSON strings or objects)
//   grantedIds:   members of the beta:granted set (installs the server unlocked)
//   planCounts:   { anonId: lifetime ready plans } from beta:plans:<anonId>
//   usersById:    { anonId: events hash } from events:u:<anonId>
// Rows written before the unlock gate have no `granted` field and are left out of the unlock-rate numbers.
// Totals per install (plans created/completed) cannot be split into before / after the unlock: events carry no timestamps.
export function summarizeUnlock({ feedbackRows, grantedIds, planCounts, usersById, installs }, excludeIds = new Set()) {
  const ok = (id) => typeof id === 'string' && !excludeIds.has(id);
  const granted = new Set(grantedIds.filter(ok));
  const rows = feedbackRows
    .map((r) => {
      if (typeof r !== 'string') return r;
      try { return JSON.parse(r); } catch { return null; }
    })
    .filter((r) => r && ok(r.anonId) && r.trigger === 'completion');

  // Completion cards that could have unlocked: sent by a gate-aware client (planId) to a gate-aware server (granted is a boolean).
  const eligible = rows.filter((r) => typeof r.planId === 'string' && typeof r.granted === 'boolean');
  const eligibleIds = new Set(eligible.map((r) => r.anonId));
  const unlockedIds = [...eligibleIds].filter((id) => granted.has(id));
  const stuckIds = [...eligibleIds].filter((id) => !granted.has(id)); // sent the card but never unlocked
  const deniedSubmissions = eligible.filter((r) => !r.granted).length;

  const ids = Object.keys(planCounts).filter(ok);
  const atLimit = ids.filter((id) => num(planCounts[id]) >= FREE_PLAN_LIMIT);
  const atLimitUnlocked = atLimit.filter((id) => granted.has(id));

  const plansOf = (id, key) => num(usersById[id] && usersById[id][key]);
  const avg = (list, key) => (list.length ? (sum(list.map((id) => plansOf(id, key))) / list.length).toFixed(1) : 'n/a');
  const notUnlocked = Object.keys(usersById).filter((id) => ok(id) && !granted.has(id));

  const hasPayAnswer = (id) => {
    const u = usersById[id] || {};
    return num(u.pay_no) > 0 || Object.keys(u).some((k) => /^pay_(yes|maybe)_/.test(k) && num(u[k]) > 0);
  };
  const payEligible = [...granted].filter((id) => plansOf(id, 'plan_completed') >= PAY_SURVEY_AFTER_PLANS);

  const reuseOf = (ids2, v) => ids2.filter((id) => eligible.some((r) => r.anonId === id && r.reuse === v)).length;

  return {
    unlockedInstalls: granted.size,
    unlockedPctOfInstalls: pct(granted.size, installs),
    unlockRate: `${unlockedIds.length}/${eligibleIds.size} (${pct(unlockedIds.length, eligibleIds.size)}) of installs that sent a completion card` +
      (eligibleIds.size < MIN_N ? ` - n<${MIN_N}, anecdotal` : ''),
    completionCardsSent: rows.length,
    cardsWithoutPlanId: rows.filter((r) => typeof r.granted === 'boolean' && typeof r.planId !== 'string').length, // plan record missing: cannot unlock
    deniedSubmissions, // the reason is in the Vercel logs ("[feedback] no grant: ..."), not stored
    sentCardButNeverUnlocked: stuckIds.length,
    wouldUseNextAssignmentAmongUnlocked: { yes: reuseOf(unlockedIds, 'yes'), no: reuseOf(unlockedIds, 'no') },
    atFreeLimit: { installs: atLimit.length, unlocked: atLimitUnlocked.length, stillBlocked: atLimit.length - atLimitUnlocked.length },
    avgPlansPerInstall: {
      unlocked: { created: avg([...granted], 'plan_created'), completed: avg([...granted], 'plan_completed') },
      notUnlocked: { created: avg(notUnlocked, 'plan_created'), completed: avg(notUnlocked, 'plan_completed') },
      note: 'totals include plans from before the unlock',
    },
    paySurvey: {
      unlockedWithEnoughPlans: payEligible.length,
      answeredPayQuestion: payEligible.filter(hasPayAnswer).length,
    },
  };
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
  const usersById = {};
  for (let i = 0; i < keys.length; i += 100) {
    const batchKeys = keys.slice(i, i + 100);
    const p = redis.pipeline();
    for (const k of batchKeys) p.hgetall(k);
    (await p.exec()).forEach((h, idx) => {
      if (!h) return;
      users.push(h);
      usersById[batchKeys[idx].slice('events:u:'.length)] = h;
    });
  }
  const durations = await redis.lrange('events:durations', 0, 999);

  const rawInterest = await redis.lrange('interest:events', 0, -1);
  const result = summarize(users, durations);
  result.interest = summarizeInterest(rawInterest, users.length, exclude);

  // Unlimited-beta unlock funnel
  const planKeys = [];
  let planCursor = '0';
  do {
    const [next, batch] = await redis.scan(planCursor, { match: 'beta:plans:*', count: 500 });
    planCursor = String(next);
    planKeys.push(...batch);
  } while (planCursor !== '0');
  const planCounts = {};
  for (let i = 0; i < planKeys.length; i += 100) {
    const batchKeys = planKeys.slice(i, i + 100);
    const p = redis.pipeline();
    for (const k of batchKeys) p.get(k);
    (await p.exec()).forEach((v, idx) => { planCounts[batchKeys[idx].slice('beta:plans:'.length)] = num(v); });
  }
  const grantedIds = await redis.smembers('beta:granted');
  const feedbackRows = await redis.lrange('feedback:responses', 0, -1);
  result.unlock = summarizeUnlock({ feedbackRows, grantedIds, planCounts, usersById, installs: users.length }, exclude);

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
