// background.js
// Service worker (Manifest V3). Handles all outbound network calls so the
// content script never touches the API directly.

const BREAKDOWN_ENDPOINT = 'https://studbud-two.vercel.app/api/breakdown';
const INTEREST_ENDPOINT = 'https://studbud-two.vercel.app/api/interest';
const EVENTS_ENDPOINT = 'https://studbud-two.vercel.app/api/events';
const AVATAR_ENDPOINT = 'https://studbud-two.vercel.app/api/avatar';
const FEEDBACK_ENDPOINT = 'https://studbud-two.vercel.app/api/feedback';
const STUCK_ENDPOINT = 'https://studbud-two.vercel.app/api/stuck';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BREAKDOWN_TASK') {
    // payload: { brief, answers, round }. The response is forwarded as-is:
    // { status: 'needs_info', questions } or { status: 'ready', title, steps }.
    handleBreakdown(message.payload)
      .then((data) => sendResponse({ ok: true, ...data }))
      .catch((err) => {
        console.error('Breakdown request failed:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }

  if (message.type === 'RECORD_INTEREST') {
    handleRecordInterest(message.event)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        // Non-critical: interest tracking should never surface an error to the
        // student or block the UI, so this is logged, not thrown further.
        console.error('Interest tracking failed:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }

  if (message.type === 'RECORD_EVENT') {
    handleRecordEvent(message.event)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        // Analytics must never surface an error to the student.
        console.error('Event tracking failed:', err);
        sendResponse({ ok: false, error: err.message });
      });
    return true; // async response
  }

  if (message.type === 'AVATAR_CHAT') {
    // payload: { userId, message, history, context }. The response is forwarded as-is:
    // { ok, category, reply } or { ok: false, error, limit? }.
    handleAvatarChat(message.payload)
      .then((data) => sendResponse(data))
      .catch((err) => {
        console.error('Avatar chat request failed:', err);
        sendResponse({ ok: false, error: 'network' });
      });
    return true; // async response
  }

  if (message.type === 'STUCK_HELP') {
    // payload: { brief, step: {title, detail}, type, level, stuckKind, note, history }. The response is forwarded as-is:
    // { ok, status: 'ok', level, explain|example|substeps, ... } or { ok: false, error, limit? }.
    handleStuckHelp(message.payload)
      .then((data) => sendResponse(data))
      .catch((err) => {
        console.error('Stuck help request failed:', err);
        sendResponse({ ok: false, error: 'network' });
      });
    return true; // async response
  }

  if (message.type === 'SUBMIT_FEEDBACK') {
    // payload: see submitFeedback() in content.js. Response: { ok } on success, { ok: false, error } otherwise.
    handleFeedback(message.payload)
      .then((data) => sendResponse(data))
      .catch((err) => {
        console.error('Feedback request failed:', err);
        sendResponse({ ok: false, error: 'network' });
      });
    return true; // async response
  }

  return false; // not for us, let other listeners handle it
});

async function handleBreakdown(payload) {
  const res = await fetch(BREAKDOWN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}

async function handleRecordInterest(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Missing interest event');
  }

  const res = await fetch(INTEREST_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }
}

async function handleRecordEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('Missing event');
  }

  const res = await fetch(EVENTS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }
}

// Unlike the handlers above, this does not throw on a non-OK status: the content
// script needs the body of a 429 ({ limit: true }) to show the right message.
async function handleAvatarChat(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing avatar payload');
  }

  const res = await fetch(AVATAR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  return { ...body, ok: res.ok };
}

// Same shape as handleAvatarChat: does not throw on a non-OK status so the content
// script can read { error, limit } from the body.
async function handleStuckHelp(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing stuck payload');
  }

  const res = await fetch(STUCK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  return { ...body, ok: res.ok };
}

async function handleFeedback(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Missing feedback payload');
  }

  const res = await fetch(FEEDBACK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json().catch(() => ({}));
  return { ...body, ok: res.ok };
}
