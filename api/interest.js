// api/interest.js
// Vercel serverless function. Deploy path: /api/interest
// Records "coming soon" feature interest clicks (parser / injection_system)
// so we can see which paid features testers actually want before building them.
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars,
// set automatically by the Upstash Redis Marketplace integration on Vercel.

import { Redis } from '@upstash/redis';

// fromEnv() only looks for the unprefixed UPSTASH_REDIS_REST_URL/TOKEN names.
// Vercel prefixed these with the store name (STUDBUD_INTEREST_) because
// that's what the database was named during setup, so we point at those
// explicitly instead.
const redis = new Redis({
  url: process.env.STUDBUD_INTEREST_KV_REST_API_URL,
  token: process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN,
});

const VALID_FEATURES = new Set(['parser', 'injection_system']);
const MAX_INTEGRATIONS = 20; // abuse guard, not a real limit — we only ever send ~8

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { anonId, feature, integrations, timestamp } = req.body || {};

  if (!anonId || typeof anonId !== 'string' || anonId.length > 100) {
    return res.status(400).json({ error: 'Missing or invalid "anonId"' });
  }

  if (!VALID_FEATURES.has(feature)) {
    return res.status(400).json({ error: 'Invalid "feature"' });
  }

  const cleanIntegrations = Array.isArray(integrations)
    ? integrations.filter((i) => typeof i === 'string').slice(0, MAX_INTEGRATIONS)
    : [];

  const event = {
    anonId,
    feature,
    integrations: cleanIntegrations,
    timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
    receivedAt: Date.now(),
  };

  try {
    // One list holds every event, newest last. Simple and enough at beta scale
    // (a few hundred testers, a handful of clicks each). Revisit if volume grows.
    await redis.rpush('interest:events', JSON.stringify(event));

    // Also keep per-feature and per-integration counters for a quick read
    // without re-parsing the whole event list.
    await redis.incr(`interest:count:${feature}`);
    for (const integration of cleanIntegrations) {
      await redis.incr(`interest:integration:${integration}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Interest endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
