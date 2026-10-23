// Search engine: turns structured buyer requirements into a ranked list of Abu Dhabi homes.
//   1. Hard filters (area, distance, budget, beds, type, completion, freehold, must-haves)
//   2. If too few homes match, relax the least important criteria one step at a time,
//      and report exactly what was relaxed
//   3. Score the remaining homes on soft preferences (priorities, nice-to-haves, purpose, distance)
import {
  COMMUNITIES, COMPLETION, FEATURES, LANDMARKS, PRIORITIES, PURPOSES, REGIONS, TYPES,
  aed, communityByName, distanceKm, driveMinutes, isOffPlan, landmarksById, listings,
} from './listings.js';

export const MIN_MATCHES = 6; // relax criteria until at least this many homes match
const DEFAULT_NEAR_KM = 10;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const average = (nums) => nums.reduce((a, b) => a + b, 0) / nums.length;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
const joinList = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const shortAed = (n) => (n >= 1e6 ? `AED ${+(n / 1e6).toFixed(2)}M` : `AED ${Math.round(n / 1000)}K`);
const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ---------------------------------------------------------------------------
// Vocabulary matching
// ---------------------------------------------------------------------------

function pickAllowed(values, allowed) {
  if (!Array.isArray(values)) return [];
  const lookup = new Map(allowed.map((a) => [norm(a), a]));
  return [...new Set(values.map((v) => lookup.get(norm(v))).filter(Boolean))];
}

export function matchCommunity(text) {
  const t = norm(text);
  if (!t) return null;
  return COMMUNITIES.find((c) => norm(c.name) === t || c.aliases.includes(t) || c.projects.some((p) => norm(p) === t))?.name
    ?? COMMUNITIES.find((c) => norm(c.name).includes(t) || t.includes(norm(c.name)))?.name
    ?? null;
}

export function matchLandmark(text) {
  const t = norm(text);
  if (!t) return null;
  return LANDMARKS.find((l) => l.id === t || norm(l.name) === t || l.aliases.includes(t))?.id
    ?? LANDMARKS.find((l) => norm(l.name).includes(t) || l.aliases.some((a) => t.includes(a)))?.id
    ?? null;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

const int = (v, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0;
};
const positive = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
};

export function sanitizePrefs(input = {}) {
  const p = input && typeof input === 'object' ? input : {};

  let minPrice = positive(p.minPrice, 1e9);
  let maxPrice = positive(p.maxPrice, 1e9);
  if (minPrice && maxPrice && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];

  const minBeds = int(p.minBeds, 0, 10);
  let maxBeds = p.maxBeds === null || p.maxBeds === undefined || p.maxBeds === '' ? null : int(p.maxBeds, 0, 10);
  if (maxBeds !== null && maxBeds < minBeds) maxBeds = null;

  const landmark = p.near && typeof p.near === 'object' ? matchLandmark(p.near.landmark) : null;
  const mustHaves = pickAllowed(p.mustHaves, FEATURES);

  return {
    communities: [...new Set((Array.isArray(p.communities) ? p.communities : []).map(matchCommunity).filter(Boolean))],
    regions: pickAllowed(p.regions, REGIONS),
    near: landmark ? { landmark, maxKm: positive(p.near.maxKm, 80) || DEFAULT_NEAR_KM } : null,
    minPrice,
    maxPrice,
    budgetStrict: p.budgetStrict === true,
    types: pickAllowed(p.types, TYPES),
    minBeds,
    maxBeds,
    minBaths: int(p.minBaths, 0, 10),
    minSqft: int(p.minSqft, 0, 50000),
    completion: Object.hasOwn(COMPLETION, p.completion) ? p.completion : '',
    freeholdOnly: p.freeholdOnly === true,
    mustHaves,
    niceToHaves: pickAllowed(p.niceToHaves, FEATURES).filter((f) => !mustHaves.includes(f)),
    priorities: pickAllowed(p.priorities, Object.keys(PRIORITIES)),
    purpose: Object.hasOwn(PURPOSES, p.purpose) ? p.purpose : '',
    notes: cleanText(p.notes, 400),
  };
}

