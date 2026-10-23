import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './src/env.js';
import { HttpError } from './src/errors.js';
import { aiConfig } from './src/groq.js';
import { GOLDEN_VISA_MIN, LOAN, listings } from './src/listings.js';
import { chatAboutHomes, parseQuery, recommend } from './src/recommend.js';
import { searchVocabulary } from './src/search.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
loadEnv(join(ROOT, '.env'));

const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
// Local-only by default: the API spends your Groq quota, so don't expose it to the network.
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 50_000;

// Optional Google Maps browser key. Unlike the Groq key it is meant to be used in the browser,
// so restrict it to your domain in Google Cloud. Without it the app uses keyless map embeds.
function mapsConfig() {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';
  return { key, mapId: process.env.GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID' };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const routes = {
  'GET /api/health': () => ({ ok: true, ai: aiConfig(), maps: mapsConfig() }),
  'GET /api/listings': () => ({
    listings,
    ...searchVocabulary(),
    loan: LOAN,
    goldenVisaMin: GOLDEN_VISA_MIN,
  }),
  'POST /api/recommend': (body) => recommend(body),
  'POST /api/parse': (body) => parseQuery(body.query, body.current),
  'POST /api/chat': (body) => chatAboutHomes(body),
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJSONBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return body;
}

async function serveStatic(res, pathname) {
  let file;
  try {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    file = normalize(join(PUBLIC_DIR, relative));
  } catch {
    file = null;
  }
  if (!file || !file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(400).end('Bad request');
    return;
  }

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(file)] || 'application/octet-stream',
      // Revalidate every time so edits to the frontend show up on a normal refresh.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${pathname}`];

  if (!handler) {
    if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method not allowed' });
    return serveStatic(res, pathname);
  }

  try {
    const body = req.method === 'POST' ? await readJSONBody(req) : {};
    sendJSON(res, 200, await handler(body));
  } catch (err) {
    if (err instanceof HttpError) return sendJSON(res, err.status, { error: err.message });
    console.error(err);
    sendJSON(res, 500, { error: 'Something went wrong on the server.' });
  }
});

server.listen(PORT, HOST, () => {
  const { configured, model } = aiConfig();
  console.log(`HomeMatch AI is running at http://localhost:${PORT}`);
  console.log(configured
    ? `AI model: ${model}`
    : 'Warning: GROQ_API_KEY is not set, so AI features are off. Copy .env.example to .env and add your key.');
  console.log(mapsConfig().key
    ? 'Google Maps: interactive map enabled'
    : 'Google Maps: using keyless embeds (set GOOGLE_MAPS_API_KEY for the interactive results map)');
});
