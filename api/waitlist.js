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
//   waitlist:rl:<hash>:<day>   per-IP attempt counter (the IP is SHA-256 hashed, never stored raw)

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const MAX_EMAIL = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAILY_IP_CAP = 5; // attempts per IP per UTC day. A guess: low enough to blunt scripted spam, high enough for a shared campus network.

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

function clientKey(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || '')).split(',')[0].trim() || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const raw = req.body && typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const email = raw.toLowerCase();
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const r = getRedis();
    const day = new Date().toISOString().slice(0, 10);

    // Rate limit fails open: a Redis hiccup should not stop a real student from joining.
    try {
      const key = `waitlist:rl:${clientKey(req)}:${day}`;
      const count = await r.incr(key);
      if (count === 1) await r.expire(key, 60 * 60 * 48);
      if (count > DAILY_IP_CAP) {
        return res.status(429).json({ error: 'Too many attempts. Try again tomorrow.', limit: true });
      }
    } catch (err) {
      console.error('Waitlist rate limit check failed:', err);
    }

    await r.hsetnx('waitlist:emails', email, day); // no-op if already on the list
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Waitlist endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
