import { chat, chatJSON } from './groq.js';
import { HttpError } from './errors.js';
import {
  CITIES, FEATURES, LOAN, PRIORITIES, TYPES, compactListing, listings, listingsById,
} from './listings.js';

const SHORTLIST_SIZE = 8; // homes sent to the AI
const RESULT_COUNT = 6; // homes shown to the user
const MIN_RESULTS = 3; // ...but never fewer than this
const MIN_MATCH_SCORE = 35; // AI matches below this are hidden
const CHAT_CONTEXT_SIZE = 6;
const CHAT_HISTORY_SIZE = 8;

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const average = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;
const joinList = (items) => (items.length < 3
  ? items.join(' and ')
  : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const withArticle = (noun) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun.toLowerCase()}`;

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const cleanList = (value, maxItems, maxLen = 120) => (Array.isArray(value)
  ? value.map((v) => cleanText(v, maxLen)).filter(Boolean).slice(0, maxItems)
  : []);

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

// Case-insensitive match of user/AI-supplied values onto our canonical vocabulary.
function pickAllowed(values, allowed) {
  if (!Array.isArray(values)) return [];
  const lookup = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  return [...new Set(values.map((v) => lookup.get(String(v).trim().toLowerCase())).filter(Boolean))];
}

function positive(value, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

export function sanitizePrefs(input = {}) {
  const prefs = input && typeof input === 'object' ? input : {};
  const cityName = String(prefs.city ?? '').split(',')[0].trim().toLowerCase();

  let minPrice = positive(prefs.minPrice, 100_000_000);
  let maxPrice = positive(prefs.maxPrice, 100_000_000);
  if (minPrice && maxPrice && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];

  return {
    city: CITIES.find((c) => c.city.toLowerCase() === cityName)?.city ?? '',
    minPrice,
    maxPrice,
    types: pickAllowed(prefs.types, TYPES),
    minBeds: Math.round(positive(prefs.minBeds, 10)),
    minBaths: positive(prefs.minBaths, 10),
    mustHaves: pickAllowed(prefs.mustHaves, FEATURES),
    priorities: pickAllowed(prefs.priorities, Object.keys(PRIORITIES)),
    notes: cleanText(prefs.notes, 400),
  };
}

export function describePrefs(p) {
  let budget = 'no limit';
  if (p.minPrice && p.maxPrice) budget = `${usd(p.minPrice)} to ${usd(p.maxPrice)}`;
  else if (p.maxPrice) budget = `up to ${usd(p.maxPrice)}`;
  else if (p.minPrice) budget = `at least ${usd(p.minPrice)}`;

  return [
    `- City: ${p.city || 'any'}`,
    `- Budget: ${budget}`,
    `- Property type: ${p.types.join(', ') || 'any'}`,
    `- Bedrooms: ${p.minBeds ? `${p.minBeds}+` : 'any'}; bathrooms: ${p.minBaths ? `${p.minBaths}+` : 'any'}`,
    `- Must-haves: ${p.mustHaves.join(', ') || 'none'}`,
    `- Priorities: ${p.priorities.map((k) => PRIORITIES[k]).join(', ') || 'none'}`,
    `- Notes: ${p.notes || 'none'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule-based scoring (fast pre-filter, and the fallback when AI is unavailable)
// ---------------------------------------------------------------------------

const medianPricePerSqft = (() => {
  const byCity = {};
  for (const l of listings) (byCity[l.city] ??= []).push(l.price / l.sqft);
  return Object.fromEntries(Object.entries(byCity).map(([city, values]) => {
    const sorted = values.sort((a, b) => a - b);
    return [city, sorted[Math.floor(sorted.length / 2)]];
  }));
})();

// Each priority maps a listing to 0..1 (1 = great), plus phrases for pros/cons.
const priorityRules = {
  schools: {
    score: (l) => l.schoolRating / 10,
    pro: (l) => `Strong schools (${l.schoolRating}/10)`,
    con: (l) => `Schools rated ${l.schoolRating}/10`,
  },
  walkability: {
    score: (l) => l.walkScore / 100,
    pro: (l) => `Very walkable (Walk Score ${l.walkScore})`,
    con: (l) => `Car-dependent (Walk Score ${l.walkScore})`,
  },
  commute: {
    score: (l) => clamp01(1 - (l.commuteMinutes - 5) / 40),
    pro: (l) => `Only ${l.commuteMinutes} min to downtown`,
    con: (l) => `${l.commuteMinutes} min commute to downtown`,
  },
  space: {
    score: (l) => clamp01(l.sqft / 3000),
    pro: (l) => `Roomy at ${l.sqft.toLocaleString('en-US')} sqft`,
    con: (l) => `Compact at ${l.sqft.toLocaleString('en-US')} sqft`,
  },
  value: {
    score: (l) => {
      const median = medianPricePerSqft[l.city];
      return clamp01(0.5 + ((median - l.price / l.sqft) / median) * 1.5);
    },
    pro: (l) => `Good value at ${usd(l.price / l.sqft)}/sqft`,
    con: (l) => `Pricey for the area (${usd(l.price / l.sqft)}/sqft)`,
  },
  newer: {
    score: (l) => clamp01((l.yearBuilt - 1960) / 60),
    pro: (l) => `Newer build (${l.yearBuilt})`,
    con: (l) => `Older home (built ${l.yearBuilt})`,
  },
};

function scoreListing(l, p) {
  const pros = [];
  const cons = [];
  let score = 0;

  // Budget: 30 points
  if (p.maxPrice && l.price > p.maxPrice) {
    const over = (l.price - p.maxPrice) / p.maxPrice;
    score += Math.max(0, 30 - over * 200);
    cons.push(`${Math.max(1, Math.round(over * 100))}% over your max budget`);
  } else {
    score += p.minPrice && l.price < p.minPrice ? 24 : 30;
    if (p.maxPrice) pros.push('Within your budget');
  }

  // Bedrooms: 15 points, bathrooms: 5 points
  if (l.beds >= p.minBeds) {
    score += 15;
  } else {
    const short = p.minBeds - l.beds;
    score += short === 1 ? 5 : 0;
    cons.push(`${short} fewer bedroom${short > 1 ? 's' : ''} than you want`);
  }
  if (l.baths >= p.minBaths) score += 5;
  else cons.push('Fewer bathrooms than you want');

  // Property type: 10 points
  if (!p.types.length || p.types.includes(l.type)) score += 10;
  else cons.push(`It's ${withArticle(l.type)}, not ${withArticle(p.types.join(' or '))}`);

  // Must-haves: 20 points
  if (p.mustHaves.length) {
    const has = p.mustHaves.filter((f) => l.features.includes(f));
    const missing = p.mustHaves.filter((f) => !l.features.includes(f));
    score += (20 * has.length) / p.mustHaves.length;
    if (has.length) pros.push(`Has ${joinList(has).toLowerCase()}`);
    if (missing.length) cons.push(`No ${joinList(missing).toLowerCase()}`);
  } else {
    score += 20;
  }

  // Priorities: 20 points
  if (p.priorities.length) {
    const values = p.priorities.map((k) => priorityRules[k].score(l));
    score += 20 * average(values);
    p.priorities.forEach((k, i) => {
      if (values[i] >= 0.75) pros.push(priorityRules[k].pro(l));
      else if (values[i] < 0.35) cons.push(priorityRules[k].con(l));
    });
  } else {
    score += 12;
  }

  if (l.hoa >= 400) cons.push(`High HOA (${usd(l.hoa)}/mo)`);

  return { score: Math.round(score), pros: pros.slice(0, 3), cons: cons.slice(0, 2) };
}

export function rankListings(prefs) {
  const pool = prefs.city ? listings.filter((l) => l.city === prefs.city) : listings;
  return pool
    .map((listing) => ({ listing, ...scoreListing(listing, prefs) }))
    .sort((a, b) => b.score - a.score);
}

function ruleSummary(prefs, results) {
  if (!results.length) return 'No homes matched. Try another city or loosen your filters.';
  const where = prefs.city ? ` in ${prefs.city}` : '';
  const top = results[0];
  if (top.matchScore < 60) {
    return `Nothing${where} ticks every box, so these are the closest options. Try raising your budget or dropping a must-have.`;
  }
  return `Found ${results.length} homes${where} that fit your criteria. Top pick: ${top.listing.title}.`;
}

// ---------------------------------------------------------------------------
// AI features
// ---------------------------------------------------------------------------

const ADVISOR_PROMPT = `You are HomeMatch AI, a friendly and honest real estate advisor.
You rank candidate homes for a buyer and explain the fit in plain, specific language.
Rules:
- Use only the facts given for each home. Never invent features, prices or numbers.
- Be candid about real trade-offs for this buyer, but never manufacture one. An empty cons list is fine.
- Respond with JSON only.`;

// Accepts {"recommendations": [...]}, a bare array, or the first array-valued key.
function findRecommendations(ai) {
  if (Array.isArray(ai)) return ai;
  if (Array.isArray(ai?.recommendations)) return ai.recommendations;
  return Object.values(ai ?? {}).find(Array.isArray) ?? [];
}

export async function recommend(rawPrefs) {
  const prefs = sanitizePrefs(rawPrefs);
  const shortlist = rankListings(prefs).slice(0, SHORTLIST_SIZE);
  const fallback = shortlist.slice(0, RESULT_COUNT).map((s) => ({
    listing: s.listing, matchScore: s.score, headline: '', pros: s.pros, cons: s.cons,
  }));

  if (!shortlist.length) {
    return { prefs, source: 'rules', summary: ruleSummary(prefs, []), results: [] };
  }

  const count = Math.min(RESULT_COUNT, shortlist.length);
  const userPrompt = `Buyer preferences:
${describePrefs(prefs)}

Candidate homes:
${shortlist.map((s) => compactListing(s.listing)).join('\n')}

Pick the best ${count} homes for this buyer, best first.
- matchScore is your own 0-100 judgment of overall fit: budget, size and type first, then must-haves, priorities and the buyer's notes. Going over budget, the wrong property type, too few bedrooms or a missing must-have should each cost real points.
- Pros and cons must explain fit for THIS buyer (e.g. "9/10 schools, a top priority for you"). Don't just restate beds, baths or square footage - the card already shows them.
- Cons are only things that work against what the buyer asked for (over budget, missing must-have, weak on a priority, high HOA, conflicts with their notes). Never list a missing feature they didn't ask for.
Return JSON in exactly this shape:
{"summary":"2-3 sentences: what you found and the main trade-off","recommendations":[{"id":"home id from the brackets","matchScore":0-100,"headline":"max 12 words on why it fits this buyer","pros":["up to 3 short points"],"cons":["up to 2 short points"]}]}`;

  try {
    const ai = await chatJSON({
      messages: [
        { role: 'system', content: ADVISOR_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 2500,
      temperature: 0.3,
    });

    const byId = new Map(shortlist.map((s) => [s.listing.id, s]));
    const results = [];
    for (const rec of findRecommendations(ai)) {
      // Models sometimes echo the brackets from the prompt, e.g. "[aus-01]".
      const id = String(rec?.id ?? rec?.homeId ?? '').replace(/[[\]\s]/g, '');
      const match = byId.get(id);
      if (!match) continue; // ignore unknown or duplicate ids
      byId.delete(id);

      const score = Number(rec.matchScore);
      const pros = cleanList(rec.pros, 3);
      const cons = cleanList(rec.cons, 2);
      results.push({
        listing: match.listing,
        matchScore: Number.isFinite(score) ? Math.round(Math.min(100, Math.max(0, score))) : match.score,
        headline: cleanText(rec.headline, 140),
        pros: pros.length ? pros : match.pros,
        cons: cons.length ? cons : match.cons,
      });
      if (results.length === count) break;
    }
    if (!results.length) {
      console.warn(`Unusable AI ranking response: ${JSON.stringify(ai).slice(0, 800)}`);
      throw new HttpError(502, 'The AI did not return usable recommendations.');
    }
    results.sort((a, b) => b.matchScore - a.matchScore); // stable, so ties keep the AI's order
    // Hide very weak matches, but always show a few options.
    const strong = results.filter((r) => r.matchScore >= MIN_MATCH_SCORE);

    return {
      prefs,
      source: 'ai',
      summary: cleanText(ai.summary, 700),
      results: strong.length >= MIN_RESULTS ? strong : results.slice(0, MIN_RESULTS),
    };
  } catch (err) {
    console.warn(`AI ranking failed, using rule-based results: ${err.message}`);
    return {
      prefs,
      source: 'rules',
      summary: ruleSummary(prefs, fallback),
      warning: err instanceof HttpError ? err.message : 'AI ranking failed.',
      results: fallback,
    };
  }
}

// Turns "3 bed house in Austin under 600k with a yard" into structured filters.
export async function parseQuery(query) {
  const text = cleanText(query, 500);
  if (!text) throw new HttpError(400, 'Describe the home you are looking for first.');

  const ai = await chatJSON({
    messages: [
      { role: 'system', content: 'You convert a home buyer\'s request into search filters. Respond with JSON only.' },
      {
        role: 'user',
        content: `Request: "${text}"

Allowed values:
- city: one of ${CITIES.map((c) => c.city).join(', ')}, or "" if none is mentioned
- types: any of ${TYPES.join(', ')}
- mustHaves: any of ${FEATURES.join(', ')} (map synonyms, e.g. "yard" -> "Backyard", "dog" or "cat" -> "Pet friendly", "work from home" -> "Home office", "lake" -> "Waterfront")
- priorities: any of ${Object.keys(PRIORITIES).join(', ')} (e.g. "good schools" -> schools, "walk to cafes" -> walkability, "close to work" -> commute, "cheap" or "good deal" -> value, "big" -> space, "new" -> newer)

Return JSON: {"city":"","minPrice":0,"maxPrice":0,"types":[],"minBeds":0,"minBaths":0,"mustHaves":[],"priorities":[],"notes":"other wishes not captured above, as a short phrase, else empty","unsupportedCity":"a city they asked for that is NOT in the allowed list, else empty"}
Use 0 for unknown numbers. "$600k" means 600000 and "1.2M" means 1200000. "Under X" sets only maxPrice.`,
      },
    ],
    maxTokens: 1000,
    temperature: 0,
  });

  return { prefs: sanitizePrefs(ai), unsupportedCity: cleanText(ai.unsupportedCity, 60) };
}

export async function chatAboutHomes({ messages, listingIds, prefs } = {}) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-CHAT_HISTORY_SIZE)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (history.at(-1)?.role !== 'user') throw new HttpError(400, 'Type a question first.');

  const homes = (Array.isArray(listingIds) ? listingIds : [])
    .map((id) => listingsById.get(id))
    .filter(Boolean)
    .slice(0, CHAT_CONTEXT_SIZE);

  const system = `You are HomeMatch AI, a friendly, knowledgeable real estate assistant inside a home recommendation app.

Homes the buyer is looking at right now:
${homes.length ? homes.map(compactListing).join('\n') : '(none yet - suggest they run a search)'}

Buyer preferences:
${describePrefs(sanitizePrefs(prefs))}

Guidelines:
- Keep answers under 120 words unless the buyer asks for more detail. Lead with the answer, then at most 4 short "- " bullet points. No tables, no headings, and don't repeat facts the buyer can already see on the listing cards.
- Refer to homes by their title, never by the id in brackets.
- Only state facts that appear above. If something is unknown (flood risk, exact taxes, condition), say so and suggest how to find out.
- You can compare homes, explain trade-offs and suggest questions for a viewing.
- For monthly cost, use the "est. $X/mo total" figure given for each home (mortgage at ${LOAN.downPayment * 100}% down, ${LOAN.annualRate * 100}% ${LOAN.years}-year fixed, plus HOA; excludes taxes and insurance). Don't calculate your own.
- You are not a licensed financial or legal advisor; for mortgages, contracts or taxes, suggest confirming with a professional.
- If asked about something unrelated to homes or real estate, briefly steer back.`;

  const reply = await chat({
    messages: [{ role: 'system', content: system }, ...history],
    maxTokens: 1500,
    temperature: 0.5,
  });
  return { reply };
}
