// api/breakdown.js
// Vercel serverless function. Deploy path: /api/breakdown
// Requires env var OPENAI_API_KEY set in the Vercel project settings.
//
// v5 changes:
// - Prompt goal: finish the task, not just start it
// - New "details" array (parallel to "subtasks") with HOW-to text per step
// - Input cap 500 -> 8000 (students can paste a full assignment brief / rubric)
// - max_tokens 400 -> 1600 (details + up to 12 steps need room)
// - Server-side validation keeps subtasks/details aligned

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
  // Raised from 500 so students can paste a full assignment brief (~2k tokens at the cap).
  if (task.length > 8000) {
    return res.status(400).json({ error: 'Task description too long (max 8000 characters)' });
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
              'You help a student complete a task from start to finish. Given their description, return a JSON object with three fields. ' +
              '"title": a short label of 3-6 words in Title Case that names what the work is. ' +
              'It is a noun phrase describing the task itself, not a restatement of the student\'s wording; leave out deadlines, filler and instructions. ' +
              '"subtasks": an array of 4-8 short imperative steps (under 12 words each) that, followed in order, take the student from not started to finished work. ' +
              'If the student provides a full assignment brief, use up to 12 steps. ' +
              'Each step must be one concrete action completable in roughly 5-25 minutes; split anything bigger. ' +
              '"details": an array with the same length and order as "subtasks". Each entry is 1-2 sentences explaining HOW to do that step, so the student does not need to look anything up. ' +
              'When a step depends on a rule, pattern or format, state it in the detail (e.g. the citation pattern for a book). ' +
              'GROUNDING RULES: ' +
              'You may use well-established, widely agreed conventions of the subject (e.g. standard MLA or APA rules, standard lab report sections). ' +
              'Never invent assignment-specific requirements the student did not state: no page counts, word counts, number of sources, required sections, or grading criteria. ' +
              'If a requirement is set by the instructor and the student did not state it (length, number of sources, annotation type, required sections), make an early step such as "Check your assignment instructions for X, Y, Z" and list in the detail what to look for. ' +
              'Do not add that step if the task has no instructor-set parameters. ' +
              'If you are not sure whether something is a standard convention or varies by instructor, write "confirm with your assignment instructions" instead of asserting it. ' +
              'ASSIGNMENT BRIEFS: if the student pastes a full assignment brief, rubric or list of requirements, extract its requirements and build the steps so that completing every step satisfies them. ' +
              'In each step\'s detail, name the requirement it covers (e.g. "Rubric: thesis, 20%"). ' +
              'Make the last step a final review whose detail lists every requirement from the brief as a checklist. ' +
              'Use the brief\'s own wording and numbers; never add requirements the brief does not contain, and do not copy the brief at length. ' +
              'The first step should be the smallest possible action that removes the "where do I even start" barrier. ' +
              'The last step should be a short final review of the finished work. ' +
              'Do not include generic study-habit filler (e.g. "find a quiet place to work") unless the student\'s own wording points to it. ' +
              'Respond with ONLY the JSON object, no prose, no markdown formatting. ' +
              'Example for "how do I format my MLA annotated bibliography": ' +
              '{"title": "MLA Annotated Bibliography", "subtasks": [' +
              '"Check your assignment instructions", ' +
              '"List your sources with author, title, publisher, date", ' +
              '"Write each citation in MLA format", ' +
              '"Alphabetize the citations", ' +
              '"Write an annotation under each citation", ' +
              '"Apply the page layout", ' +
              '"Review against your instructions"], ' +
              '"details": [' +
              '"Note the number of sources, annotation length, and annotation type (summary, evaluation, or both).", ' +
              '"Collect these details for each source in a scratch list so citing is quick.", ' +
              '"Book pattern: Author Last, First. Title. Publisher, Year. Use your list from the previous step.", ' +
              '"Order by the first word of each entry, ignoring A, An and The.", ' +
              '"Place each annotation directly after its citation, in the type and length your instructions ask for.", ' +
              '"Double-space everything and use a hanging indent on citations. Confirm annotation indentation with your instructions.", ' +
              '"Check every requirement from your instructions against the finished document."]}. ' +
              'Example for "study for my history test": ' +
              '{"title": "History Test Prep", "subtasks": ["Pick the topic you know least well", "Reread your notes on that topic", "Write 3 questions that could be on the test", "Answer them without looking at your notes"], ' +
              '"details": ["Skim your notes headings and choose the one you could explain worst.", "Read only that section and underline key dates, people and causes.", "Turn each underlined idea into a question starting with Why or How.", "Check your answers against your notes and mark any you missed for another pass."]}',
          },
          { role: 'user', content: task },
        ],
        response_format: { type: 'json_object' }, // guarantees syntactically valid JSON (object, not array)
        temperature: 0.2, // low: favors grounded, literal steps over creative/inferred ones
        max_tokens: 1600, // raised from 400: details and up to 12 steps need room
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

    const rawSubtasks = parsed && parsed.subtasks;
    if (!Array.isArray(rawSubtasks)) {
      return res.status(502).json({ error: 'Model output missing a "subtasks" array' });
    }

    // Pair each step with its detail BEFORE filtering so the two arrays stay aligned.
    const rawDetails = Array.isArray(parsed.details) ? parsed.details : [];
    const steps = rawSubtasks
      .map((s, i) => ({ step: s, detail: rawDetails[i] }))
      .filter((x) => typeof x.step === 'string' && x.step.trim());

    if (steps.length === 0) {
      return res.status(502).json({ error: 'Model returned no usable steps' });
    }

    const subtasks = steps.map((x) => x.step.trim());
    // Missing or malformed detail becomes an empty string; the client should hide the detail line when empty.
    const details = steps.map((x) => (typeof x.detail === 'string' ? x.detail.trim() : ''));

    // Title is optional: if it's missing or malformed the client falls back to the user's own text.
    const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 60) : '';

    return res.status(200).json({ title: title || undefined, subtasks, details });
  } catch (err) {
    console.error('Breakdown endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
