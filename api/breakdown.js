// api/breakdown.js
// Vercel serverless function. Deploy path: /api/breakdown
// Requires env var OPENAI_API_KEY set in the Vercel project settings.
//
// v6 (Oct 1 pivot): an assignment is REQUIRED input.
// Request:  { brief: string, answers?: [{ question, answer }], round?: 0-2 }
// Response: { status: 'needs_info', questions: [string] }
//        or { status: 'ready', title, steps: [{ kind, title, detail, ... }] }
// Step kinds: 'do' | 'copy' (+ text) | 'citation' (+ style 'apa7'|'mla9', n).
// Citation formatting is done in the extension (deterministic), never by the model.

const MIN_BRIEF = 40;
const MAX_BRIEF = 8000; // keep in sync with MAX_BRIEF_CHARS in content.js
const MAX_ANSWERS = 6;
const MAX_ANSWER_LEN = 300;
const MAX_ROUND = 2; // max clarification rounds before the model must produce a plan
const MAX_STEPS = 30;

const SYSTEM_PROMPT =
  'You are the planning engine of a student study tool. The student pasted an assignment. ' +
  'Turn it into an ordered sequence of micro-actions that, if followed to the end, produce a completed assignment meeting every requirement in the text. ' +
  'Return ONE JSON object and nothing else (no prose, no markdown).\n\n' +
  'STEP A - SUFFICIENCY CHECK. Decide whether you have enough information to build accurate steps. ' +
  'Typically you need: what the deliverable is; the topic or prompt; the stated requirements (length, number of sources, required sections or rubric criteria); ' +
  'and, if the assignment needs citations, the required citation style. ' +
  'Ask only about missing information that would change the steps. Never ask about anything the text already states. ' +
  'Never ask for preferences or for things the student cannot know. If something is missing, return: ' +
  '{"status":"needs_info","questions":["..."]} with 1-3 short, specific questions, each answerable in a few words.\n\n' +
  'STEP B - PLAN. If you have enough information, return: {"status":"ready","title":"...","steps":[...]}\n' +
  '- "title": 3-6 words, Title Case, names the assignment (no deadlines).\n' +
  '- "steps": 6-30 ordered steps, each one concrete action of roughly 5-25 minutes. The first step is the smallest action that gets the student started. ' +
  'The last step is a final review whose detail lists every requirement from the text as a checklist.\n' +
  '- If the assignment is a list of numbered questions, make one step per question, in order, with no preparatory steps, and start each title with its number (e.g. "Q4: ..."; ' +
  'use the section name too if numbering repeats, e.g. "Multihybrid Q2: ..."). If there are more than 25 questions, group related consecutive ones into one step. Still end with one review step.\n' +
  '- Every step is an object with "kind", "title" (imperative, under 12 words) and "detail" (1-2 sentences saying what the task is actually asking and which method, concept or formula to apply; ' +
  'name the requirement or rubric item it satisfies when the text lists them).\n' +
  '- kind "do": a normal action.\n' +
  '- kind "copy": also has "text", a ready-to-paste scaffold for the student\'s document (for example the required section headings with [bracketed] slots to fill). ' +
  'Plain text, under 600 characters. Use at most 2 per plan, and only when it saves real effort.\n' +
  '- kind "citation": also has "style" ("apa7" or "mla9") and "n" (source number, starting at 1). ' +
  'Use one citation step per source the student must cite, ONLY when the text or answers name APA or MLA as the style. ' +
  'The app collects the source details and formats the citation itself, so do not describe formatting rules in these steps. ' +
  'If the number of sources is not stated, ask in STEP A. For any other citation style, use "do" steps instead.\n\n' +
  'DO NOT DO THE STUDENT\'S WORK. This tool only organizes the assignment and explains what each task asks.\n' +
  '- Never answer, solve, calculate, or write any part of the assignment. Never state a result: no final answers, values, ratios, genotypes, thesis statements, or sample sentences.\n' +
  '- A detail names what is being asked and the approach to take, so a student who knows the material can start. It never contains the outcome of applying that approach.\n' +
  '- If the text contains an answer key, solutions or sample answers, ignore them completely. Never reveal or hint at their content.\n\n' +
  'RULES\n' +
  '- Use only requirements stated in the text or answers. Never invent page counts, word counts, source counts, sections, or grading criteria.\n' +
  '- You may rely on well-established conventions of the subject (standard essay structure, standard lab report sections).\n' +
  '- If you are unsure whether something is standard or set by the instructor, tell the student to confirm it with the assignment instructions.\n' +
  '- No generic study-habit filler.\n\n' +
  'EXAMPLE step for a numbered question ("Brown eyes are dominant to blue. A brown-eyed man whose mother was blue-eyed marries a brown-eyed woman whose father was blue-eyed. What is the probability of a blue-eyed child?"): ' +
  '{"kind":"do","title":"Q4: Find the probability of a blue-eyed child","detail":"Use the family clues to work out each parent\'s genotype, then use their cross to find the chance of a child with two recessive alleles."}\n' +
  'EXAMPLE needs_info: {"status":"needs_info","questions":["Which citation style does the assignment require?","How many sources must you cite?"]}\n' +
  'EXAMPLE ready: {"status":"ready","title":"MLA Annotated Bibliography","steps":[' +
  '{"kind":"do","title":"Open a blank document","detail":"Title it with your name and the assignment so the file is ready for the first source."},' +
  '{"kind":"citation","title":"Add the citation for source 1","detail":"Start with the source you know best.","style":"mla9","n":1},' +
  '{"kind":"do","title":"Write the annotation for source 1","detail":"Summarize the source in 3-4 sentences, as the instructions require, directly below its citation."},' +
  '{"kind":"copy","title":"Copy the final-page layout checklist","detail":"Paste it at the end of your document and tick each line.","text":"[ ] Entries alphabetized\\n[ ] Hanging indent applied\\n[ ] Double-spaced"},' +
  '{"kind":"do","title":"Review against the assignment requirements","detail":"Check: 5 sources, MLA 9 format, one annotation per source."}]}';

