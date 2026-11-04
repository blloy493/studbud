import feedback from './_lib/feedback.js';
import interest from './_lib/interest.js';
import waitlist from './_lib/waitlist.js';

const handlers = { feedback, interest, waitlist };

export default async function handler(req, res) {
  const action = req.query.action;

  // 1. Guard against prototype pollution and unknown actions
  if (!action || !Object.hasOwn(handlers, action)) {
    return res.status(404).json({ error: 'Unknown action' });
  }

  // 2. Safely execute the handler
  const fn = handlers[action];
  return fn(req, res);
}
