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
//     planId?: string,                       // from the 'ready' breakdown response; needed to unlock unlimited access
//     assignmentType?, stepsTotal?, stepsCompleted?, plansCompleted?, analysesUsed?, avatarMessages?, asks?
//   }
// Response: { ok: true, granted: boolean, expiresAt?: number } or { error }
// granted is true when this submission unlocks (or the install already has) unlimited beta access: trigger 'completion',
// a reuse answer, and a plan that this install created, finished (all steps) and that is older than MIN_PLAN_SEC.
// Feedback is stored whether or not access is granted. ent:<anonId> is written only here.
//
// Responses are stored newest-first in the Redis list `feedback:responses` (capped at MAX_LIST).
// Read them in the Upstash data browser. If they are ever rendered on a page (e.g. a dashboard), escape the text:
// it is free text typed by students.

import { Redis } from '@upstash/redis';
import { guard } from './_lib/guard.js';
import { betaOpen, betaUntil } from './_lib/beta.js';

const MAX_TEXT = 500; // keep in sync with FEEDBACK_MAX_LEN in content.js
const DAILY_CAP = 5;  // submissions per anonId per UTC day (a legitimate student sends one)
const MAX_LIST = 5000;
const MIN_PLAN_SEC = 120; // minimum time between plan creation and the grant. A guess: tune from events:durations
const PLAN_ID_RE = /^[0-9a-f-]{36}$/i;

const TRIGGERS = ['completion', 'limit_hit'];
const REUSE = ['yes', 'no'];
const TYPES = ['problem_set', 'essay', 'research_paper', 'lab_report', 'reading_response', 'presentation', 'coding', 'other'];

function cleanString(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function cleanCount(v) {
  return Number.isInteger(v) && v >= 0 ? Math.min(v, 9999) : 0;
}

// Decides whether this submission unlocks unlimited access. A failed check never blocks the feedback itself.
// The reason is logged only; the client gets just granted true/false so the checks are not spelled out to it.
async function tryGrant(redis, { anonId, trigger, reuse, planId, stepsCompleted }) {
  const deny = (reason) => {
    console.log(`[feedback] no grant: ${reason}`);
    return { granted: false };
  };
  if (!betaOpen()) return deny('beta_closed');
  if (await redis.exists(`ent:${anonId}`)) return { granted: true, expiresAt: betaUntil() }; // already unlocked
  if (trigger !== 'completion' || !reuse || !PLAN_ID_RE.test(planId)) return deny('not_eligible');

  const plan = await redis.get(`plan:${planId}`);
  if (!plan || plan.userId !== anonId) return deny('unknown_plan');
  if (Date.now() - plan.createdAt < MIN_PLAN_SEC * 1000) return deny('too_fast');
  if (stepsCompleted < plan.steps) return deny('incomplete');

  await redis.set(`ent:${anonId}`, { grantedAt: Date.now(), planId });
  await redis.sadd('beta:granted', anonId); // for the readout
  return { granted: true, expiresAt: betaUntil() };
}

export default async function handler(req, res) {
  if (!(await guard(req, res, { name: 'feedback', ipDailyCap: 150, globalDailyCap: 500 }))) return;

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

    const stepsCompleted = cleanCount(body.stepsCompleted);
    const planId = cleanString(body.planId, 64);
    const grant = await tryGrant(redis, { anonId, trigger, reuse, planId, stepsCompleted });

    const record = {
      ts: Date.now(),
      anonId,
      trigger,
      reuse,
      text,
      assignmentType: TYPES.includes(body.assignmentType) ? body.assignmentType : null,
      stepsTotal: cleanCount(body.stepsTotal),
      stepsCompleted,
      plansCompleted: cleanCount(body.plansCompleted),
      analysesUsed: cleanCount(body.analysesUsed),
      avatarMessages: cleanCount(body.avatarMessages),
      asks: cleanCount(body.asks),
      planId: PLAN_ID_RE.test(planId) ? planId : null,
      granted: grant.granted,
    };

    await redis.lpush('feedback:responses', JSON.stringify(record));
    await redis.ltrim('feedback:responses', 0, MAX_LIST - 1);

    return res.status(200).json({ ok: true, granted: grant.granted, expiresAt: grant.expiresAt });
  } catch (err) {
    console.error('Feedback endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
