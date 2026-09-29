// api/breakdown.js
// Vercel serverless function. Deploy path: /api/breakdown
// Requires env var OPENAI_API_KEY set in the Vercel project settings.
// test line for git push for first redeploy
// test for v4

export default async function handler(req, res) {
  // CORS: allow the extension to call this endpoint.
  // Chrome extensions send an Origin header like chrome-extension://<id>.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { task } = req.body || {};

  if (!task || typeof task !== 'string') {
    return res.status(400).json({ error: 'Missing "task" string in request body' });
  }

  // Basic abuse guard: cap input length so a single request can't balloon cost.
  if (task.length > 500) {
    return res.status(400).json({ error: 'Task description too long (max 500 characters)' });
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You help a student get started on a task. Given their description, return a JSON object with two fields. ' +
              '"title": a short label of 3-6 words in Title Case that names what the work is. ' +
              'It is a noun phrase describing the task itself, not a restatement of the student\'s wording; leave out deadlines, filler and instructions. ' +
              '"subtasks": an array of 3-6 concrete, sequential steps for STARTING and MAKING PROGRESS on this specific task. ' +
              'Ground every step only in what the student actually wrote. ' +
              'Do not invent specifics they did not mention — no page counts, word counts, sources, formatting rules, section names, or software, unless the student stated them. ' +
              'If the description is short or vague, keep steps general (e.g. "outline your main points") rather than filling in imagined detail. ' +
              'Do not include generic study-habit filler (e.g. "find a quiet place to work", "gather your materials") unless the student\'s own wording points to it. ' +
              'The first step should be the smallest possible action that removes the "where do I even start" barrier. ' +
              'Respond with ONLY the JSON object, no prose, no markdown formatting. ' +
              'Example for "finish my chem lab report on titration, due thursday": ' +
              '{"title": "Titration Lab Report", "subtasks": ["Open the lab report template", "Write the introduction paragraph", "List the materials used"]}. ' +
              'Example for "study for my history test": ' +
              '{"title": "History Test Prep", "subtasks": ["Pick the topic you know least well", "Reread your notes on that topic", "Write 3 questions you think could be on the test", "Answer them without looking at your notes"]}',
          },
          { role: 'user', content: task },
        ],
        response_format: { type: 'json_object' }, // guarantees syntactically valid JSON (object, not array)
        temperature: 0.2, // lower than before: favors grounded, literal steps over creative/inferred ones
        max_tokens: 400,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI API error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'Upstream model request failed' });
    }

    const data = await openaiRes.json();
    const raw = data.choices?.[0]?.message?.content?.trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error('Failed to parse model output as JSON:', raw);
      return res.status(502).json({ error: 'Model returned unparsable output' });
    }

    const subtasks = parsed && parsed.subtasks;
    if (!Array.isArray(subtasks)) {
      return res.status(502).json({ error: 'Model output missing a "subtasks" array' });
    }

    // Title is optional: if it's missing or malformed the client falls back to the user's own text.
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '';

    return res.status(200).json({ title: title || undefined, subtasks });
  } catch (err) {
    console.error('Breakdown endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