function budgetText(p) {
  if (p.minPrice && p.maxPrice) return `${shortAed(p.minPrice)}–${shortAed(p.maxPrice)}`;
  if (p.maxPrice) return `up to ${shortAed(p.maxPrice)}`;
  if (p.minPrice) return `from ${shortAed(p.minPrice)}`;
  return '';
}

function bedsText(p) {
  if (p.maxBeds !== null && p.maxBeds === p.minBeds) return p.minBeds === 0 ? 'studio' : `${p.minBeds}-bed`;
  if (p.maxBeds !== null) return `${p.minBeds || 'studio'}–${p.maxBeds} bed`;
  return p.minBeds ? `${p.minBeds}+ bed` : '';
}

// For AI prompts.
export function describePrefs(p) {
  const near = p.near ? `${landmarksById.get(p.near.landmark).name} (within ${p.near.maxKm} km)` : 'none';
  return [
    `- Areas: ${p.communities.join(', ') || p.regions.join(', ') || 'anywhere in Abu Dhabi'}`,
    `- Near: ${near}`,
    `- Budget: ${budgetText(p) || 'not given'}${p.budgetStrict ? ' (strict)' : ''}`,
    `- Type: ${p.types.join(', ') || 'any'}; bedrooms: ${bedsText(p) || 'any'}${p.minBaths ? `; ${p.minBaths}+ baths` : ''}${p.minSqft ? `; ${p.minSqft}+ sqft` : ''}`,
    `- Completion: ${COMPLETION[p.completion] || 'any'}; ${p.freeholdOnly ? 'must be freehold (buyer is an expat)' : 'freehold not required'}`,
    `- Must-haves: ${p.mustHaves.join(', ') || 'none'}; nice-to-haves: ${p.niceToHaves.join(', ') || 'none'}`,
    `- Priorities: ${p.priorities.map((k) => PRIORITIES[k]).join(', ') || 'none'}; purpose: ${PURPOSES[p.purpose] || 'not given'}`,
    `- Notes: ${p.notes || 'none'}`,
  ].join('\n');
}

