// background.js
// Service worker (Manifest V3). Handles all outbound network calls so the
// content script never touches the API directly.

const BREAKDOWN_ENDPOINT = 'https://studbud-two.vercel.app/api/breakdown';
const INTEREST_ENDPOINT = 'https://studbud-two.vercel.app/api/interest';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BREAKDOWN_TASK') {
    handleBreakdown(message.task)
      .then(({ subtasks, title, details }) => sendResponse({ ok: true, subtasks, title, details }))
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

  return false; // not for us, let other listeners handle it
});

async function handleBreakdown(task) {
  const res = await fetch(BREAKDOWN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }

  const data = await res.json();
  return { subtasks: data.subtasks, title: data.title, details: data.details };
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
