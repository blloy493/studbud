// api/events.js
// Vercel serverless function. Deploy path: /api/events
// Records anonymous usage events to Upstash Redis so beta value can be measured.
// Stores ONLY: an anonymous install ID, event names, per-day activity flags and plan durations.
// It never receives assignment text, answers or any other student content.
//
// Redis layout (2 commands per event):
//   events:u:<anonId>  HASH  { plan_created, step_completed, plan_completed, finish_yes, finish_no : counts, "d:YYYY-MM-DD": 1 }
//   events:durations   LIST  seconds from plan creation to completion (latest 1000)

import { Redis } from '@upstash/redis';

const EVENTS = new Set(['plan_created', 'step_completed', 'plan_completed', 'finish_yes', 'finish_no']);
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { anonId, name, elapsedSec } = req.body || {};
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
