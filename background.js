// background.js
// Service worker (Manifest V3). Handles all outbound network calls so the
// content script never touches the API directly.

const BREAKDOWN_ENDPOINT = 'https://studbud-two.vercel.app/api/breakdown';
const INTEREST_ENDPOINT = 'https://studbud-two.vercel.app/api/interest';
const EVENTS_ENDPOINT = 'https://studbud-two.vercel.app/api/events';

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
