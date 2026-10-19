// api/_lib/guard.js
// Shared abuse protection for every public endpoint. The leading underscore keeps Vercel from deploying this file as a route.
// Requires env vars: STUDBUD_INTEREST_KV_REST_API_URL, STUDBUD_INTEREST_KV_REST_API_TOKEN
// Optional env var:  STUDBUD_EXTENSION_IDS  comma-separated Chrome extension ids allowed to call the API
//                    (the Web Store id AND your unpacked dev id; find them at chrome://extensions)
//
// What guard() does, in order:
//   1. CORS headers. With STUDBUD_EXTENSION_IDS set, only chrome-extension://<id> origins are echoed back.
//   2. Answers OPTIONS, rejects anything but POST (405).
//   3. Origin check (403) when STUDBUD_EXTENSION_IDS is set. Requests with a missing or foreign Origin are refused.
//      This stops casual abuse (curl, other websites). A script can fake the header, so it is a speed bump, not a lock.
//   4. Per-IP daily cap (429). The IP is SHA-256 hashed before it is used as a Redis key, never stored raw.
//   5. Global daily cap (503), a circuit breaker for cost. It only counts requests that passed the IP cap, so one noisy
//      client cannot lock everyone out by itself. It does not stop many different IPs: its job is protecting your OpenAI bill.
// Counters fail open: if Redis is unreachable the request is allowed (and the error logged).
//
// The numbers passed in by each endpoint are guesses sized for a ~100-person beta. Students on one campus network
// share an IP, so keep per-IP caps well above what one person needs. Tune from real usage.

import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';

const ALLOWED_ORIGINS = (process.env.STUDBUD_EXTENSION_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((id) => `chrome-extension://${id}`);

const COUNTER_TTL_SEC = 60 * 60 * 48;

let redis;
export function getRedis() {
  if (redis) return redis;
  const url = process.env.STUDBUD_INTEREST_KV_REST_API_URL;
  const token = process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ipHash(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : String(fwd || req.headers['x-real-ip'] || '')).split(',')[0].trim() || 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

async function bumpDaily(r, key) {
  const p = r.pipeline();
  p.incr(key);
  p.expire(key, COUNTER_TTL_SEC);
  const out = await p.exec();
  return Number(out[0]);
}

// Returns true if the handler should continue. Otherwise the response has already been sent.
export async function guard(req, res, { name, ipDailyCap, globalDailyCap }) {
  const origin = req.headers.origin;
  const restrict = ALLOWED_ORIGINS.length > 0;

  res.setHeader('Access-Control-Allow-Origin', restrict ? (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]) : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return false;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }

  if (restrict && !ALLOWED_ORIGINS.includes(origin)) {
    // Logged so a wrong extension id in the env var is easy to spot in the Vercel logs.
    console.warn(`[guard:${name}] rejected origin:`, origin || '(none)');
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }

  console.warn(`[guard:${name}] ip cap hit (${ipDailyCap})`);
  
  const r = getRedis();
  if (!r) return true;

  try {
    const day = today();
    const ipCount = await bumpDaily(r, `guard:ip:${name}:${ipHash(req)}:${day}`);
    if (ipCount > ipDailyCap) {
      res.status(429).json({ error: 'Too many requests from this network today. Try again tomorrow.', limit: true });
      return false;
    }
    const globalCount = await bumpDaily(r, `guard:global:${name}:${day}`);
    if (globalCount > globalDailyCap) {
      console.error(`[guard:${name}] global daily cap reached (${globalDailyCap})`);
      res.status(503).json({ error: 'StudBud is busy today. Try again tomorrow.', limit: true });
      return false;
    }
  } catch (err) {
    console.error(`[guard:${name}] counter check failed:`, err);
  }
  return true;
}

// Per-user daily cap for endpoints that do not already have one. Fails open. Returns true if within the cap.
export async function withinUserCap(name, userId, cap) {
  const r = getRedis();
  if (!r) return true;
  try {
    return (await bumpDaily(r, `guard:user:${name}:${userId}:${today()}`)) <= cap;
  } catch (err) {
    console.error(`[guard:${name}] user cap check failed:`, err);
    return true;
  }
}
