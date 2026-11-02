// api/_lib/entitlement.js
// Paid access, keyed by the install's anonymous userId (the same id breakdown.js already uses).
// Separate from ent:<userId>, which is the beta unlock written by api/feedback.js and switched off by betaOpen().
// Paid access must NOT depend on betaOpen(): ending the beta must not cut off paying students.
//
// Redis layout:
//   paid:<userId>      HASH  { exp: ms timestamp access runs to, plan: 'monthly'|'semester', cust: Stripe customer id }
//   cust:<customerId>  STRING  userId (lets later Stripe events find the install; also used by api/portal.js)
//
// Access is active when exp > now. The webhook only ever moves exp, so there is no separate "status" to keep in sync.

import { getRedis } from './guard.js';

export const SEMESTER_DAYS = 120; // DECISION: length of one semester pass. Change here only.
const DAY_MS = 24 * 60 * 60 * 1000;

export const USER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // same pattern as breakdown.js

const paidKey = (userId) => `paid:${userId}`;

function redisOrThrow() {
  const r = getRedis();
  if (!r) throw new Error('Upstash env vars are not set');
  return r;
}

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

// One-time semester pass: adds SEMESTER_DAYS on top of whatever access remains, so buying early loses nothing.
export async function extendSemester(userId, customerId) {
  const base = Math.max(await paidUntil(userId), Date.now());
  const exp = base + SEMESTER_DAYS * DAY_MS;
  await grantUntil(userId, { exp, plan: 'semester', customerId });
  return exp;
}

// Ends access now (or leaves it alone if it already ends sooner).
export async function endNow(userId) {
  const exp = Math.min(await paidUntil(userId), Date.now());
  await redisOrThrow().hset(paidKey(userId), { exp });
}