// A plain-English sentence of what we understood (used when the AI didn't write one).
export function interpretPrefs(p) {
  const types = p.types.map((t) => t.toLowerCase());
  const typeText = types.length ? (types.length < 3 ? types.join(' or ') : `${types.slice(0, -1).join(', ')} or ${types.at(-1)}`) : 'home';
  const what = [bedsText(p), typeText].filter(Boolean).join(' ');
  const parts = [`${/^[aeiou]/i.test(what) ? 'An' : 'A'} ${what}`];
  if (p.communities.length) parts.push(`in ${joinList(p.communities)}`);
  else if (p.regions.length) parts.push(`in ${joinList(p.regions)}`);
  else parts.push('anywhere in Abu Dhabi');
  if (p.near) parts.push(`within ${p.near.maxKm} km of ${landmarksById.get(p.near.landmark).name}`);
  if (budgetText(p)) parts.push(budgetText(p));
  if (p.completion) parts.push(p.completion === 'offplan' ? 'off-plan' : 'ready to move in');
  if (p.freeholdOnly) parts.push('freehold');
  if (p.mustHaves.length) parts.push(`with ${joinList(p.mustHaves.map((f) => f.toLowerCase()))}`);
  if (p.purpose === 'invest') parts.push('as an investment');
  return `${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Quick keyword parser - used when the AI is busy, so search never breaks
// ---------------------------------------------------------------------------

const FEATURE_SYNONYMS = [
  [/private pool|own pool|pool/, 'Private pool'], [/beach/, 'Beach access'], [/sea ?view|water ?view/, 'Sea view'],
  [/garden|yard/, 'Private garden'], [/maid/, "Maid's room"], [/driver/, "Driver's room"], [/majlis/, 'Majlis'],
  [/study|office|work from home|wfh/, 'Study'], [/pet|dog|cat/, 'Pet friendly'], [/golf/, 'Golf course view'],
  [/canal/, 'Canal view'], [/mangrove/, 'Mangrove view'], [/furnished/, 'Furnished'], [/chiller/, 'Chiller free'],
  [/balcony/, 'Balcony'], [/gym/, 'Gym'], [/parking/, 'Covered parking'], [/smart/, 'Smart home'],
  [/rooftop|terrace/, 'Rooftop terrace'], [/concierge/, 'Concierge'], [/kids|children|play area/, 'Kids play area'],
];

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordMatch = (text, phrase) => phrase.length >= 2 && new RegExp(`\\b${escapeRegExp(phrase)}\\b`).test(text);

// Finds the longest phrase (whole words) from any entry that appears in the text.
function findPhrase(text, entries) {
  let best = null;
  for (const entry of entries) {
    for (const phrase of entry.phrases) {
      if (wordMatch(text, phrase) && (!best || phrase.length > best.phrase.length)) best = { id: entry.id, phrase };
    }
  }
  return best;
}

function parseAmount(num, unit) {
  const n = Number(String(num).replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const u = norm(unit);
  if (/^(m|mn|mil|million)/.test(u)) return n * 1e6;
  if (/^(k|thousand)/.test(u)) return n * 1e3;
  return n < 1000 ? n * 1e6 : n; // "budget 3" most likely means 3M
}

export function quickParse(text) {
  const t = norm(text);
  const prefs = { communities: [], mustHaves: [], types: [], priorities: [] };

  // A number that is a price - not "10 km", "15 min" or "3 bed".
  const amount = String.raw`(?:aed\s*)?([\d.,]+)\s*(m|mn|million|k|thousand)?\b(?!\s*(?:km|min|minutes?|mins|bed|br|bhk|sqft|sq))`;
  const between = t.match(new RegExp(`between\\s+${amount}\\s+(?:and|to|-)\\s+${amount}`));
  const under = t.match(new RegExp(`(?:under|below|less than|max(?:imum)?|up to|upto|within|budget(?: of| is)?|not more than|<)\\s*${amount}`));
  const above = t.match(new RegExp(`(?:over|above|more than|at least|min(?:imum)?|from)\\s*${amount}`));
  if (between) {
    prefs.minPrice = parseAmount(between[1], between[2]);
    prefs.maxPrice = parseAmount(between[3], between[4]);
  } else {
    if (under) prefs.maxPrice = parseAmount(under[1], under[2]);
    if (above && !/bed/.test(t.slice(above.index, above.index + 20))) prefs.minPrice = parseAmount(above[1], above[2]);
  }
  if (/strict|absolute max|not more than|maximum/.test(t)) prefs.budgetStrict = true;

  const beds = t.match(/(\d)\s*\+?\s*(?:-|\s)?(?:bed|br\b|bhk|bedroom)/);
  if (beds) prefs.minBeds = Number(beds[1]);
  if (/\bstudio\b/.test(t)) { prefs.minBeds = 0; prefs.maxBeds = 0; }

  if (/\bvillas?\b|\bhouses?\b/.test(t)) prefs.types.push('Villa');
  if (/\btown ?houses?\b/.test(t)) prefs.types.push('Townhouse');
  if (/\bapartments?\b|\bflats?\b|\bstudio\b/.test(t)) prefs.types.push('Apartment');
  if (/\bpenthouses?\b/.test(t)) prefs.types.push('Penthouse');

  // Landmarks first: "near Yas Mall" is about distance, so its words must not also select Yas Island.
  let rest = t;
  const landmarkHit = findPhrase(t, LANDMARKS.map((l) => ({ id: l.id, phrases: [norm(l.name), ...l.aliases] })));
  const proximity = /\b(near|nearby|close to|next to|walk(?:ing)?|minutes?|mins?|km|commute|work|office|around|by)\b/;
  if (landmarkHit && proximity.test(t)) {
    const minutes = t.match(/(\d+)\s*(?:min|mins|minutes)\b/);
    const km = t.match(/(\d+)\s*km\b/);
    let maxKm = DEFAULT_NEAR_KM;
    if (km) maxKm = Number(km[1]);
    else if (minutes) maxKm = Math.max(3, Math.round((Number(minutes[1]) - 5) / 1.15));
    else if (/walk/.test(t)) maxKm = 3;
    prefs.near = { landmark: landmarkHit.id, maxKm };
    rest = t.replace(landmarkHit.phrase, ' ');
  }
  for (const c of COMMUNITIES) {
    const hits = [norm(c.name), ...c.aliases].filter((a) => wordMatch(rest, a));
    if (!hits.length) continue;
    prefs.communities.push(c.name);
    // Remove place names so "Al Raha Beach" doesn't also mean "Beach access".
    for (const hit of hits.sort((a, b) => b.length - a.length)) rest = rest.replace(new RegExp(`\\b${escapeRegExp(hit)}\\b`, 'g'), ' ');
  }

  if (/off[- ]?plan|payment plan|new launch|under construction/.test(t)) prefs.completion = 'offplan';
  else if (/ready|move in|immediate/.test(t)) prefs.completion = 'ready';
  if (/expat|foreigner|freehold|non[- ]?(uae|emirati|national)|golden visa|i'?m (indian|british|american|european|pakistani|filipino)/.test(t)) prefs.freeholdOnly = true;

  for (const [re, feature] of FEATURE_SYNONYMS) if (re.test(rest) && !prefs.mustHaves.includes(feature)) prefs.mustHaves.push(feature);

  if (/invest|rental|roi|yield|rent (?:it )?out/.test(t)) { prefs.purpose = 'invest'; prefs.priorities.push('yield'); }
  if (/family|kids|children|school/.test(t)) prefs.priorities.push('schools');
  if (/cheap|affordable|value|budget friendly|deal/.test(t)) prefs.priorities.push('value');
  if (/commute|close to work|near work|near (?:my )?office/.test(t)) prefs.priorities.push('commute');
  if (/walk|cafes|restaurants/.test(t)) prefs.priorities.push('walkability');
  if (/spacious|big|large|space/.test(t)) prefs.priorities.push('space');
  if (/\bnew\b|modern|brand new/.test(t)) prefs.priorities.push('newer');
  if (/quiet|peaceful|green|nature/.test(t)) prefs.priorities.push('quiet');
  if (/\blive\b|living|move/.test(t) && !prefs.purpose) prefs.purpose = 'live';
  return sanitizePrefs(prefs);
}

// ---------------------------------------------------------------------------
// Hard filtering with step-by-step relaxation
// ---------------------------------------------------------------------------

const SIMILAR_TYPES = { Villa: 'Townhouse', Townhouse: 'Villa', Apartment: 'Penthouse', Penthouse: 'Apartment' };

function initialState(p) {
  return {
    communities: p.communities,
    regions: p.regions,
    nearKm: p.near?.maxKm ?? 0,
    budget: 1,
    types: p.types,
    minBeds: p.minBeds,
    completion: p.completion,
    minSqft: p.minSqft,
    missing: 0,
  };
}

function passes(l, p, s) {
  if (s.communities.length) {
    if (!s.communities.includes(l.community)) return false;
  } else if (s.regions.length && !s.regions.includes(l.region)) return false;
  if (p.near && distanceKm(l, landmarksById.get(p.near.landmark)) > s.nearKm) return false;
  if (p.maxPrice && l.price > p.maxPrice * s.budget) return false;
  if (p.minPrice && l.price < p.minPrice * 0.95) return false;
  if (s.types.length && !s.types.includes(l.type)) return false;
  if (l.beds < s.minBeds) return false;
  if (p.maxBeds !== null && l.beds > p.maxBeds) return false;
  if (p.minBaths && l.baths < p.minBaths) return false;
  if (s.minSqft && l.sqft < s.minSqft) return false;
  if (s.completion === 'ready' && isOffPlan(l)) return false;
  if (s.completion === 'offplan' && !isOffPlan(l)) return false;
  if (p.freeholdOnly && !l.freehold) return false; // a legal requirement - never relaxed
  if (p.mustHaves.filter((f) => !l.features.includes(f)).length > s.missing) return false;
  return true;
}

// Ordered from least to most important. Each returns a note, or null if it doesn't apply.
const RELAX_STEPS = [
  (p, s) => (s.minSqft ? (s.minSqft = 0, `homes under ${p.minSqft.toLocaleString('en-US')} sqft`) : null),
  (p, s) => (p.near && s.nearKm === p.near.maxKm ? (s.nearKm = Math.round(p.near.maxKm * 1.6), `homes up to ${s.nearKm} km from ${landmarksById.get(p.near.landmark).name}`) : null),
  (p, s) => (p.maxPrice && !p.budgetStrict && s.budget < 1.1 ? (s.budget = 1.1, `homes up to 10% over your ${shortAed(p.maxPrice)} budget`) : null),
  (p, s) => (p.mustHaves.length > 1 && s.missing < 1 ? (s.missing = 1, 'homes missing one of your must-haves') : null),
  (p, s) => (s.completion ? (s.completion = '', `${p.completion === 'ready' ? 'off-plan' : 'ready'} homes too`) : null),
  (p, s) => {
    const extra = s.types.map((t) => SIMILAR_TYPES[t]).filter((t) => t && !s.types.includes(t));
    return extra.length ? (s.types = [...s.types, ...extra], `similar property types (${joinList(extra.map((t) => `${t.toLowerCase()}s`))})`) : null;
  },
  (p, s) => (s.minBeds >= 2 && s.minBeds === p.minBeds ? (s.minBeds -= 1, `${s.minBeds}-bedroom homes`) : null),
  (p, s) => {
    if (!s.communities.length) return null;
    const regions = [...new Set(s.communities.map((c) => communityByName.get(c).region))];
    s.communities = [];
    s.regions = regions;
    return `other communities in ${joinList(regions)}`;
  },
  (p, s) => (p.maxPrice && !p.budgetStrict && s.budget < 1.2 ? (s.budget = 1.2, `homes up to 20% over budget`) : null),
  (p, s) => (p.near && s.nearKm < p.near.maxKm * 2.5 ? (s.nearKm = Math.round(p.near.maxKm * 2.5), `homes up to ${s.nearKm} km away`) : null),
  (p, s) => (p.mustHaves.length && s.missing < p.mustHaves.length ? (s.missing = p.mustHaves.length, 'homes without all your must-haves') : null),
];

// Applies the given relaxation steps (in order) and returns the matching homes plus notes.
function applySteps(p, indices) {
  const state = initialState(p);
  const notes = [];
  for (const i of indices) {
    const note = RELAX_STEPS[i](p, state);
    if (note) notes.push(note);
  }
  return { pool: listings.filter((l) => passes(l, p, state)), notes };
}

function filterWithRelaxation(p) {
  const exact = applySteps(p, []);
  const exactIds = new Set(exact.pool.map((l) => l.id));
  if (exact.pool.length >= MIN_MATCHES) return { pool: exact.pool, exactIds, relaxed: [] };

  // Loosen cumulatively until there are enough homes (some only help in combination)...
  let applied = [];
  let result = exact;
  for (let i = 0; i < RELAX_STEPS.length && result.pool.length < MIN_MATCHES; i++) {
    const next = applySteps(p, [...applied, i]);
    if (next.notes.length > result.notes.length) { // step applied
      applied = [...applied, i];
      result = next;
    }
  }
  // ...then undo any loosening that turned out not to matter, so we only report real changes.
  for (const i of [...applied].reverse()) {
    const without = applySteps(p, applied.filter((x) => x !== i));
    if (without.pool.length >= result.pool.length) {
      applied = applied.filter((x) => x !== i);
      result = without;
    }
  }
  return { pool: result.pool, exactIds, relaxed: result.notes };
}

// When nothing (or little) matches, find which single requirement is holding results back.
function suggestions(p, exactCount) {
  if (exactCount >= MIN_MATCHES) return [];
  const notes = [];
  const nationalsOnly = p.communities.filter((c) => !communityByName.get(c)?.freehold);
  if (p.freeholdOnly && nationalsOnly.length) {
    notes.push(`${joinList(nationalsOnly)} ${nationalsOnly.length > 1 ? 'are' : 'is'} outside Abu Dhabi's freehold zones, so ownership there is generally limited to UAE/GCC nationals.`);
  }
  const without = [
    ['freehold only', { freeholdOnly: false }],
    ['the area', { communities: [], regions: [] }],
    ['the distance limit', { near: null }],
    ['the budget', { maxPrice: 0, minPrice: 0 }],
    ['the property type', { types: [] }],
    ['the bedroom count', { minBeds: 0, maxBeds: null }],
    ['ready / off-plan', { completion: '' }],
    ['the must-haves', { mustHaves: [] }],
  ];
  return without
    .map(([label, change]) => {
      const q = { ...p, ...change };
      const count = listings.filter((l) => passes(l, q, initialState(q))).length;
      return { label, count };
    })
    .filter((s) => s.count > exactCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((s) => `Removing ${s.label} would give ${s.count} exact match${s.count === 1 ? '' : 'es'}.`)
    .reduce((all, s) => [...all, s], notes);
}

