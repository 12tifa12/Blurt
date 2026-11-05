// Blurt server: serves the app from blurt/ and sorts what you said with AI.
// Run with `npm start`. Sorting uses Claude when ANTHROPIC_API_KEY is set, or Google's free
// Gemini tier when only GEMINI_API_KEY is set (see .env.example).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'blurt');
const PORT = Number(process.env.PORT) || 5181;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const MAX_TEXT = 2000;

const client = new Anthropic();
const provider = () => process.env.ANTHROPIC_API_KEY ? 'claude' : process.env.GEMINI_API_KEY ? 'gemini' : null;

// ---------- What Claude is asked to do ----------
const SYSTEM = `You sort a voice note into a personal organizer. People speak quickly and casually, often several things in one breath. Split what they said into separate parts and file each one.

The transcript comes from the phone's speech recognition, so it can contain mishearings: words that sound alike ("by eggs" for "buy eggs", "for" or "to" for the numbers 4 and 2, "remind me too"), missing punctuation and run-on sentences. Work out what the speaker meant and use the corrected words in titles. Quotes stay exactly as transcribed.

Categories:
- cal: something that happens at a time or on a day: appointments, meetings, plans, events. Always has a date.
- rem: a nudge to do something at a moment: "remind me to…", "in 20 minutes…". The time is optional.
- task: a to-do with no specific time.
- shop: things to buy. Each product is its own item ("eggs and milk" is two items), and the item text is the amount if one was said, then the product ("2 liters milk", "eggs").
- note: ideas, thoughts and information to keep, such as workouts, quotes or facts.

For each part:
- quote: the exact words from the transcript this part came from, in order. Together the quotes cover the whole transcript.
- text: a short, clean title in the speaker's language, first letter capitalized. Leave out the date and time words and filler like "I need to" or "remind me to".
- datetime: local time as "YYYY-MM-DDTHH:MM", worked out from the current date and time you are given. Weekdays mean the next one coming, which is today if today is that weekday and the time hasn't passed yet. A day with no time is "YYYY-MM-DDT00:00" with all_day true. "Tonight" with no time is 20:00. Relative times ("in 20 minutes") are added to the current time. A reminder with a day but no time goes off at 09:00. Use null when there is no date or time, with all_day false.
- Hours said without am or pm: 8 to 11 are morning, 12 is noon, 1 to 7 are afternoon or evening.

If there is nothing to file, return an empty list of segments.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['segments'],
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['quote', 'category', 'items'],
        properties: {
          quote: { type: 'string' },
          category: { type: 'string', enum: ['cal', 'rem', 'task', 'shop', 'note'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'datetime', 'all_day'],
              properties: {
                text: { type: 'string' },
                datetime: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                all_day: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};

const prompt = (text, now) => `Current date and time: ${now}\n\nTranscript:\n"""${text}"""`;

async function sortWithClaude(text, now) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // Sorting is quick work: low effort keeps it fast
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt(text, now) }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { status: 422 });
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('No text in response');
  return JSON.parse(block.text);
}

// Free for testing: Google's Gemini free tier. Google may use free-tier prompts to improve its
// products, so this is for trying Blurt out, not for real users' data.
class GeminiError extends Error {}

async function callGemini(text, now, withSchema) {
  const generationConfig = { responseMimeType: 'application/json', temperature: 0 };
  if (withSchema) generationConfig.responseJsonSchema = SCHEMA;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM + (withSchema ? '' : `\n\nReply with JSON only, matching this JSON schema:\n${JSON.stringify(SCHEMA)}`) }] },
      contents: [{ role: 'user', parts: [{ text: prompt(text, now) }] }],
      generationConfig,
    }),
  }).catch(() => { throw Object.assign(new GeminiError('Could not reach Gemini'), { status: 502 }); });
  if (!res.ok) {
    const detail = await res.text();
    throw Object.assign(new GeminiError(`Gemini ${res.status}: ${detail.slice(0, 300)}`), { status: res.status });
  }
  const data = await res.json();
  const out = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('');
  if (!out) throw Object.assign(new GeminiError('No text from Gemini'), { status: 422 });
  const result = JSON.parse(out);
  if (!Array.isArray(result?.segments)) throw new GeminiError('Gemini returned the wrong shape');
  return result;
}

async function sortWithGemini(text, now) {
  try { return await callGemini(text, now, true); }
  catch (e) {
    // If this model won't take the schema, ask for the same JSON in the prompt instead
    if (e.status === 400 && /schema/i.test(e.message)) return callGemini(text, now, false);
    throw e;
  }
}

const sort = (text, now) => provider() === 'claude' ? sortWithClaude(text, now) : sortWithGemini(text, now);

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error('Too large'), { status: 413 });
  }
  return JSON.parse(raw);
}

// ---------- Who may spend the AI budget ----------
// Each tester gets a link with their own code (/?code=...). Without a code the app uses its built-in sorter.
const INVITES = new Set((process.env.INVITE_CODES || '').split(',').map(s => s.trim()).filter(Boolean));
const PER_INVITE_PER_DAY = Number(process.env.SORTS_PER_INVITE_PER_DAY) || 30;
const TOTAL_PER_DAY = Number(process.env.SORTS_PER_DAY) || 300;
const usage = { day: '', total: 0, byInvite: new Map() };

// Running on your own computer needs no code. A hosted server always sits behind a proxy, which adds this header.
const isLocal = req => !req.headers['x-forwarded-for'] && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function whoIs(req) {
  if (isLocal(req)) return 'local';
  const code = req.headers['x-blurt-invite'];
  return typeof code === 'string' && INVITES.has(code) ? code : null;
}

// Counts live in memory, so they start over when the server restarts
function underLimits(who) {
  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) Object.assign(usage, { day: today, total: 0, byInvite: new Map() });
  const used = usage.byInvite.get(who) || 0;
  if (usage.total >= TOTAL_PER_DAY || used >= PER_INVITE_PER_DAY) return false;
  usage.total++;
  usage.byInvite.set(who, used + 1);
  return true;
}

async function handleSort(req, res) {
  if (!provider()) return send(res, 503, { error: 'AI not set up' });
  const who = whoIs(req);
  if (!who) return send(res, 401, { error: 'Invite needed for AI sorting' });
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: 'Send JSON with text and now.' }); }
  const { text, now } = body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || typeof now !== 'string' || now.length > 100) {
    return send(res, 400, { error: 'Send JSON with text and now.' });
  }
  if (!underLimits(who)) {
    console.log(`daily limit reached (${who}, ${usage.total} total today)`);
    return send(res, 429, { error: 'Daily limit reached' });
  }
  try {
    const started = Date.now();
    const result = await sort(text.trim(), now);
    console.log(`${who}: ${provider()} sorted in ${Date.now() - started} ms: ${result.segments.length} parts`);
    send(res, 200, result);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.');
      return send(res, 503, { error: 'AI not set up' });
    }
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Too many requests, try again shortly' });
    if (e instanceof Anthropic.APIConnectionError) return send(res, 502, { error: 'Could not reach Claude' });
    if (e instanceof Anthropic.APIError) { console.error('Claude API error:', e.status, e.message); return send(res, 502, { error: 'AI error' }); }
    if (e instanceof GeminiError) {
      console.error(e.message);
      if ([400, 401, 403, 404].includes(e.status)) return send(res, 503, { error: 'AI not set up' });
      if (e.status === 429) return send(res, 429, { error: 'Too many requests, try again shortly' });
      return send(res, 502, { error: 'AI error' });
    }
    if (e instanceof SyntaxError) { console.error('AI sent back invalid JSON'); return send(res, 502, { error: 'AI error' }); }
    if (e.status === 422) return send(res, 422, { error: 'Could not sort that' });
    console.error(e);
    send(res, 500, { error: 'Sorting failed' });
  }
}

async function handleStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    send(res, 200, await fs.readFile(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

http.createServer((req, res) => {
  if (req.url === '/api/sort' && req.method === 'POST') return handleSort(req, res);
  if (req.method === 'GET') return handleStatic(req, res);
  send(res, 405, 'Method not allowed', 'text/plain');
}).listen(PORT, () => {
  console.log(`Blurt running on http://localhost:${PORT}`);
  const p = provider();
  if (p === 'claude') console.log(`Sorting with Claude (${MODEL})`);
  else if (p === 'gemini') console.log(`Sorting with Gemini's free tier (${GEMINI_MODEL}), for testing only`);
  else console.log('No AI key yet: the app will use its built-in sorter. See .env.example.');
  if (p && !INVITES.size) console.log('No INVITE_CODES set: AI sorting only answers on this computer.');
});
