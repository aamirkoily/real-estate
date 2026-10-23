// AI layer: understands requests, re-ranks the search engine's best matches and powers the chat.
// Everything degrades gracefully: if the AI is busy, keyword parsing and rule-based ranking take over.
import { chat, chatJSON } from './groq.js';
import { HttpError } from './errors.js';
import {
  COMMUNITIES, FEATURES, GOLDEN_VISA_MIN, LANDMARKS, LOAN, PRIORITIES, REGIONS, TYPES,
  aed, compactListing, landmarksById, listingsById,
} from './listings.js';
import {
  describePrefs, interpretPrefs, quickParse, sanitizePrefs, searchHomes,
} from './search.js';

const AI_SHORTLIST = 8; // best rule-based matches sent to the AI
const TOP_PICKS = 6; // explained by the AI
const MORE_RESULTS = 18; // extra matches listed below the top picks
const CHAT_CONTEXT_SIZE = 6;
const CHAT_HISTORY_SIZE = 8;

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const cleanList = (value, maxItems, maxLen = 120) => (Array.isArray(value)
  ? value.map((v) => cleanText(v, maxLen)).filter(Boolean).slice(0, maxItems)
  : []);

// Small in-memory caches so repeated searches don't spend the free-tier token budget.
function lruCache(limit) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
  };
}
const parseCache = lruCache(200);
const rankCache = lruCache(200);

// ---------------------------------------------------------------------------
// Understanding the request
// ---------------------------------------------------------------------------

const VOCABULARY = `Communities (with region): ${COMMUNITIES.map((c) => `${c.name} [${c.region}${c.freehold ? '' : ', nationals only'}]`).join('; ')}.
Regions: ${REGIONS.join(', ')}.
Landmarks for "near": ${LANDMARKS.map((l) => `${l.id} = ${l.name}`).join('; ')}.
Types: ${TYPES.join(', ')}.
Features: ${FEATURES.join(', ')}.
Priorities: ${Object.keys(PRIORITIES).join(', ')}.`;

const PARSE_RULES = `Return JSON with exactly these keys:
{"mode":"new|refine","communities":[],"regions":[],"near":null or {"landmark":"landmark id","maxKm":10},"minPrice":0,"maxPrice":0,"budgetStrict":false,"types":[],"minBeds":0,"maxBeds":null,"minBaths":0,"minSqft":0,"completion":"ready|offplan|","freeholdOnly":false,"mustHaves":[],"niceToHaves":[],"priorities":[],"purpose":"live|invest|","notes":"","interpretation":"","followUp":"","unsupported":""}
Rules:
- Use only values from the lists above. Prices are AED: "3M" = 3000000, "900k" = 900000. "Under X" or "budget X" sets maxPrice only; "around X" sets minPrice 0.85X and maxPrice 1.1X.
- budgetStrict is false unless they explicitly say it's a hard limit ("absolute max", "cannot exceed", "strictly").
- Only set communities or regions when the buyer names an area. Never infer an area from a landmark, school or lifestyle - "near Cranleigh" sets near only.
- mustHaves = things they clearly need ("must", "need", "has to", "with a", "has a"). niceToHaves = things they'd like ("would love", "would like", "ideally", "prefer", "bonus", "would be nice", "if possible"). When unsure, use niceToHaves - must-haves hide homes.
- "near/close to/minutes from/work at" a landmark -> near (maxKm 8 for "walking distance", 10 default, 15 for "not too far", 25 for "within commuting distance"). If they name a community, use communities instead.
- Expat, foreigner, non-UAE national, or wanting a Golden Visa -> freeholdOnly true (only freehold zones allow foreign ownership).
- Family/kids -> priorities schools (+ Kids play area or Private garden as niceToHaves). Investment/rental income/ROI -> purpose invest + priority yield. "Cheap/good deal" -> value. Beach lifestyle -> beach. "Quiet" -> quiet.
- "Studio" -> minBeds 0, maxBeds 0. "3 bed" -> minBeds 3. "3-4 bed" -> minBeds 3, maxBeds 4. "House" -> Villa or Townhouse. Unknown maxBeds -> null.
- interpretation: one friendly sentence starting "You're looking for" summarizing what you understood.
- followUp: if budget, bedrooms or area is missing, ONE short question that would most improve results, else "".
- unsupported: anything they asked for that we can't search (another emirate/country, rentals, a place not listed), else "".`;

