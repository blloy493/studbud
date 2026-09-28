// background.js
// Service worker (Manifest V3). Handles all outbound network calls so the
// content script never touches the API directly.

const BREAKDOWN_ENDPOINT = 'https://studbud-two.vercel.app/api/breakdown';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'BREAKDOWN_TASK') {
    return false; // not for us, let other listeners handle it
  }

  handleBreakdown(message.task)
    .then(({ subtasks, title }) => sendResponse({ ok: true, subtasks, title }))
    .catch((err) => {
      console.error('Breakdown request failed:', err);
      sendResponse({ ok: false, error: err.message });
    });

  // Required: tells Chrome the response is async, keeps the message
  // channel open until sendResponse is actually called above.
  return true;
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
  return { subtasks: data.subtasks, title: data.title };
}
