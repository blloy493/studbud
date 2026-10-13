// api/feedback.js
// Vercel serverless function. Deploy path: /api/feedback
// Requires env vars: STUDBUD_INTEREST_KV_REST_API_URL, STUDBUD_INTEREST_KV_REST_API_TOKEN
//
// Request (from the extension's feedback card, via background.js):
//   {
//     anonId: string,                        // anonymous per-install id
//     trigger: 'completion' | 'limit_hit',
//     reuse: 'yes' | 'no' | null,            // "Would you use StudBud on your next assignment?"
//     text: string,                          // optional free text, max 500 chars
//     assignmentType?, stepsTotal?, stepsCompleted?, plansCompleted?, analysesUsed?, avatarMessages?, asks?
//   }
// Response: { ok: true } or { error }
//
// Responses are stored newest-first in the Redis list `feedback:responses` (capped at MAX_LIST).
// Read them in the Upstash data browser. If they are ever rendered on a page (e.g. a dashboard), escape the text:
// it is free text typed by students.

import { Redis } from '@upstash/redis';

const MAX_TEXT = 500; // keep in sync with FEEDBACK_MAX_LEN in content.js
const DAILY_CAP = 5;  // submissions per anonId per UTC day (a legitimate student sends one)
const MAX_LIST = 5000;

const TRIGGERS = ['completion', 'limit_hit'];
const REUSE = ['yes', 'no'];
const TYPES = ['problem_set', 'essay', 'research_paper', 'lab_report', 'reading_response', 'presentation', 'coding', 'other'];

function cleanString(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function cleanCount(v) {
  return Number.isInteger(v) && v >= 0 ? Math.min(v, 9999) : 0;
}

export default async function handler(req, res) {
  // CORS: allow the extension to call this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};

  const anonId = cleanString(body.anonId, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(anonId)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const trigger = TRIGGERS.includes(body.trigger) ? body.trigger : null;
  if (!trigger) {
    return res.status(400).json({ error: 'Invalid trigger' });
  }

  const reuse = REUSE.includes(body.reuse) ? body.reuse : null;
  const text = cleanString(body.text, MAX_TEXT);
  if (!reuse && !text) {
    return res.status(400).json({ error: 'Empty feedback' });
  }

  const url = process.env.STUDBUD_INTEREST_KV_REST_API_URL;
  const token = process.env.STUDBUD_INTEREST_KV_REST_API_TOKEN;
  if (!url || !token) {
    // Unlike the avatar cap, feedback must not be silently dropped: fail loudly so the student can retry.
    console.error('Feedback storage is not configured');
    return res.status(500).json({ error: 'Storage not configured' });
  }
  const redis = new Redis({ url, token });

  try {
    const day = new Date().toISOString().slice(0, 10);
    const capKey = `feedback:daily:${anonId}:${day}`;
    const count = await redis.incr(capKey);
    if (count === 1) await redis.expire(capKey, 60 * 60 * 48);
    if (count > DAILY_CAP) {
      return res.status(429).json({ error: 'Too many submissions' });
    }

    const record = {
      ts: Date.now(),
      anonId,
      trigger,
      reuse,
      text,
      assignmentType: TYPES.includes(body.assignmentType) ? body.assignmentType : null,
      stepsTotal: cleanCount(body.stepsTotal),
      stepsCompleted: cleanCount(body.stepsCompleted),
      plansCompleted: cleanCount(body.plansCompleted),
      analysesUsed: cleanCount(body.analysesUsed),
      avatarMessages: cleanCount(body.avatarMessages),
      asks: cleanCount(body.asks),
    };

    await redis.lpush('feedback:responses', JSON.stringify(record));
    await redis.ltrim('feedback:responses', 0, MAX_LIST - 1);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Feedback endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
