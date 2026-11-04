// api/waitlist.js
// Vercel serverless function. Deploy path: /api/waitlist
// Requires env vars: STUDBUD_INTEREST_KV_REST_API_URL, STUDBUD_INTEREST_KV_REST_API_TOKEN
//
// Request:  { email: string }
// Response: { ok: true }   or   { error, limit?: true }
//
// Stores ONLY the email and the UTC day it first joined, in its own Redis hash. The request carries no install id
// and no usage data, so an email cannot be tied to anyone's activity. Joining twice is a no-op and looks the same
// to the caller (nothing reveals whether an address is already on the list).
//   waitlist:emails   HASH  { <lowercased email>: "YYYY-MM-DD" }
// Abuse protection (Origin check, per-IP cap of 5 attempts/day, global cap) comes from ./_lib/guard.js.

import { Redis } from '@upstash/redis';
import { guard } from './_lib/guard.js';

const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!(await guard(req, res, { name: 'waitlist', ipDailyCap: 30, globalDailyCap: 500 }))) return;

  const raw = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const email = raw.toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const r = getRedis();
    const day = new Date().toISOString().slice(0, 10);

    await r.hsetnx('waitlist:emails', email, day); // no-op if already on the list
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Waitlist endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
