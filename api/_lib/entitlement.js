// api/_lib/entitlement.js
// Access tiers for an install (the anonymous userId breakdown.js already uses):
//   paid  -> unlimited while paid:<userId>.exp is in the future (passes and the legacy monthly subscription)
//   trial -> unlimited for TRIAL_DAYS, starting at the FIRST SUCCESSFUL INTAKE (see startTrial). Until then it is "available, not started".
//   free  -> after the trial: a small monthly allowance (plan / stuck / chat), reset on the 1st of each UTC month
// Separate from ent:<userId>, the old beta unlock written by api/feedback.js. That path is retired by the paid-product pivot.
// Paid access must NOT depend on betaOpen(): ending the beta must not cut off paying students.
//
// Redis layout:
//   paid:<userId>            HASH    { exp: ms timestamp access runs to, plan: 'weekly'|'semester'|'yearly'|'monthly', cust: Stripe customer id }
//   cust:<customerId>        STRING  userId (lets later Stripe events find the install; also used by api/portal.js)
//   trial:<userId>           STRING  ms timestamp the trial started (set once, NX)
//   usage:<userId>:<YYYY-MM> HASH    { plan, stuck, chat } uses counted this UTC month, only while on the free tier (TTL ~40 days)
//   events:u:<userId>        HASH    the same hash api/events.js writes; recordServerEvent adds server-side counters to it
//
// Tunable without a code change (Vercel env vars, applied on redeploy):
//   TRIAL_DAYS (default 14), ALLOW_PLAN (3), ALLOW_STUCK (3), ALLOW_CHAT (5)
//
// Every function that reads Redis can throw; the helpers used on the request path (checkAllowance, recordUse) fail OPEN so a
// Redis outage never blocks a student. getStatus throws; api/plan.js already catches and fails soft.

import { getRedis } from './guard.js';

export const SEMESTER_DAYS = 120; // DECISION: length of one semester pass. Change here only.
const DAY_MS = 24 * 60 * 60 * 1000;

// Pass lengths in days. Group pass is a later step (it reuses these: a group purchase mints codes that redeem as one of these).
export const PASS_DAYS = { weekly: 7, semester: SEMESTER_DAYS, yearly: 365 };

export const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // same pattern as breakdown.js

export const KINDS = ['plan', 'stuck', 'chat'];

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Read on every call so a redeploy with new env vars takes effect with no code edit.
export function limits() {
  return {
    trialDays: intEnv('TRIAL_DAYS', 14),
    allow: { plan: intEnv('ALLOW_PLAN', 3), stuck: intEnv('ALLOW_STUCK', 3), chat: intEnv('ALLOW_CHAT', 5) },
  };
}

const paidKey = (userId) => `paid:${userId}`;
const trialKey = (userId) => `trial:${userId}`;
const monthKey = () => new Date().toISOString().slice(0, 7); // UTC, e.g. 2026-12
const usageKey = (userId) => `usage:${userId}:${monthKey()}`;

function nextResetMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function redisOrThrow() {
  const r = getRedis();
  if (!r) throw new Error('Upstash env vars are not set');
  return r;
}

// ---------- paid access ----------

// ms timestamp paid access runs to; 0 if none. Throws if Redis is down (callers decide whether to fail open).
export async function paidUntil(userId) {
  const exp = await redisOrThrow().hget(paidKey(userId), 'exp');
  return Number(exp || 0);
}

export async function customerFor(userId) {
  return (await redisOrThrow().hget(paidKey(userId), 'cust')) || null;
}

export async function userIdForCustomer(customerId) {
  return (await redisOrThrow().get(`cust:${customerId}`)) || null;
}

// Sets access to run until `exp` (ms). Used for subscriptions, where Stripe says when the paid period ends.
export async function grantUntil(userId, { exp, plan, customerId }) {
  const r = redisOrThrow();
  const p = r.pipeline();
  p.hset(paidKey(userId), { exp, plan, ...(customerId ? { cust: customerId } : {}) });
  if (customerId) p.set(`cust:${customerId}`, userId);
  await p.exec();
}

