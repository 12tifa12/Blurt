// Blurt server: serves the app from blurt/ and sorts what you said with Claude.
// Run with `npm start`. Needs ANTHROPIC_API_KEY in .env (see .env.example).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, 'blurt');
const PORT = Number(process.env.PORT) || 5181;
const MODEL = 'claude-opus-5-5';
const MAX_TEXT = 2000;

const client = new Anthropic();

// ---------- What Claude is asked to do ----------
const SYSTEM = `You sort a voice note into a personal organizer. People speak quickly and casually, often several things in one breath. Split what they said into separate parts and file each one.

Categories:
- cal: something that happens at a time or on a day: appointments, meetings, plans, events. Always has a date.
- rem: a nudge to do something at a moment: "remind me to…", "in 20 minutes…". The time is optional.
- task: a to-do with no specific time.
- shop: things to buy. Each product is its own item ("eggs and milk" is two items), and the item text is just the product.
- note: ideas, thoughts and information to keep, such as workouts, quotes or facts.

For each part:
- quote: the exact words from the transcript this part came from, in order. Together the quotes cover the whole transcript.
- text: a short, clean title in the speaker's language, first letter capitalized. Leave out the date and time words and filler like "I need to" or "remind me to".
- datetime: local time as "YYYY-MM-DDTHH:MM", worked out from the current date and time you are given. Weekdays mean the next one coming. A day with no time is "YYYY-MM-DDT00:00" with all_day true. "Tonight" with no time is 20:00. Relative times ("in 20 minutes") are added to the current time. A reminder with a day but no time goes off at 09:00. Use null when there is no date or time, with all_day false.
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

async function sort(text, now) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    // If a safety classifier declines, the API retries on Anthropic's recommended fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    // Sorting is quick work: low effort keeps it fast
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Current date and time: ${now}\n\nTranscript:\n"""${text}"""` }],
  });
  if (response.stop_reason === 'refusal') throw Object.assign(new Error('refused'), { status: 422 });
  const block = response.content.find(b => b.type === 'text');
  if (!block) throw new Error('No text in response');
  return JSON.parse(block.text);
}

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

async function handleSort(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'AI not set up' });
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, e.status || 400, { error: 'Send JSON with text and now.' }); }
  const { text, now } = body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || typeof now !== 'string' || now.length > 100) {
    return send(res, 400, { error: 'Send JSON with text and now.' });
  }
  try {
    const started = Date.now();
    const result = await sort(text.trim(), now);
    console.log(`sorted in ${Date.now() - started} ms: ${result.segments.length} parts`);
    send(res, 200, result);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('Claude rejected the API key. Check ANTHROPIC_API_KEY in .env.');
      return send(res, 503, { error: 'AI not set up' });
    }
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Too many requests, try again shortly' });
    if (e instanceof Anthropic.APIConnectionError) return send(res, 502, { error: 'Could not reach Claude' });
    if (e instanceof Anthropic.APIError) { console.error('Claude API error:', e.status, e.message); return send(res, 502, { error: 'AI error' }); }
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
  if (!process.env.ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY yet: the app will use its built-in sorter. See .env.example.');
});