function cleanString(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function sanitizeStep(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const title = cleanString(raw.title, 120);
  if (!title) return null;
  const detail = cleanString(raw.detail, 400);

  if (raw.kind === 'copy') {
    const text = cleanString(raw.text, 1200);
    if (text) return { kind: 'copy', title, detail, text };
  }
  if (raw.kind === 'citation' && (raw.style === 'apa7' || raw.style === 'mla9')) {
    const n = Number.isInteger(raw.n) && raw.n > 0 ? raw.n : index + 1;
    return { kind: 'citation', title, detail, style: raw.style, n };
  }
  // Unknown or malformed kinds degrade to a plain action instead of failing the whole plan.
  return { kind: 'do', title, detail };
}

export default async function handler(req, res) {
  // CORS: allow the extension to call this endpoint.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';

  if (brief.length < MIN_BRIEF) {
    return res.status(400).json({ error: 'Paste your assignment instructions (at least a few sentences).' });
  }
  // Basic abuse guard: cap input length so a single request can't balloon cost.
  if (brief.length > MAX_BRIEF) {
    return res.status(400).json({ error: `Assignment text too long (max ${MAX_BRIEF} characters)` });
  }

  const answers = Array.isArray(body.answers)
    ? body.answers
        .slice(0, MAX_ANSWERS)
        .map((a) => ({ question: cleanString(a && a.question, MAX_ANSWER_LEN), answer: cleanString(a && a.answer, MAX_ANSWER_LEN) }))
        .filter((a) => a.question && a.answer)
    : [];
  const round = Number.isInteger(body.round) ? Math.min(Math.max(body.round, 0), MAX_ROUND) : 0;

  let userContent = `ASSIGNMENT TEXT:\n${brief}`;
  if (answers.length > 0) {
    userContent +=
      '\n\nCLARIFYING ANSWERS FROM THE STUDENT:\n' +
      answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n');
  }

  let system = SYSTEM_PROMPT + `\n\nClarification rounds already completed: ${round} of ${MAX_ROUND}.`;
  if (round >= MAX_ROUND) {
    system +=
      ' You must return status "ready" now. Where information is still missing, state your assumption in the relevant step detail.';
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
          { role: 'system', content: system },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' }, // guarantees syntactically valid JSON (object, not array)
        temperature: 0.2, // low: favors grounded, literal steps over creative/inferred ones
        max_tokens: 4000, // up to 30 steps with details
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

    if (parsed && parsed.status === 'needs_info') {
      const questions = Array.isArray(parsed.questions)
        ? parsed.questions.map((q) => cleanString(q, 200)).filter(Boolean).slice(0, 3)
        : [];
      if (round >= MAX_ROUND || questions.length === 0) {
        return res.status(502).json({ error: 'Could not build a plan from the information provided' });
      }
      return res.status(200).json({ status: 'needs_info', questions });
    }

    const steps = Array.isArray(parsed && parsed.steps)
      ? parsed.steps.map(sanitizeStep).filter(Boolean).slice(0, MAX_STEPS)
      : [];
    if (steps.length === 0) {
      return res.status(502).json({ error: 'Model returned no usable steps' });
    }

    // Title is optional: if it's missing or malformed the client falls back to the start of the brief.
    const title = cleanString(parsed.title, 60);
    return res.status(200).json({ status: 'ready', title: title || undefined, steps });
  } catch (err) {
    console.error('Breakdown endpoint error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
