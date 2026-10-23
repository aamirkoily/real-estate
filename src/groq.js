import { HttpError } from './errors.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const MAX_RETRY_WAIT_S = 12; // longer waits fail fast so the app can fall back instead

// Never include the key itself here - this object is sent to the browser.
export function aiConfig() {
  return {
    configured: Boolean(process.env.GROQ_API_KEY),
    model: process.env.GROQ_MODEL || DEFAULT_MODEL,
  };
}

export async function chat({
  messages, json = false, maxTokens = 1500, temperature = 0.4, reasoningEffort = 'low',
}) {
  const { configured, model } = aiConfig();
  if (!configured) {
    throw new HttpError(503, 'AI is not set up: add GROQ_API_KEY to the .env file and restart the server.');
  }

  const body = { model, messages, temperature, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  // gpt-oss models reason before answering; low effort keeps replies fast
  // and saves tokens on the free tier.
  if (model.includes('gpt-oss')) body.reasoning_effort = reasoningEffort;

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new HttpError(504, err.name === 'TimeoutError'
        ? 'The AI took too long to respond. Please try again.'
        : 'Could not reach the AI service. Check your internet connection.');
    }
    // The free tier allows ~8k tokens a minute. If Groq says "retry in a few seconds", wait once.
    const wait = Number(res.headers.get('retry-after'));
    if (res.status !== 429 || attempt > 0 || !(wait > 0 && wait <= MAX_RETRY_WAIT_S)) break;
    console.warn(`Groq rate limit hit, retrying in ${wait}s`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000 + 250));
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`Groq API error ${res.status}: ${detail.slice(0, 500)}`);
    if (res.status === 401) {
      throw new HttpError(503, 'The Groq API key was rejected. Check GROQ_API_KEY in .env.');
    }
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      throw new HttpError(429, `The free AI plan is busy right now. Try again in ${wait ? `${Math.ceil(Number(wait))} seconds` : 'a moment'}.`);
    }
    throw new HttpError(502, `The AI service returned an error (${res.status}). Please try again.`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new HttpError(502, 'The AI returned an empty answer. Please try again.');
  return content;
}

export async function chatJSON(options) {
  const text = await chat({ ...options, json: true });
  try {
    return JSON.parse(text);
  } catch {
    // Some models wrap JSON in prose or code fences; salvage the object if we can.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch { /* fall through */ }
    }
    throw new HttpError(502, 'The AI answer was not in the expected format. Please try again.');
  }
}