// ---------------------------------------------------------------------------
// Soft scoring
// ---------------------------------------------------------------------------

const medianPpsf = (() => {
  const groups = {};
  for (const l of listings) (groups[`${l.community}|${l.type}`] ??= []).push(l.price / l.sqft);
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
})();

const priorityRules = {
  schools: { score: (l) => l.schoolRating / 10, pro: (l) => `Strong schools nearby (${l.schoolRating}/10)`, con: (l) => `Nearby schools rated ${l.schoolRating}/10` },
  walkability: { score: (l) => l.walkScore / 100, pro: (l) => `Walkable (Walk Score ${l.walkScore})`, con: (l) => `Car-dependent (Walk Score ${l.walkScore})` },
  commute: { score: (l) => clamp01(1 - (l.commuteMinutes - 8) / 35), pro: (l) => `${l.commuteMinutes} min to ${l.commuteTo}`, con: (l) => `${l.commuteMinutes} min drive to ${l.commuteTo}` },
  space: { score: (l) => clamp01(l.sqft / (l.type === 'Villa' ? 6000 : 2500)), pro: (l) => `Spacious at ${l.sqft.toLocaleString('en-US')} sqft`, con: (l) => `Compact at ${l.sqft.toLocaleString('en-US')} sqft` },
  value: {
    score: (l) => {
      const median = medianPpsf[`${l.community}|${l.type}`];
      return clamp01(0.5 + ((median - l.price / l.sqft) / median) * 2);
    },
    pro: (l) => `Good value for ${l.community} (${aed(l.price / l.sqft)}/sqft)`,
    con: (l) => `Priced above similar homes (${aed(l.price / l.sqft)}/sqft)`,
  },
  yield: { score: (l) => clamp01((l.rentalYield - 3.5) / 4.5), pro: (l) => `Strong ${l.rentalYield}% gross rental yield`, con: (l) => `Lower ${l.rentalYield}% rental yield` },
  newer: { score: (l) => clamp01((l.yearBuilt - 2005) / 22), pro: (l) => (isOffPlan(l) ? `Brand new, handover ${l.completion}` : `Newer build (${l.yearBuilt})`), con: (l) => `Older building (${l.yearBuilt})` },
  beach: {
    score: (l) => (l.features.includes('Beach access') ? 1 : l.features.includes('Sea view') ? 0.6 : 0.15),
    pro: (l) => (l.features.includes('Beach access') ? 'Beach on your doorstep' : 'Sea views'),
    con: () => 'No beach access or sea view',
  },
  quiet: {
    score: (l) => clamp01(1 - l.walkScore / 100 + (l.features.some((f) => ['Community park', 'Mangrove view', 'Private garden'].includes(f)) ? 0.25 : 0)),
    pro: () => 'Quiet, green surroundings',
    con: (l) => `Busy urban area (Walk Score ${l.walkScore})`,
  },
};