// The AI sometimes adds requirements nobody asked for (an area, a strict budget). Hard filters hide
// homes, so only keep them if the buyer's own words - or their existing filters - support them.
function guardInvented(ai, text, current) {
  const words = text.toLowerCase();
  const mentioned = new Set([...quickParse(text).communities, ...(current?.communities || [])]);
  const regionWords = {
    'Abu Dhabi Island': /main island|abu dhabi island|on the island|city centre|downtown/,
    'Islands & waterfront': /islands?\b|waterfront|beachfront/,
    'Mainland suburbs': /mainland|suburb|off[- ]island/,
    'Abu Dhabi–Dubai corridor': /dubai|border|corridor/,
    'Al Ain': /al ?ain/,
  };
  // Features mentioned with soft wording ("would love a garden") are nice-to-haves, not hard filters.
  const softClauses = words.split(/[,.;!?]|\band\b|\bbut\b/).filter((c) => /\b(love|ideally|prefer|preferably|would like|nice|if possible|bonus|wish|hopefully)\b/.test(c));
  const soft = new Set(softClauses.flatMap((c) => quickParse(c).mustHaves));
  const mustHaves = (Array.isArray(ai.mustHaves) ? ai.mustHaves : []).filter((f) => !soft.has(f));
  const niceToHaves = [...new Set([...(Array.isArray(ai.niceToHaves) ? ai.niceToHaves : []),
    ...(Array.isArray(ai.mustHaves) ? ai.mustHaves : []).filter((f) => soft.has(f))])];

  return {
    ...ai,
    mustHaves,
    niceToHaves,
    communities: (Array.isArray(ai.communities) ? ai.communities : []).filter((c) => {
      const name = String(c);
      return [...mentioned].some((m) => m.toLowerCase() === name.toLowerCase());
    }),
    regions: (Array.isArray(ai.regions) ? ai.regions : []).filter((r) => (current?.regions || []).includes(r) || regionWords[r]?.test(words)),
    budgetStrict: ai.budgetStrict === true && (current?.budgetStrict || /strict|absolute|cannot exceed|can'?t exceed|hard limit|not a dirham more|no more than|not more than/.test(words)),
  };
}

function finishParse(prefsInput, ai = {}) {
  const prefs = sanitizePrefs(prefsInput);
  return {
    prefs,
    mode: ai.mode === 'refine' ? 'refine' : 'new',
    interpretation: cleanText(ai.interpretation, 300) || `You're looking for ${interpretPrefs(prefs).replace(/^A /, 'a ')}`,
    followUp: cleanText(ai.followUp, 200),
    unsupported: cleanText(ai.unsupported, 120),
  };
}

// Understands a request. With `current` prefs, follow-ups like "cheaper" or "add townhouses" refine them.
export async function parseQuery(query, current) {
  const text = cleanText(query, 500);
  if (!text) throw new HttpError(400, 'Describe the home you are looking for first.');
  const currentPrefs = current && typeof current === 'object' ? sanitizePrefs(current) : null;

  const cacheKey = JSON.stringify([text.toLowerCase(), currentPrefs]);
  const cached = parseCache.get(cacheKey);
  if (cached) return cached;

  const context = currentPrefs
    ? `The buyer already has these search filters:\n${JSON.stringify(currentPrefs)}\nIf the new message adjusts them (e.g. "cheaper", "add townhouses", "closer to ADGM", "what about Yas?"), return mode "refine" with the FULL updated filters. If it is a completely new search, return mode "new" with fresh filters.`
    : 'This is a new search: return mode "new".';

  try {
    const ai = await chatJSON({
      messages: [
        { role: 'system', content: `You turn an Abu Dhabi home buyer's request into precise search filters. Respond with JSON only.\n${VOCABULARY}` },
        { role: 'user', content: `${context}\n\nBuyer's message: "${text}"\n\n${PARSE_RULES}` },
      ],
      maxTokens: 1100,
      temperature: 0,
    });
    const result = finishParse(guardInvented(ai, text, currentPrefs), ai);
    parseCache.set(cacheKey, result);
    return result;
  } catch (err) {
    // AI busy or failed: fall back to keyword understanding so search still works.
    console.warn(`AI parse failed, using keyword parser: ${err.message}`);
    const quick = quickParse(text);
    const merged = currentPrefs ? mergeRefinement(currentPrefs, quick) : quick;
    return { ...finishParse(merged), mode: currentPrefs ? 'refine' : 'new', fallback: true };
  }
}

// Keyword-mode refinement: anything mentioned in the new message overrides the current filters.
function mergeRefinement(current, quick) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(quick)) {
    const empty = value === '' || value === 0 || value === null || value === false || (Array.isArray(value) && !value.length);
    if (!empty) merged[key] = value;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

const ADVISOR_PROMPT = `You are HomeMatch AI, a friendly and honest Abu Dhabi real estate advisor.
You re-rank pre-filtered candidate homes for a buyer and explain the fit in plain, specific language. Prices are in AED.
Rules:
- Use only the facts on each home's own line. Never invent features, prices or numbers, and never mix up facts between homes.
- Each line ends with pre-computed checks (requirements met, distance, must-haves). Trust them.
- Be candid about real trade-offs for this buyer, but never manufacture one. An empty cons list is fine.
- Write to the buyer directly ("you", "your budget"), never "the buyer". Keep each pro/con under 12 words.
- Respond with JSON only.`;

function findRecommendations(ai) {
  if (Array.isArray(ai)) return ai;
  if (Array.isArray(ai?.recommendations)) return ai.recommendations;
  return Object.values(ai ?? {}).find(Array.isArray) ?? [];
}

function checksFor(item, prefs) {
  const l = item.listing;
  const checks = [item.exact ? 'meets ALL hard requirements' : 'close match (some requirements relaxed)'];
  if (prefs.maxPrice) {
    checks.push(l.price <= prefs.maxPrice ? 'within budget' : `${Math.round(((l.price - prefs.maxPrice) / prefs.maxPrice) * 100)}% OVER budget`);
  }
  if (item.distanceKm !== null) checks.push(`${item.distanceKm} km from ${landmarksById.get(prefs.near.landmark).name}`);
  if (prefs.mustHaves.length) {
    const missing = prefs.mustHaves.filter((f) => !l.features.includes(f));
    checks.push(`must-haves: ${missing.length ? `MISSING ${missing.join(', ')}` : 'all present'}`);
  }
  if (prefs.niceToHaves.length) {
    const nice = prefs.niceToHaves.filter((f) => l.features.includes(f));
    checks.push(`nice-to-haves: ${nice.join(', ') || 'none'}`);
  }
  return checks;
}

const toResult = (item, extra = {}) => ({
  listing: item.listing,
  matchScore: item.score,
  exact: item.exact,
  distanceKm: item.distanceKm,
  headline: '',
  pros: item.pros,
  cons: item.cons,
  ...extra,
});

function ruleSummary(search) {
  const { ranked, exactCount } = search;
  if (!ranked.length) return 'No homes matched these requirements. Try one of the suggestions below.';
  if (exactCount >= ranked.length) return `${exactCount} homes match everything you asked for. Here are the best fits.`;
  if (exactCount) return `${exactCount} homes match everything you asked for, so we've added close matches too.`;
  return 'Nothing matches every requirement, so these are the closest options.';
}

async function aiRank(search) {
  const { prefs } = search;
  const shortlist = search.ranked.slice(0, AI_SHORTLIST);
  const cacheKey = JSON.stringify([prefs, shortlist.map((s) => s.listing.id)]);
  const cached = rankCache.get(cacheKey);
  if (cached) return cached;

  const count = Math.min(TOP_PICKS, shortlist.length);
  const ai = await chatJSON({
    messages: [
      { role: 'system', content: ADVISOR_PROMPT },
      {
        role: 'user',
        content: `Buyer requirements:\n${describePrefs(prefs)}\n\nCandidate homes:\n${shortlist.map((s) => compactListing(s.listing, checksFor(s, prefs))).join('\n')}

Pick the best ${count} homes for this buyer, best first.
- matchScore is your 0-100 judgment of overall fit. Homes that meet all hard requirements should normally outrank relaxed ones; anything over budget or missing a must-have must lose real points.
- Pros and cons must explain fit for THIS buyer (their priorities, purpose, notes and distance needs). Quote numbers exactly as on that home's line. Don't restate beds, baths or sqft.
- Cons are only things that work against what they asked for. Never list a missing feature they didn't ask for.
Return JSON exactly like:
{"summary":"2-3 sentences: what you found, how many fully match, and the main trade-off","recommendations":[{"id":"home id from the brackets","matchScore":0-100,"headline":"max 12 words on why it fits this buyer","pros":["up to 3"],"cons":["up to 2"]}]}`,
      },
    ],
    maxTokens: 2600,
    temperature: 0.2,
    reasoningEffort: 'medium', // ranking is where accuracy matters most
  });

  const byId = new Map(shortlist.map((s) => [s.listing.id, s]));
  const picks = [];
  for (const rec of findRecommendations(ai)) {
    const id = String(rec?.id ?? '').replace(/[[\]\s]/g, '');
    const item = byId.get(id);
    if (!item) continue; // unknown or duplicate id
    byId.delete(id);
    const score = Number(rec.matchScore);
    const pros = cleanList(rec.pros, 3);
    const cons = cleanList(rec.cons, 2);
    picks.push(toResult(item, {
      matchScore: Number.isFinite(score) ? Math.round(Math.min(100, Math.max(0, score))) : item.score,
      headline: cleanText(rec.headline, 140),
      pros: pros.length ? pros : item.pros,
      cons: cons.length ? cons : item.cons,
    }));
    if (picks.length === count) break;
  }
  if (!picks.length) {
    console.warn(`Unusable AI ranking response: ${JSON.stringify(ai).slice(0, 600)}`);
    throw new HttpError(502, 'The AI did not return usable recommendations.');
  }
  // Never let the AI drop a home that meets every requirement in favour of a close match.
  for (const item of byId.values()) {
    if (item.exact) picks.push(toResult(item));
  }
  // Exact matches first, then by the AI's score (stable, so ties keep the AI's order).
  picks.sort((a, b) => (b.exact - a.exact) || (b.matchScore - a.matchScore));
  const result = { summary: cleanText(ai.summary, 700) || ruleSummary(search), picks: picks.slice(0, count) };
  rankCache.set(cacheKey, result);
  return result;
}

export async function recommend(rawPrefs) {
  const search = searchHomes(rawPrefs);
  const base = {
    prefs: search.prefs,
    interpretation: interpretPrefs(search.prefs),
    exactCount: search.exactCount,
    totalMatches: search.ranked.length,
    relaxed: search.relaxed,
    suggestions: search.suggestions,
  };
  if (!search.ranked.length) return { ...base, source: 'rules', summary: ruleSummary(search), results: [], more: [] };

  let source = 'ai';
  let summary;
  let picks;
  let warning;
  try {
    ({ summary, picks } = await aiRank(search));
  } catch (err) {
    console.warn(`AI ranking failed, using rule-based results: ${err.message}`);
    source = 'rules';
    summary = ruleSummary(search);
    picks = search.ranked.slice(0, TOP_PICKS).map((item) => toResult(item));
    warning = err instanceof HttpError ? err.message : 'AI ranking failed.';
  }

  const picked = new Set(picks.map((p) => p.listing.id));
  const more = search.ranked
    .filter((item) => !picked.has(item.listing.id))
    .slice(0, MORE_RESULTS)
    .map((item) => toResult(item));

  return { ...base, source, summary, warning, results: picks, more };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

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

  const system = `You are HomeMatch AI, a friendly, knowledgeable Abu Dhabi real estate assistant inside a home recommendation app. Prices are in AED.

Homes the buyer is looking at right now:
${homes.length ? homes.map((l) => compactListing(l)).join('\n') : '(none yet - suggest they run a search)'}

Buyer requirements:
${describePrefs(sanitizePrefs(prefs))}

Guidelines:
- Keep answers under 120 words unless the buyer asks for more detail. Lead with the answer, then at most 4 short "- " bullet points. No tables, no headings, and don't repeat facts the buyer can already see on the listing cards.
- Refer to homes by their title, never by the id in brackets.
- Only state facts that appear above. If something is unknown (exact payment plan, building condition, chiller costs), say so and suggest how to find out.
- You can compare homes, explain trade-offs, suggest questions for a viewing, and explain Abu Dhabi buying basics: freehold investment zones (where all nationalities can buy) vs areas limited to UAE/GCC nationals, ready vs off-plan, service charges and rental yields.
- For monthly cost, use the "est. AED X/mo total" figure given for each home (mortgage at ${LOAN.downPayment * 100}% down, ${LOAN.annualRate * 100}% over ${LOAN.years} years, plus service charge). Don't calculate your own.
- Upfront costs in Abu Dhabi are roughly a 2% transfer/registration fee plus agency (~2%) and mortgage fees. Homes of ${aed(GOLDEN_VISA_MIN)}+ may qualify for a 10-year Golden Visa. Always say rules can change and should be confirmed with ADREC / the Department of Municipalities and Transport or the relevant authority.
- You are not a licensed financial or legal advisor; for mortgages, contracts or visas, suggest confirming with a professional.
- If asked about something unrelated to homes or real estate, briefly steer back.`;

  const reply = await chat({
    messages: [{ role: 'system', content: system }, ...history],
    maxTokens: 1500,
    temperature: 0.5,
  });
  return { reply };
}
