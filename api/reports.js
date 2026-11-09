// api/reports.js
// Vercel serverless function. Deploy path: /api/reports
// "Report a problem" from the extension popup (popup.js -> background.js SUBMIT_REPORT -> here).
// Request:  { message: string (10-1000 chars), email?: string, version?: string, hostname?: string }
// Response: { ok: true }  or  { error }
// Stores ONLY those four fields plus a timestamp. No install id and no page content. The email is optional and used only to reply.
// The message is free text: despite the popup's warning a student may paste assignment text or personal details into it,
// so reports are capped (oldest fall off) and the privacy policy should say reports are stored.
//
// Redis layout:
//   reports:list  LIST  one JSON object per report, newest first, capped at MAX_REPORTS
// Read them in the Upstash console (Data Browser, or the CLI tab):  LRANGE reports:list 0 -1
//
// Requires env vars (read by _lib/guard.js): STUDBUD_INTEREST_KV_REST_API_URL, STUDBUD_INTEREST_KV_REST_API_TOKEN.

import { guard, getRedis } from './_lib/guard.js';

const MIN_MESSAGE = 10;    // matches REPORT_MIN_LEN in popup.js
const MAX_MESSAGE = 1000;  // matches REPORT_MAX_LEN in popup.js
const MAX_EMAIL = 254;
const MAX_REPORTS = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,20}$/;
const HOST_RE = /^[a-z0-9.-]{1,253}$/;

function cleanString(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export default async function handler(req, res) {
  // Reports are rare. Students on one campus network share an IP, so the per-IP cap stays well above one person's need.
  // Guesses: tune from real usage.
  if (!(await guard(req, res, { name: 'reports', ipDailyCap: 30, globalDailyCap: 500 }))) return;

  const body = req.body || {};

  const message = cleanString(body.message, MAX_MESSAGE);
  if (message.length < MIN_MESSAGE) {
    return res.status(400).json({ error: 'Please describe the problem.' });
  }

  const email = cleanString(body.email, MAX_EMAIL);
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // Context fields are kept only if they look right; a malformed value is dropped, not rejected, so the report still goes through.
  const rawVersion = cleanString(body.version, 20);
  const version = VERSION_RE.test(rawVersion) ? rawVersion : '';
  const rawHost = cleanString(body.hostname, 253).toLowerCase();
  const hostname = HOST_RE.test(rawHost) ? rawHost : '';

  const r = getRedis();
  if (!r) {
    console.error('[reports] Upstash env vars are not set');
    return res.status(500).json({ error: 'Internal server error' });
  }

  try {
    const entry = JSON.stringify({ at: new Date().toISOString(), message, email, version, hostname });
    const p = r.pipeline();
    p.lpush('reports:list', entry);
    p.ltrim('reports:list', 0, MAX_REPORTS - 1);
    await p.exec();
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[reports] store failed:', err); // the message text is never logged
    return res.status(500).json({ error: 'Internal server error' });
  }
}