function scoreListing(l, p, distance) {
  const pros = [];
  const cons = [];
  let score = 40; // hard-requirement fit; deductions below only happen for relaxed matches

  if (p.maxPrice && l.price > p.maxPrice) {
    const over = (l.price - p.maxPrice) / p.maxPrice;
    score -= Math.min(20, over * 150);
    cons.push(`${Math.max(1, Math.round(over * 100))}% over your budget`);
  } else if (p.maxPrice) {
    pros.push(l.price <= p.maxPrice * 0.85 ? `Well within budget at ${shortAed(l.price)}` : 'Within your budget');
  }
  const missing = p.mustHaves.filter((f) => !l.features.includes(f));
  const has = p.mustHaves.filter((f) => l.features.includes(f));
  if (missing.length) { score -= 10 * missing.length; cons.push(`No ${joinList(missing.map((f) => f.toLowerCase()))}`); }
  if (has.length) pros.push(`Has ${joinList(has.map((f) => f.toLowerCase()))}`);
  if (l.beds < p.minBeds) { score -= 10; cons.push(`${l.beds === 0 ? 'A studio' : `${l.beds} bedroom${l.beds > 1 ? 's' : ''}`}, not ${p.minBeds}+`); }
  if (p.types.length && !p.types.includes(l.type)) { score -= 6; cons.push(`A ${l.type.toLowerCase()}, not a ${joinList(p.types.map((t) => t.toLowerCase()))}`); }
  if (p.completion === 'ready' && isOffPlan(l)) { score -= 8; cons.push(`Off-plan, handover ${l.completion}`); }
  if (p.completion === 'offplan' && !isOffPlan(l)) { score -= 8; cons.push('Ready property, not off-plan'); }
  if (p.communities.length && !p.communities.includes(l.community)) { score -= 5; cons.push(`In ${l.community}, outside your chosen area`); }

  // Priorities: 25 points
  if (p.priorities.length) {
    const values = p.priorities.map((k) => priorityRules[k].score(l));
    score += 25 * average(values);
    p.priorities.forEach((k, i) => {
      if (values[i] >= 0.75) pros.push(priorityRules[k].pro(l));
      else if (values[i] < 0.35) cons.push(priorityRules[k].con(l));
    });
  } else {
    score += 15;
  }

  // Nice-to-haves: 15 points
  if (p.niceToHaves.length) {
    const nice = p.niceToHaves.filter((f) => l.features.includes(f));
    score += (15 * nice.length) / p.niceToHaves.length;
    if (nice.length) pros.push(`Bonus: ${joinList(nice.map((f) => f.toLowerCase()))}`);
  } else {
    score += 10;
  }

  // Purpose: 10 points
  if (p.purpose === 'invest') {
    score += 10 * priorityRules.yield.score(l);
    if (!p.priorities.includes('yield') && l.rentalYield >= 7) pros.push(`${l.rentalYield}% gross yield`);
  } else if (p.purpose === 'live') {
    score += 10 * average([l.schoolRating / 10, l.features.includes('Community park') ? 1 : 0.5]);
  } else {
    score += 6;
  }

  // Distance to the place they care about: 10 points
  if (p.near && distance !== null) {
    score += 10 * clamp01(1 - distance / (p.near.maxKm * 1.5));
    const name = landmarksById.get(p.near.landmark).name;
    const text = `${distance.toFixed(1)} km (~${driveMinutes(distance)} min) from ${name}`;
    if (distance <= p.near.maxKm) pros.unshift(text);
    else cons.push(text);
  } else {
    score += 6;
  }

  if (l.serviceCharge / l.sqft > 20) cons.push(`High service charge (${aed(l.serviceCharge)}/yr)`);

  return { score: Math.max(0, Math.min(100, Math.round(score))), pros: pros.slice(0, 3), cons: cons.slice(0, 2) };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function searchHomes(rawPrefs) {
  const prefs = sanitizePrefs(rawPrefs);
  const { pool, exactIds, relaxed } = filterWithRelaxation(prefs);
  const landmark = prefs.near ? landmarksById.get(prefs.near.landmark) : null;

  const ranked = pool
    .map((listing) => {
      const distance = landmark ? distanceKm(listing, landmark) : null;
      return {
        listing,
        exact: exactIds.has(listing.id),
        distanceKm: distance === null ? null : +distance.toFixed(1),
        ...scoreListing(listing, prefs, distance),
      };
    })
    .sort((a, b) => (b.exact - a.exact) || (b.score - a.score));

  return {
    prefs,
    exactCount: exactIds.size,
    relaxed,
    suggestions: suggestions(prefs, exactIds.size),
    ranked,
  };
}

export function searchVocabulary() {
  return {
    communities: COMMUNITIES.map(({ name, region, freehold }) => ({ name, region, freehold })),
    regions: REGIONS,
    landmarks: LANDMARKS.map(({ id, name, kind }) => ({ id, name, kind })),
    types: TYPES,
    features: FEATURES,
    priorities: PRIORITIES,
    completion: COMPLETION,
    purposes: PURPOSES,
  };
}
