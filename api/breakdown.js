// api/breakdown.js
// Vercel serverless function. Deploy path: /api/breakdown
// Requires env var OPENAI_API_KEY set in the Vercel project settings.

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
              'You break a student\'s task into 3-6 concrete, small, sequential subtasks. ' +
              'Respond with ONLY a JSON array of strings, no prose, no markdown formatting. ' +
              'Example: ["Open the lab report template", "Write the introduction paragraph", "List the materials used"]',
          },
          { role: 'user', content: task },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      console.error('OpenAI API error:', openaiRes.status, errText);
      return res.status(502).json({ error: 'Upstream model request failed' });
    }

    const data = await openaiRes.json();
    const raw = data.choices?.[0]?.message?.content?.trim();

    let subtasks;
    try {
      subtasks = JSON.parse(raw);
    } catch {
      console.error('Failed to parse model output as JSON:', raw);
      return res.status(502).json({ error: 'Model returned unparsable output' });
    }

    if (!Array.isArray(subtasks)) {
      return res.status(502).json({ error: 'Model output was not a JSON array' });
    }

    return res.status(200).json({ subtasks });
  } catch (err) {
    console.error('Breakdown endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