// One-time pass: adds the pass length on top of whatever access remains, so buying early loses nothing.
export async function extendPass(userId, plan, customerId) {
  const days = PASS_DAYS[plan];
  if (!days) throw new Error(`unknown pass plan: ${plan}`);
  const base = Math.max(await paidUntil(userId), Date.now());
  const exp = base + days * DAY_MS;
  await grantUntil(userId, { exp, plan, customerId });
  return exp;
}

// Kept so stripe-webhook.js keeps working until it is moved to extendPass (checkout/webhook step).
export const extendSemester = (userId, customerId) => extendPass(userId, 'semester', customerId);

// Ends access now (or leaves it alone if it already ends sooner).
export async function endNow(userId) {
  const exp = Math.min(await paidUntil(userId), Date.now());
  await redisOrThrow().hset(paidKey(userId), { exp });
}

// ---------- tier, trial and allowance ----------

// The one place tier is decided. Order: paid, then trial, then free allowance.
// { tier, exp, resetsAt, remaining:{plan,stuck,chat}, trialStarted?, trialEndsAt? }
//   trialStarted:false means the trial is available but the student has not completed an intake yet (trialEndsAt is 0).
//   remaining is the FREE-tier allowance left this month; it is not consumed while on trial or paid.
export async function getStatus(userId) {
  const r = redisOrThrow();
  const { trialDays, allow } = limits();
  const now = Date.now();
  const [exp, trialStart, usage] = await Promise.all([
    paidUntil(userId),
    r.get(trialKey(userId)),
    r.hgetall(usageKey(userId)),
  ]);
  const used = (k) => Number((usage && usage[k]) || 0);
  const remaining = Object.fromEntries(KINDS.map((k) => [k, Math.max(0, allow[k] - used(k))]));
  const base = { exp, resetsAt: nextResetMs(), remaining };

  if (exp > now) return { ...base, tier: 'paid' };

  const start = Number(trialStart || 0);
  if (!start) return { ...base, tier: 'trial', trialStarted: false, trialEndsAt: 0 };

  const trialEndsAt = start + trialDays * DAY_MS;
  if (now < trialEndsAt) return { ...base, tier: 'trial', trialStarted: true, trialEndsAt };
  return { ...base, tier: 'free', trialStarted: true, trialEndsAt };
}

// Call BEFORE the model request. { allowed, status }. Denials are counted as allowance_exhausted_<kind>.
// Fails open (allowed:true, status:null) if Redis is unavailable.
// Pass `status` to recordUse afterwards so the tier is not looked up twice.
export async function checkAllowance(userId, kind) {
  try {
    const status = await getStatus(userId);
    if (status.tier !== 'free') return { allowed: true, status };
    const allowed = status.remaining[kind] > 0;
    if (!allowed) await recordServerEvent(userId, `allowance_exhausted_${kind}`);
    return { allowed, status };
  } catch (err) {
    console.error('[entitlement] checkAllowance failed, failing open:', err);
    return { allowed: true, status: null };
  }
}

// Call AFTER a successful result only (never on failures, guard rejections or expand mode).
//   paid  -> nothing
//   trial -> a successful 'plan' starts the trial if it has not started (SET NX, so it can only happen once)
//   free  -> counts one use against this month's allowance
// Never throws.
export async function recordUse(userId, kind, knownStatus) {
  try {
    const r = redisOrThrow();
    const status = knownStatus || (await getStatus(userId));
    if (status.tier === 'paid') return;

    if (status.tier === 'trial') {
      if (kind === 'plan' && !status.trialStarted) {
        const fresh = await r.set(trialKey(userId), Date.now(), { nx: true });
        if (fresh) await recordServerEvent(userId, 'trial_started');
      }
      return;
    }

    const key = usageKey(userId);
    const p = r.pipeline();
    p.hincrby(key, kind, 1);
    p.expire(key, 40 * 24 * 60 * 60);
    await p.exec();
  } catch (err) {
    console.error('[entitlement] recordUse failed:', err);
  }
}

// Server-side counter in the same hash events.js writes (events:u:<userId>). These names do NOT go through the events.js
// whitelist, because the server writes them directly. Counts only, no content. Never throws.
export async function recordServerEvent(userId, name, by = 1) {
  try {
    await redisOrThrow().hincrby(`events:u:${userId}`, name, by);
  } catch (err) {
    console.error('[entitlement] recordServerEvent failed:', err);
  }
}
