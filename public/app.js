// HomeMatch AI (Abu Dhabi) - frontend.
// The browser only talks to our own server; the Groq API key never reaches this file.

const SAVED_KEY = 'homematch:saved';
const THEME_KEY = 'homematch:theme';
const ORIGIN_KEY = 'homematch:origin';

const state = {
  meta: null, // { listings, communities, regions, landmarks, types, features, priorities, completion, purposes, loan, goldenVisaMin }
  maps: { key: '', mapId: '' },
  byId: new Map(),
  results: [], // AI top picks: [{ listing, matchScore, exact, distanceKm, headline, pros, cons }]
  more: [], // further matching homes (rule-ranked)
  prefs: null, // requirements used for the last search
  parseInfo: null, // what the AI understood from the last typed request
  chips: [], // removable requirement chips currently shown
  refining: false, // true once results are showing: typed text refines the search
  lastResponse: null,
  saved: new Set(readJSON(SAVED_KEY, [])),
  chat: [], // [{ role, content }]
  chatFocusId: null,
  chatBusy: false,
  view: 'results',
  busy: false,
  mapListing: null, // listing shown in the map dialog
  pins: new Map(), // listing id -> price pin element on the results map
};

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// Cursor effects only make sense with a mouse or trackpad.
const fancyPointer = matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const num = (n) => Math.round(n).toLocaleString('en-US');
const aed = (n) => `AED ${num(n)}`;
const shortAed = (n) => (n >= 1e6 ? `AED ${+(n / 1e6).toFixed(2)}M` : `AED ${Math.round(n / 1000)}K`);
const bedsText = (beds) => (beds === 0 ? 'Studio' : `<b>${beds}</b> bd`);
const isOffPlan = (l) => l.completion !== 'Ready';

function readJSON(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  } catch { /* storage unavailable (private mode) - it still works for this visit */ }
}

async function api(path, body) {
  const options = body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error('Cannot reach the server. Is it still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Same formula and assumptions as the server (src/listings.js), so the AI quotes the same numbers.
function monthlyCost(listing) {
  const { downPayment, annualRate, years } = state.meta.loan;
  const principal = listing.price * (1 - downPayment);
  const r = annualRate / 12;
  const n = years * 12;
  return (principal * r) / (1 - (1 + r) ** -n) + (listing.serviceCharge || 0) / 12;
}

// Tiny, safe markdown: escapes first, then supports **bold**, *italic*, bullets and headings.
function renderMarkdown(text) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
  let html = '';
  let inList = false;
  for (const line of escapeHTML(text).split('\n')) {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (item) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) html += `<p><strong>${inline(heading[1])}</strong></p>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// ---------------------------------------------------------------------------
// Icons & artwork
// ---------------------------------------------------------------------------

const HEART_PATH = 'M12 20.5s-7.3-4.4-9.6-9C.9 8.4 2.8 4.5 6.5 4.5c2.1 0 3.8 1.2 5.5 3.3 1.7-2.1 3.4-3.3 5.5-3.3 3.7 0 5.6 3.9 4.1 7-2.3 4.6-9.6 9-9.6 9z';
const ICONS = {
  sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9zM19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z" fill="currentColor"/></svg>',
  heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}" fill="currentColor"/></svg>`,
  heartOutline: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="10" r="2.5" fill="currentColor"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};

// Windows get class "win" so they "light up" on hover (see styles.css).
function windowsGrid(x, top, width, bottom) {
  const cols = Math.floor((width - 6) / 13);
  const startX = x + (width - cols * 13 + 5) / 2;
  let out = '';
  let i = 0;
  for (let y = top + 8; y <= bottom; y += 13) {
    for (let c = 0; c < cols; c++) {
      out += `<rect class="win" style="--d:${i++}" x="${startX + c * 13}" y="${y}" width="8" height="8" rx="1"/>`;
    }
  }
  return out;
}

function artSVG(type) {
  let shapes = '';
  if (type === 'Villa') {
    shapes = `
      <rect x="40" y="26" width="62" height="24" fill="currentColor"/>
      <rect x="34" y="21" width="74" height="6" rx="1" fill="currentColor"/>
      <rect x="28" y="50" width="112" height="50" fill="currentColor"/>
      <rect x="20" y="45" width="128" height="7" rx="1" fill="currentColor"/>
      <rect class="win" style="--d:0" x="48" y="31" width="18" height="13" rx="1.5"/>
      <rect class="win" style="--d:1" x="74" y="31" width="18" height="13" rx="1.5"/>
      <rect class="win" style="--d:2" x="40" y="62" width="24" height="16" rx="1.5"/>
      <rect class="win" style="--d:3" x="70" y="62" width="24" height="16" rx="1.5"/>
      <rect class="win" style="--d:4" x="104" y="64" width="20" height="36" rx="1.5"/>
      <g class="palm" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
        <path d="M166 100Q160 76 166 48"/>
        <path d="M166 48q-18-4-28 9M166 48q17-6 28 6M166 48q-8-15-23-15M166 48q10-15 24-12"/>
      </g>`;
  } else if (type === 'Townhouse') {
    shapes = [0, 1, 2].map((i) => {
      const x = 36 + i * 44;
      return `<rect x="${x}" y="${i === 1 ? 30 : 40}" width="42" height="${i === 1 ? 70 : 60}" fill="currentColor" opacity="${i === 1 ? 1 : 0.85}"/>
        <rect x="${x - 3}" y="${i === 1 ? 26 : 36}" width="48" height="5" fill="currentColor"/>
        <rect class="win" style="--d:${i * 2}" x="${x + 9}" y="${i === 1 ? 40 : 50}" width="24" height="13" rx="1.5"/>
        <rect class="win" style="--d:${i * 2 + 1}" x="${x + 14}" y="78" width="14" height="22" rx="1.5"/>`;
    }).join('');
  } else if (type === 'Penthouse') {
    shapes = `
      <path d="M100 0v10" stroke="currentColor" stroke-width="2"/>
      <rect x="82" y="8" width="36" height="10" fill="currentColor"/>
      <rect x="74" y="16" width="52" height="84" rx="2" fill="currentColor"/>
      <rect class="win" style="--d:0" x="80" y="20" width="40" height="8" rx="1"/>
      ${windowsGrid(74, 24, 52, 78)}
      <rect x="40" y="58" width="28" height="42" fill="currentColor" opacity=".75"/>
      <rect x="132" y="48" width="30" height="52" fill="currentColor" opacity=".75"/>`;
  } else {
    shapes = [[56, 8, 52], [114, 34, 34]].map(([x, top, width]) => `
      <rect x="${x}" y="${top}" width="${width}" height="${100 - top}" rx="2" fill="currentColor"/>
      ${windowsGrid(x, top, width, 76)}
      <rect x="${x + width / 2 - 7}" y="88" width="14" height="12" fill="rgba(0,0,0,.18)"/>`).join('');
  }
  return `<svg class="art" viewBox="0 0 200 100" aria-hidden="true">${shapes}</svg>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function homeCard(item, rank = 0) {
  const l = item.listing;
  const saved = state.saved.has(l.id);
  const wanted = new Set(state.prefs?.mustHaves || []);
  const hasScore = typeof item.matchScore === 'number';
  const { loan, goldenVisaMin } = state.meta;
  let scoreClass = '';
  if (item.matchScore >= 80) scoreClass = 'is-great';
  else if (item.matchScore < 60) scoreClass = 'is-low';

  return `
  <article class="card home-card reveal" data-id="${escapeHTML(l.id)}">
    <div class="home-media${l.image ? ' has-photo' : ''}" data-type="${escapeHTML(l.type)}">
      <span class="sun" aria-hidden="true"></span>
      ${artSVG(l.type)}
      ${l.image ? `<img class="home-photo" src="${escapeHTML(l.image.url)}" alt="${escapeHTML(`${l.community}, ${l.emirate}`)}" loading="lazy" decoding="async">` : ''}
      <div class="badges">
        <span class="badge">${escapeHTML(l.type)}</span>
        ${isOffPlan(l) ? `<span class="badge badge-offplan">Off-plan · ${escapeHTML(l.completion)}</span>` : ''}
        ${rank === 1 && item.exact !== false ? '<span class="badge badge-top">Top pick</span>' : ''}
        ${item.exact === false ? '<span class="badge badge-close" title="Doesn\'t meet every requirement - see the minus points">Close match</span>' : ''}
      </div>
      <button class="save-btn" type="button" data-action="save" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save home'}">
        ${saved ? ICONS.heart : ICONS.heartOutline}
      </button>
      ${hasScore ? `<div class="match ${scoreClass}" style="--p:${item.matchScore}" title="Match score"><span>${item.matchScore}<small>match</small></span></div>` : ''}
    </div>
    <div class="home-body">
      <div class="price"><span class="currency">AED</span>${num(l.price)}
        <span class="monthly" title="Estimate: ${loan.downPayment * 100}% down, ${loan.annualRate * 100}% over ${loan.years} years, plus service charge. Excludes fees and insurance.">≈ ${aed(monthlyCost(l))}/mo estimated</span>
      </div>
      <h3>${escapeHTML(l.title)}</h3>
      <button class="location" type="button" data-action="map" title="Show on Google Maps">${ICONS.pin}${escapeHTML(l.project === l.community ? l.community : `${l.project}, ${l.community}`)}</button>
      <ul class="stats">
        <li>${bedsText(l.beds)}</li>
        <li><b>${l.baths}</b> ba</li>
        <li><b>${num(l.sqft)}</b> sqft</li>
        <li>${isOffPlan(l) ? `Handover <b>${escapeHTML(l.completion)}</b>` : `Built <b>${l.yearBuilt}</b>`}</li>
      </ul>
      <div class="perks">
        ${typeof item.distanceKm === 'number' ? `<span class="perk perk-distance" title="Straight-line distance; drive time is an estimate">${item.distanceKm} km · ~${Math.round(item.distanceKm * 1.15 + 6)} min from ${escapeHTML(landmarkName(state.prefs?.near?.landmark))}</span>` : ''}
        ${l.freehold
          ? '<span class="perk perk-freehold" title="Freehold investment zone: all nationalities can buy">Freehold</span>'
          : '<span class="perk perk-nationals" title="Outside the freehold zones: ownership is generally limited to UAE/GCC nationals">UAE/GCC nationals</span>'}
        <span class="perk perk-yield" title="Estimated gross rental yield">${l.rentalYield}% yield</span>
        ${l.price >= goldenVisaMin ? `<span class="perk perk-visa" title="Properties worth ${shortAed(goldenVisaMin)}+ may qualify the owner for a 10-year UAE Golden Visa. Rules can change, so check with the ICP / GDRFA.">Golden Visa eligible*</span>` : ''}
      </div>
      ${item.headline ? `<p class="headline">${ICONS.sparkle}<span>${escapeHTML(item.headline)}</span></p>` : ''}
      ${item.pros?.length ? `<ul class="points pros">${item.pros.map((p) => `<li>${escapeHTML(p)}</li>`).join('')}</ul>` : ''}
      ${item.cons?.length ? `<ul class="points cons">${item.cons.map((c) => `<li>${escapeHTML(c)}</li>`).join('')}</ul>` : ''}
      <div class="tags">
        ${l.features.map((f) => `<span class="tag${wanted.has(f) ? ' is-match' : ''}">${escapeHTML(f)}</span>`).join('')}
      </div>
      <details class="more">
        <summary>Details</summary>
        <p>${escapeHTML(l.description)}</p>
        <dl class="facts">
          <dt>Nearby schools</dt><dd>${l.schoolRating}/10</dd>
          <dt>Walk Score</dt><dd>${l.walkScore}</dd>
          <dt>Drive to ${escapeHTML(l.commuteTo)}</dt><dd>${l.commuteMinutes} min</dd>
          <dt>Service charge</dt><dd>${aed(l.serviceCharge)}/yr</dd>
          <dt>Price / sqft</dt><dd>${aed(l.price / l.sqft)}</dd>
        </dl>
        ${l.image ? photoCredit(l) : ''}
      </details>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" type="button" data-action="map">${ICONS.map} Map & directions</button>
        <button class="btn btn-outline btn-sm" type="button" data-action="ask">${ICONS.sparkle} Ask AI</button>
      </div>
    </div>
  </article>`;
}

// Sample listings use freely licensed area photos (Wikimedia Commons), which require attribution.
// The photo's own title is shown so it's clear what it depicts.
function photoCredit(l) {
  const { title, credit, license, source, representative } = l.image;
  const label = escapeHTML(title || 'Photo');
  const linked = source ? `<a href="${escapeHTML(source)}" target="_blank" rel="noopener">${label}</a>` : label;
  const kind = representative ? `Representative Abu Dhabi photo (not ${escapeHTML(l.community)})` : 'Area photo';
  return `<p class="photo-credit">${kind}: ${linked}${credit ? ` by ${escapeHTML(credit)}` : ''}${license ? `, ${escapeHTML(license)}` : ''}</p>`;
}

const landmarkName = (id) => state.meta?.landmarks.find((l) => l.id === id)?.name || '';

function emptyState(title, text) {
  return `<div class="card empty-state"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(text)}</p></div>`;
}

// Cards fade up in a stagger as they scroll into view.
const revealObserver = 'IntersectionObserver' in window && !reduceMotion
  ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      revealObserver.unobserve(el);
      el.classList.add('is-visible');
      // Drop the reveal classes afterwards so hover tilt uses the card's own timing.
      setTimeout(() => el.classList.remove('reveal', 'is-visible'), 700 + Number(el.style.getPropertyValue('--i') || 0) * 70);
    }
  }, { threshold: 0.12 })
  : null;

function setGrid(grid, html) {
  grid.innerHTML = html;
  $$('.reveal', grid).forEach((el, i) => {
    if (!revealObserver) {
      el.classList.remove('reveal');
      return;
    }
    el.style.setProperty('--i', i % 6);
    revealObserver.observe(el);
  });
}

function renderWelcome() {
  const communities = new Set(state.meta.listings.map((l) => l.community)).size;
  $('#summary').innerHTML = `
    <div class="steps">
      <div class="card step"><b>1</b><h3>Say what you need</h3><p>Budget, bedrooms, where you work or study, freehold, must-haves. In plain English.</p></div>
      <div class="card step"><b>2</b><h3>We filter & rank</h3><p>Every home is checked against your requirements, then the AI ranks the best fits.</p></div>
      <div class="card step"><b>3</b><h3>Refine & visit</h3><p>Remove a requirement in one tap, ask follow-ups, and get directions on Google Maps.</p></div>
    </div>
    <div class="section-head">
      <h2>Featured Abu Dhabi homes</h2>
      <p class="muted">${state.meta.listings.length} homes across ${communities} communities, from Saadiyat and Reem to Khalifa City and Al Ain.</p>
    </div>`;
  $('#results-map-wrap').hidden = true;
  $('#more-section').hidden = true;
  const featured = state.meta.listings.filter((_, i) => i % 20 === 0).slice(0, 6);
  setGrid($('#results-grid'), featured.map((listing) => homeCard({ listing })).join(''));
}

// ---------------------------------------------------------------------------
// "What we understood" chips. Each one can be removed to widen the search.
// ---------------------------------------------------------------------------

function bedsLabel(p) {
  if (p.maxBeds !== null && p.maxBeds === p.minBeds) return p.minBeds === 0 ? 'Studio' : `${p.minBeds} bed`;
  if (p.maxBeds !== null) return `${p.minBeds || 'Studio'}–${p.maxBeds} bed`;
  return p.minBeds ? `${p.minBeds}+ bed` : '';
}

function prefChips(p) {
  const chips = [];
  const add = (label, change, kind = 'hard') => chips.push({ label, change, kind });
  const without = (list, value) => list.filter((x) => x !== value);
  const m = state.meta;

  for (const c of p.communities) add(c, { communities: without(p.communities, c) });
  for (const r of p.regions) add(r, { regions: without(p.regions, r) });
  if (p.near) add(`≤ ${p.near.maxKm} km from ${landmarkName(p.near.landmark)}`, { near: null });
  if (p.minPrice && p.maxPrice) add(`${shortAed(p.minPrice)} – ${shortAed(p.maxPrice)}`, { minPrice: 0, maxPrice: 0, budgetStrict: false });
  else if (p.maxPrice) add(`Up to ${shortAed(p.maxPrice)}${p.budgetStrict ? ' (strict)' : ''}`, { maxPrice: 0, budgetStrict: false });
  else if (p.minPrice) add(`From ${shortAed(p.minPrice)}`, { minPrice: 0 });
  for (const t of p.types) add(t, { types: without(p.types, t) });
  if (bedsLabel(p)) add(bedsLabel(p), { minBeds: 0, maxBeds: null });
  if (p.minBaths) add(`${p.minBaths}+ baths`, { minBaths: 0 });
  if (p.minSqft) add(`${num(p.minSqft)}+ sqft`, { minSqft: 0 });
  if (p.completion) add(m.completion[p.completion], { completion: '' });
  if (p.freeholdOnly) add('Freehold only', { freeholdOnly: false });
  for (const f of p.mustHaves) add(f, { mustHaves: without(p.mustHaves, f) });
  for (const f of p.niceToHaves) add(`Nice: ${f}`, { niceToHaves: without(p.niceToHaves, f) }, 'soft');
  for (const k of p.priorities) add(m.priorities[k] || k, { priorities: without(p.priorities, k) }, 'soft');
  if (p.purpose) add(m.purposes[p.purpose], { purpose: '' }, 'soft');
  if (p.notes) add(`“${p.notes.length > 40 ? `${p.notes.slice(0, 40)}…` : p.notes}”`, { notes: '' }, 'soft');
  return chips;
}

function renderSummary(data, parseInfo = null) {
  const isAI = data.source === 'ai';
  state.chips = prefChips(data.prefs);
  const interpretation = parseInfo?.interpretation || data.interpretation;
  const matchLine = data.exactCount
    ? `<b>${data.exactCount}</b> home${data.exactCount === 1 ? '' : 's'} match all your requirements${data.totalMatches > data.exactCount ? `, plus ${data.totalMatches - data.exactCount} close matches` : ''}.`
    : `No home matches every requirement${data.totalMatches ? `, so here are the ${data.totalMatches} closest` : ''}.`;

  $('#summary').innerHTML = `
    <div class="card understood-card">
      <div class="summary-top">
        <span class="summary-label">${ICONS.sparkle} What I understood</span>
        ${parseInfo?.fallback ? '<span class="pill-muted" title="The AI was busy, so keywords were used">Quick keyword mode</span>' : ''}
      </div>
      <p class="interpretation">${escapeHTML(interpretation)}</p>
      <div class="req-chips" aria-label="Your requirements">
        ${state.chips.map((c, i) => `<button type="button" class="req-chip is-${c.kind}" data-chip="${i}" title="Remove this requirement">${escapeHTML(c.label)}<span aria-hidden="true">×</span><span class="sr-only">Remove</span></button>`).join('')
          || '<span class="muted small">No specific requirements yet. Showing the best homes overall.</span>'}
      </div>
      <p class="match-line">${matchLine}</p>
      ${data.relaxed?.length ? `<div class="notice notice-relaxed"><b>To show you enough options I also included:</b> ${escapeHTML(data.relaxed.join('; '))}. These are marked <i>close match</i>.</div>` : ''}
      ${data.suggestions?.length ? `<div class="notice notice-tip">${data.suggestions.map(escapeHTML).join(' ')}</div>` : ''}
      ${parseInfo?.unsupported ? `<div class="notice notice-tip">Not searchable yet: ${escapeHTML(parseInfo.unsupported)}.</div>` : ''}
      ${parseInfo?.followUp ? `<div class="notice notice-question">${ICONS.sparkle}<span><b>To narrow it down:</b> ${escapeHTML(parseInfo.followUp)} <span class="muted">Just type your answer above.</span></span></div>` : ''}
    </div>
    ${data.results.length ? `
    <div class="card summary-card${isAI ? ' is-ai' : ''}">
      <div class="summary-top">
        <span class="summary-label">${isAI ? `${ICONS.sparkle} AI recommendation` : 'Best matches'}</span>
        <div class="summary-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-action="map-top">${ICONS.map} Top pick on map</button>
          <button class="btn btn-ghost btn-sm" type="button" data-action="open-chat">Ask a follow-up</button>
        </div>
      </div>
      <p class="summary-text">${escapeHTML(data.summary)}</p>
    </div>` : ''}`;
}

function sortMore(items, by) {
  const sorted = [...items];
  const sorters = {
    'price-asc': (a, b) => a.listing.price - b.listing.price,
    'price-desc': (a, b) => b.listing.price - a.listing.price,
    yield: (a, b) => b.listing.rentalYield - a.listing.rentalYield,
    size: (a, b) => b.listing.sqft - a.listing.sqft,
    distance: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
  };
  if (sorters[by]) sorted.sort(sorters[by]);
  return sorted;
}

function renderMore() {
  const section = $('#more-section');
  section.hidden = !state.more.length;
  if (!state.more.length) return;
  const sortSelect = $('#more-sort');
  sortSelect.querySelector('option[value="distance"]').hidden = !state.prefs?.near;
  if (!state.prefs?.near && sortSelect.value === 'distance') sortSelect.value = 'match';
  $('#more-title').textContent = `More homes that fit (${state.more.length})`;
  setGrid($('#more-grid'), sortMore(state.more, sortSelect.value).map((item) => homeCard(item)).join(''));
}

function renderResults() {
  setGrid($('#results-grid'), state.results.length
    ? state.results.map((item, i) => homeCard(item, i + 1)).join('')
    : emptyState('No homes found', 'Remove one of the requirements above to widen the search.'));
  renderMore();
  renderResultsMap();
}

function renderLoading(message) {
  $('#summary').innerHTML = `<p class="thinking"><span class="spinner"></span>${escapeHTML(message)}</p>`;
  $('#results-map-wrap').hidden = true;
  $('#more-section').hidden = true;
  const skeleton = `
    <div class="card home-card skeleton" aria-hidden="true">
      <div class="home-media"></div>
      <div class="home-body">
        <div class="sk-line" style="width:45%;height:20px"></div>
        <div class="sk-line" style="width:80%"></div>
        <div class="sk-line" style="width:60%"></div>
        <div class="sk-line" style="width:90%"></div>
      </div>
    </div>`;
  $('#results-grid').innerHTML = skeleton.repeat(6);
}

const allResults = () => [...state.results, ...state.more];

function renderSaved() {
  const items = [...state.saved]
    .map((id) => allResults().find((r) => r.listing.id === id) || (state.byId.has(id) && { listing: state.byId.get(id) }))
    .filter(Boolean);
  setGrid($('#saved-grid'), items.length
    ? items.map((item) => homeCard(item)).join('')
    : emptyState('No saved homes yet', 'Tap the heart on any home to keep it here.'));
}

function renderStatus(ai) {
  const el = $('#ai-status');
  el.classList.toggle('is-on', ai.configured);
  el.classList.toggle('is-off', !ai.configured);
  $('.label', el).textContent = ai.configured ? 'AI ready' : 'AI offline';
  el.title = ai.configured ? `Model: ${ai.model}` : 'Add GROQ_API_KEY to .env and restart the server';
}

function updateSavedCount(bump = false) {
  const count = $('#saved-count');
  count.textContent = state.saved.size;
  if (bump) {
    count.classList.remove('bump');
    void count.offsetWidth; // restart the animation
    count.classList.add('bump');
  }
}

let toastTimer;
function showToast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${kind === 'error' ? ' is-error' : ''}${kind === 'warn' ? ' is-warn' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

function focusCard(id) {
  const card = $(`#results-view .home-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('is-flash');
  void card.offsetWidth;
  card.classList.add('is-flash');
}

// ---------------------------------------------------------------------------
// Google Maps
// ---------------------------------------------------------------------------

// Keyless Google Maps embeds work without any setup, so every home always has a map.
const embed = (params) => `https://maps.google.com/maps?${new URLSearchParams({ ...params, output: 'embed' })}`;

function embedUrl(l, mode, { from = '', query = '' } = {}) {
  const destination = `${l.lat},${l.lng}`;
  if (mode === 'directions' && from) return embed({ saddr: from, daddr: destination });
  if (mode === 'nearby') return embed({ q: `${query} near ${l.project}, ${l.community}, Abu Dhabi`, z: 14 });
  return embed({ q: destination, z: 15 });
}

function updateMapLinks(l, from) {
  const destination = `${l.lat},${l.lng}`;
  $('#open-gmaps').href = `https://www.google.com/maps/search/?${new URLSearchParams({ api: 1, query: destination })}`;
  const params = { api: 1, destination, travelmode: 'driving' };
  if (from) params.origin = from;
  $('#open-directions').href = `https://www.google.com/maps/dir/?${new URLSearchParams(params)}`;
}

function setMapMode(mode, query = '') {
  const l = state.mapListing;
  if (!l) return;
  const from = $('#directions-from').value.trim();
  if (mode === 'directions' && !from) {
    const input = $('#directions-from');
    input.focus();
    input.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 300 });
    showToast('Type where you are starting from, or tap "Use my location".');
    return;
  }
  for (const btn of $$('.map-mode')) {
    btn.classList.toggle('is-active', btn.dataset.mode === mode && (btn.dataset.query || '') === query);
  }
  $('#map-frame').src = embedUrl(l, mode, { from, query });
  updateMapLinks(l, mode === 'directions' ? from : '');
}

function openMap(id, mode = 'place') {
  const l = state.byId.get(id);
  if (!l) return;
  state.mapListing = l;
  $('#map-title').textContent = l.title;
  $('#map-subtitle').textContent = `${l.project}, ${l.community} · ${shortAed(l.price)} · ${l.commuteMinutes} min drive to ${l.commuteTo}`;
  $('#directions-from').value = readJSON(ORIGIN_KEY, '') || '';
  const dialog = $('#map-dialog');
  if (!dialog.open) dialog.showModal();
  setMapMode(mode === 'directions' && !$('#directions-from').value ? 'place' : mode);
}

function closeMap() {
  const dialog = $('#map-dialog');
  if (dialog.open) dialog.close();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    showToast('Your browser cannot share its location.', 'warn');
    return;
  }
  const btn = $('#use-location');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      btn.disabled = false;
      $('#directions-from').value = `${coords.latitude.toFixed(5)},${coords.longitude.toFixed(5)}`;
      setMapMode('directions');
    },
    () => {
      btn.disabled = false;
      showToast('Location access was blocked. Type a starting point instead.', 'warn');
    },
    { timeout: 10000 },
  );
}

// Optional interactive results map with price pins (needs GOOGLE_MAPS_API_KEY in .env).
let mapsLoader = null;
function loadGoogleMaps(key) {
  mapsLoader ??= new Promise((resolve, reject) => {
    window.__homematchMapsReady = () => resolve(window.google.maps);
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${new URLSearchParams({
      key, v: 'weekly', loading: 'async', callback: '__homematchMapsReady',
    })}`;
    script.async = true;
    script.onerror = () => {
      mapsLoader = null;
      reject(new Error('Could not load Google Maps.'));
    };
    document.head.append(script);
  });
  return mapsLoader;
}

let mapRenderId = 0;
async function renderResultsMap() {
  const wrap = $('#results-map-wrap');
  state.pins.clear();
  if (!state.maps.key || !allResults().length) {
    wrap.hidden = true;
    return;
  }
  const renderId = ++mapRenderId;
  wrap.hidden = false;
  try {
    const maps = await loadGoogleMaps(state.maps.key);
    const [{ Map: GoogleMap }, { AdvancedMarkerElement }] = await Promise.all([
      maps.importLibrary('maps'), maps.importLibrary('marker'),
    ]);
    if (renderId !== mapRenderId) return; // a newer search started meanwhile

    const map = new GoogleMap($('#results-map'), {
      mapId: state.maps.mapId,
      colorScheme: root.dataset.theme === 'dark' ? 'DARK' : 'LIGHT',
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'cooperative',
    });
    const bounds = new maps.LatLngBounds();
    for (const { listing: l } of allResults()) {
      const pin = document.createElement('div');
      pin.className = 'price-pin';
      pin.textContent = shortAed(l.price).replace('AED ', '');
      const position = { lat: l.lat, lng: l.lng };
      const marker = new AdvancedMarkerElement({ map, position, content: pin, title: l.title });
      marker.addListener('click', () => focusCard(l.id));
      state.pins.set(l.id, pin);
      bounds.extend(position);
    }
    map.fitBounds(bounds, 60);
    if (allResults().length === 1) maps.event.addListenerOnce(map, 'idle', () => map.setZoom(14));
  } catch (err) {
    console.warn(err);
    wrap.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const systemDark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  root.dataset.theme = theme;
  const next = theme === 'dark' ? 'light' : 'dark';
  $('#theme-toggle').setAttribute('aria-label', `Switch to ${next} theme`);
}

function toggleTheme() {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  store(THEME_KEY, next);
  const swap = () => {
    applyTheme(next);
    if (!$('#results-map-wrap').hidden) renderResultsMap(); // map colours are fixed at creation
  };

  if (!document.startViewTransition || reduceMotion) {
    swap();
    return;
  }
  // Circular reveal expanding from the toggle button.
  const rect = $('#theme-toggle').getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.style.setProperty('--vt-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);

  // Some embedded browsers never run the transition callback; make sure the theme still changes.
  let swapped = false;
  const swapOnce = () => {
    if (swapped) return;
    swapped = true;
    swap();
  };
  const transition = document.startViewTransition(swapOnce);
  // A skipped transition rejects these promises; that's expected, not an error.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  setTimeout(() => {
    if (swapped) return;
    transition.skipTransition?.();
    swapOnce();
  }, 400);
}

// ---------------------------------------------------------------------------
// Pointer effects: cursor glow, card tilt, magnetic buttons, ripples, hero parallax
// ---------------------------------------------------------------------------

const INTERACTIVE = 'a, button, label.chip, input, select, textarea, summary, .home-card, .pref-tag, .tag';

// If a listing photo can't load, fall back to the illustrated artwork.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('home-photo')) return;
  img.closest('.home-media')?.classList.remove('has-photo');
  img.remove();
}, true);

function setupPointerEffects() {
  // Ripples work for touch too.
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn, .map-mode, .example');
    if (!btn || reduceMotion) return;
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - rect.left - size / 2}px;top:${e.clientY - rect.top - size / 2}px`;
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.append(ripple);
    setTimeout(() => ripple.remove(), 650);
  });

  if (!fancyPointer) return;

  const glow = $('.cursor-glow');
  const ring = $('.cursor-ring');
  const hero = $('.hero');
  const pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  const glowPos = { ...pointer };
  const ringPos = { ...pointer };
  let tiltCard = null;
  let magnet = null;

  const resetTilt = (card) => {
    if (!card) return;
    card.classList.remove('is-tilting');
    card.style.setProperty('--rx', '0deg');
    card.style.setProperty('--ry', '0deg');
    state.pins.get(card.dataset.id)?.classList.remove('is-active');
  };
  const resetMagnet = (el) => { if (el) el.style.translate = ''; };

  document.addEventListener('pointermove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    document.body.classList.add('has-cursor');
    ring.classList.toggle('is-hovering', Boolean(e.target.closest?.(INTERACTIVE)));

    // 3D tilt + spotlight on home cards, and highlight the matching map pin
    const card = e.target.closest?.('.home-card:not(.skeleton)');
    if (card !== tiltCard) {
      resetTilt(tiltCard);
      tiltCard = card;
      if (card) state.pins.get(card.dataset.id)?.classList.add('is-active');
    }
    if (card) {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      card.classList.add('is-tilting');
      card.style.setProperty('--ry', `${(px - 0.5) * 9}deg`);
      card.style.setProperty('--rx', `${(0.5 - py) * 7}deg`);
      card.style.setProperty('--mx', `${px * 100}%`);
      card.style.setProperty('--my', `${py * 100}%`);
    }

    // Magnetic buttons lean towards the cursor
    const el = e.target.closest?.('.magnetic');
    if (el !== magnet) {
      resetMagnet(magnet);
      magnet = el;
    }
    if (el) {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) * 0.25;
      const dy = (e.clientY - (r.top + r.height / 2)) * 0.35;
      el.style.translate = `${dx}px ${dy}px`;
    }

    // Hero background drifts with the cursor
    const hr = hero.getBoundingClientRect();
    if (e.clientY < hr.bottom) {
      hero.style.setProperty('--px', ((e.clientX / innerWidth) - 0.5).toFixed(3));
      hero.style.setProperty('--py', (((e.clientY - hr.top) / hr.height) - 0.5).toFixed(3));
    }
  }, { passive: true });

  document.addEventListener('pointerdown', () => ring.classList.add('is-pressed'));
  document.addEventListener('pointerup', () => ring.classList.remove('is-pressed'));
  document.documentElement.addEventListener('pointerleave', () => {
    document.body.classList.remove('has-cursor');
    resetTilt(tiltCard);
    resetMagnet(magnet);
    tiltCard = null;
    magnet = null;
  });

  // Smoothly trail the cursor: the ring follows closely, the glow lags behind.
  const tick = () => {
    ringPos.x += (pointer.x - ringPos.x) * 0.35;
    ringPos.y += (pointer.y - ringPos.y) * 0.35;
    glowPos.x += (pointer.x - glowPos.x) * 0.12;
    glowPos.y += (pointer.y - glowPos.y) * 0.12;
    ring.style.transform = `translate3d(${ringPos.x}px, ${ringPos.y}px, 0)`;
    glow.style.transform = `translate3d(${glowPos.x}px, ${glowPos.y}px, 0)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Preferences form
// ---------------------------------------------------------------------------

const chip = (name, value, label) => `
  <label class="chip"><input type="checkbox" name="${name}" value="${escapeHTML(value)}"><span>${escapeHTML(label)}</span></label>`;

const LANDMARK_GROUPS = { work: 'Work', school: 'Schools', education: 'Universities', health: 'Hospitals', transport: 'Transport', leisure: 'Leisure & malls' };

function buildForm(meta) {
  const form = $('#prefs-form');
  const options = (entries) => entries.map(([v, label]) => `<option value="${escapeHTML(v)}">${escapeHTML(label)}</option>`).join('');

  // Area picker: one collapsible group per region, with an "all of region" option.
  $('#area-picker').innerHTML = meta.regions.map((region) => {
    const communities = meta.communities.filter((c) => c.region === region);
    return `<details class="area-group">
      <summary>${escapeHTML(region)} <span class="area-count" data-region="${escapeHTML(region)}"></span></summary>
      <div class="chips chips-sm">
        ${chip('regions', region, `All of ${region}`)}
        ${communities.map((c) => chip('communities', c.name, c.freehold ? c.name : `${c.name} *`)).join('')}
      </div>
    </details>`;
  }).join('') + '<p class="muted small area-note">* UAE/GCC nationals only</p>';

  form.elements.nearLandmark.insertAdjacentHTML('beforeend', Object.entries(LANDMARK_GROUPS).map(([kind, label]) => {
    const items = meta.landmarks.filter((l) => l.kind === kind);
    return items.length ? `<optgroup label="${label}">${options(items.map((l) => [l.id, l.name]))}</optgroup>` : '';
  }).join(''));
  form.elements.completion.insertAdjacentHTML('beforeend', options(Object.entries(meta.completion)));
  form.elements.purpose.insertAdjacentHTML('beforeend', options(Object.entries(meta.purposes)));
  $('#type-chips').innerHTML = meta.types.map((t) => chip('types', t, t)).join('');
  $('#priority-chips').innerHTML = Object.entries(meta.priorities).map(([k, label]) => chip('priorities', k, label)).join('');
  $('#feature-chips').innerHTML = meta.features.map((f) => chip('mustHaves', f, f)).join('');
}

function readForm() {
  const data = new FormData($('#prefs-form'));
  const landmark = data.get('nearLandmark');
  const maxBeds = data.get('maxBeds');
  // Requirements the form has no field for (nice-to-haves, strict budget...) carry over from the search.
  const hidden = state.prefs || {};
  return {
    communities: data.getAll('communities'),
    regions: data.getAll('regions'),
    near: landmark ? { landmark, maxKm: Number(data.get('nearKm')) || 10 } : null,
    minPrice: Number(data.get('minPrice')) || 0,
    maxPrice: Number(data.get('maxPrice')) || 0,
    budgetStrict: hidden.budgetStrict || false,
    types: data.getAll('types'),
    minBeds: Number(data.get('minBeds')) || 0,
    maxBeds: maxBeds === '' ? null : Number(maxBeds),
    minBaths: hidden.minBaths || 0,
    minSqft: hidden.minSqft || 0,
    completion: data.get('completion') || '',
    freeholdOnly: data.get('freeholdOnly') === 'on',
    mustHaves: data.getAll('mustHaves'),
    niceToHaves: hidden.niceToHaves || [],
    priorities: data.getAll('priorities'),
    purpose: data.get('purpose') || '',
    notes: String(data.get('notes') || '').trim(),
  };
}

// Selects the largest option that does not exceed `value` (e.g. 8 beds -> "6").
function setSelectAtMost(select, value) {
  const fits = [...select.options].map((o) => o.value).filter((v) => v !== '' && Number(v) <= (Number(value) || 0));
  select.value = fits.length ? String(Math.max(...fits.map(Number))) : select.options[0].value;
}

function fillForm(p) {
  const { elements } = $('#prefs-form');
  elements.nearLandmark.value = p.near?.landmark || '';
  if (p.near) {
    const kms = [...elements.nearKm.options].map((o) => Number(o.value));
    elements.nearKm.value = String(kms.find((k) => k >= p.near.maxKm) ?? kms.at(-1));
  }
  elements.minPrice.value = p.minPrice || '';
  elements.maxPrice.value = p.maxPrice || '';
  setSelectAtMost(elements.minBeds, p.minBeds);
  if (p.maxBeds === null || p.maxBeds === undefined) elements.maxBeds.value = '';
  else setSelectAtMost(elements.maxBeds, p.maxBeds);
  elements.completion.value = p.completion || '';
  elements.purpose.value = p.purpose || '';
  elements.freeholdOnly.checked = Boolean(p.freeholdOnly);
  elements.notes.value = p.notes || '';
  for (const box of $$('#prefs-form .chip input[type="checkbox"]')) {
    box.checked = (p[box.name] || []).includes(box.value);
  }
  // Open the region groups that contain a selection, and show how many are picked.
  for (const group of $$('.area-group')) {
    const picked = $$('input:checked', group).length;
    group.open = picked > 0;
    $('.area-count', group).textContent = picked ? `(${picked})` : '';
  }
}

// ---------------------------------------------------------------------------
// Search flow
// ---------------------------------------------------------------------------

function setBusy(busy) {
  state.busy = busy;
  for (const btn of $$('#ai-search button, #prefs-form button[type="submit"]')) btn.disabled = busy;
}

function setView(view) {
  state.view = view;
  $('#results-view').hidden = view !== 'results';
  $('#saved-view').hidden = view !== 'saved';
  for (const tab of $$('.tab')) tab.classList.toggle('is-active', tab.dataset.view === view);
  if (view === 'saved') renderSaved();
}

// After a search, the search box refines it ("cheaper", "add townhouses") until a new search starts.
function setRefining(on) {
  state.refining = on;
  $('#refine-hint').hidden = !on;
  $('#ai-query').placeholder = on
    ? 'Refine: e.g. "under 3M instead", "add townhouses", "closer to ADGM"'
    : "e.g. 3-bed villa near Cranleigh school, budget 6M, I'm an expat";
}

function startNewSearch() {
  state.prefs = null;
  state.lastResponse = null;
  state.results = [];
  state.more = [];
  setRefining(false);
  $('#prefs-form').reset();
  fillForm({ communities: [], regions: [], types: [], mustHaves: [], priorities: [], maxBeds: null, minBeds: 0 });
  $('#ai-query').value = '';
  $('#ai-query').focus();
  renderWelcome();
}

function restoreResults() {
  if (state.lastResponse) {
    renderSummary(state.lastResponse, state.parseInfo);
    renderResults();
  } else {
    renderWelcome();
  }
}

// `getPrefs` may call the AI (natural-language search) or just read the form.
async function search(getPrefs) {
  if (state.busy || !state.meta) return;
  setBusy(true);
  setView('results');
  $('.layout').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  try {
    const { prefs, parseInfo = null } = await getPrefs();
    renderLoading('Checking every listing against your requirements…');
    const data = await api('/api/recommend', prefs);
    state.lastResponse = data;
    state.parseInfo = parseInfo;
    state.results = data.results;
    state.more = data.more || [];
    state.prefs = data.prefs;
    state.chatFocusId = null;
    fillForm(data.prefs);
    renderSummary(data, parseInfo);
    renderResults();
    setRefining(true);
    if (data.warning) showToast(`AI ranking unavailable, so these are rule-based matches. ${data.warning}`, 'warn');
  } catch (err) {
    restoreResults();
    showToast(err.message, 'error');
  } finally {
    setBusy(false);
  }
}

function searchByText(query) {
  const text = query.trim();
  if (!text) {
    $('#ai-query').focus();
    return;
  }
  const current = state.refining ? state.prefs : null;
  search(async () => {
    renderLoading(current ? 'Updating your search…' : 'Understanding what you need…');
    const parsed = await api('/api/parse', { query: text, current });
    if (parsed.fallback) showToast('The AI is busy, so I used quick keyword matching for this search.', 'warn');
    $('#ai-query').value = '';
    return { prefs: parsed.prefs, parseInfo: parsed };
  });
}

// Removing a requirement chip re-runs the search without it (no AI parsing needed).
function removeChip(index) {
  const chipInfo = state.chips?.[index];
  if (!chipInfo || !state.prefs) return;
  const prefs = { ...state.prefs, ...chipInfo.change };
  search(async () => ({ prefs, parseInfo: null }));
}

function toggleSave(id, button) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  store(SAVED_KEY, [...state.saved]);
  updateSavedCount(true);

  const saved = state.saved.has(id);
  for (const btn of $$(`.home-card[data-id="${CSS.escape(id)}"] [data-action="save"]`)) {
    btn.setAttribute('aria-pressed', saved);
    btn.setAttribute('aria-label', saved ? 'Remove from saved' : 'Save home');
    btn.innerHTML = saved ? ICONS.heart : ICONS.heartOutline;
  }
  button?.classList.remove('is-popping');
  void button?.offsetWidth;
  button?.classList.add('is-popping');
  if (state.view === 'saved') renderSaved();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function chatSuggestions() {
  if (!state.results.length && !state.saved.size) {
    return ['Where can expats buy in Abu Dhabi?', 'Ready or off-plan: which is better for me?', 'Which areas give the best rental yields?'];
  }
  return ['Which home is the best fit for me?', 'Compare the top two homes', 'Which one has the best rental yield?', 'What should I ask at a viewing?'];
}

function chatContextIds() {
  const ids = state.view === 'saved' ? [...state.saved] : state.results.map((r) => r.listing.id);
  if (!ids.length) ids.push(...state.saved);
  if (state.chatFocusId) ids.unshift(state.chatFocusId);
  return [...new Set(ids)].slice(0, 6);
}

function renderChat(typing = false) {
  const log = $('#chat-log');
  const intro = `<div class="msg msg-assistant"><p>Marhaba! I'm your HomeMatch assistant. I can compare the homes on screen, explain freehold vs nationals-only areas, service charges, yields and off-plan vs ready, or suggest what to ask at a viewing.</p></div>`;
  const suggestions = state.chat.length ? '' : `<div class="suggestions">${chatSuggestions()
    .map((s) => `<button type="button" data-suggest="${escapeHTML(s)}">${escapeHTML(s)}</button>`).join('')}</div>`;
  const messages = state.chat.map((m) => `<div class="msg msg-${m.role}">${
    m.role === 'assistant' ? renderMarkdown(m.content) : `<p>${escapeHTML(m.content)}</p>`}</div>`).join('');
  const dots = typing ? '<div class="msg msg-assistant typing" aria-label="Assistant is typing"><i></i><i></i><i></i></div>' : '';
  log.innerHTML = intro + suggestions + messages + dots;
  log.scrollTop = log.scrollHeight;
}

function openChat() {
  $('#chat').hidden = false;
  $('#chat-toggle').hidden = true;
  $('#chat-toggle').setAttribute('aria-expanded', 'true');
  renderChat(state.chatBusy);
  $('#chat-input').focus();
}

function closeChat() {
  $('#chat').hidden = true;
  $('#chat-toggle').hidden = false;
  $('#chat-toggle').setAttribute('aria-expanded', 'false');
}

async function sendChat(message) {
  const text = message.trim();
  if (!text || state.chatBusy) return;
  state.chatBusy = true;
  state.chat.push({ role: 'user', content: text });
  renderChat(true);
  try {
    const { reply } = await api('/api/chat', {
      messages: state.chat,
      listingIds: chatContextIds(),
      prefs: state.prefs || readForm(),
    });
    state.chat.push({ role: 'assistant', content: reply });
  } catch (err) {
    state.chat.pop();
    $('#chat-input').value = text;
    showToast(err.message, 'error');
  } finally {
    state.chatBusy = false;
    renderChat();
  }
}

function askAboutHome(id) {
  const listing = state.byId.get(id);
  if (!listing) return;
  state.chatFocusId = id;
  openChat();
  sendChat(`Tell me about "${listing.title}". Is it a good fit for me, and what should I watch out for?`);
}

// ---------------------------------------------------------------------------
// Events & startup
// ---------------------------------------------------------------------------

const narrowScreen = matchMedia('(max-width: 960px)');
const isNarrow = () => narrowScreen.matches;

// Filters are always open on wide screens and start collapsed on narrow ones.
function syncFiltersPanel() {
  $('#filters').open = !isNarrow();
}

function bindEvents() {
  $('#ai-search').addEventListener('submit', (e) => {
    e.preventDefault();
    searchByText($('#ai-query').value);
  });

  for (const btn of $$('.example')) {
    btn.addEventListener('click', () => {
      $('#ai-query').value = btn.textContent;
      searchByText(btn.textContent);
    });
  }

  $('#prefs-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search(async () => ({ prefs: readForm() }));
  });

  // The filters panel only collapses on narrow screens.
  $('#filters summary').addEventListener('click', (e) => {
    if (!isNarrow()) e.preventDefault();
  });

  for (const tab of $$('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));

  // Requirement chips: click to remove that requirement and search again.
  $('#summary').addEventListener('click', (e) => {
    const chipBtn = e.target.closest('[data-chip]');
    if (chipBtn && !state.busy) removeChip(Number(chipBtn.dataset.chip));
  });
  $('#more-sort').addEventListener('change', renderMore);
  $('#prefs-form').addEventListener('reset', () => {
    // Also forget requirements that have no form field (nice-to-haves, strict budget).
    if (state.prefs) state.prefs = { ...state.prefs, niceToHaves: [], budgetStrict: false, minBaths: 0, minSqft: 0 };
    setTimeout(() => fillForm({ communities: [], regions: [], types: [], mustHaves: [], priorities: [], minBeds: 0, maxBeds: null }));
  });
  $('#area-picker').addEventListener('change', () => {
    for (const group of $$('.area-group')) {
      const picked = $$('input:checked', group).length;
      $('.area-count', group).textContent = picked ? `(${picked})` : '';
    }
  });
  $('#theme-toggle').addEventListener('click', toggleTheme);

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = target.closest('.home-card')?.dataset.id;
    const action = target.dataset.action;
    if (action === 'save' && id) toggleSave(id, target);
    else if (action === 'ask' && id) askAboutHome(id);
    else if (action === 'map' && id) openMap(id);
    else if (action === 'map-top' && state.results[0]) openMap(state.results[0].listing.id);
    else if (action === 'open-chat') openChat();
    else if (action === 'new-search') startNewSearch();
  });

  // Map dialog
  const dialog = $('#map-dialog');
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close-dialog]')) closeMap();
    const mode = e.target.closest('.map-mode');
    if (mode) setMapMode(mode.dataset.mode, mode.dataset.query || '');
  });
  dialog.addEventListener('close', () => {
    $('#map-frame').src = 'about:blank';
    state.mapListing = null;
  });
  $('#directions-form').addEventListener('submit', (e) => {
    e.preventDefault();
    store(ORIGIN_KEY, $('#directions-from').value.trim());
    setMapMode('directions');
  });
  $('#use-location').addEventListener('click', useMyLocation);

  // Chat
  $('#chat-toggle').addEventListener('click', openChat);
  $('#chat-close').addEventListener('click', closeChat);
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value;
    input.value = '';
    sendChat(text);
  });
  $('#chat-log').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-suggest]');
    if (btn) sendChat(btn.dataset.suggest);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#chat').hidden && !dialog.open) closeChat();
  });

  // Follow the OS theme until the user picks one with the toggle.
  systemDark.addEventListener('change', (e) => {
    if (!readJSON(THEME_KEY, null)) applyTheme(e.matches ? 'dark' : 'light');
  });
  narrowScreen.addEventListener('change', syncFiltersPanel);
}

async function init() {
  applyTheme(root.dataset.theme || 'light');
  bindEvents();
  setupPointerEffects();
  updateSavedCount();
  syncFiltersPanel();

  try {
    const [meta, health] = await Promise.all([api('/api/listings'), api('/api/health')]);
    state.meta = meta;
    state.maps = health.maps || state.maps;
    state.byId = new Map(meta.listings.map((l) => [l.id, l]));
    for (const id of state.saved) if (!state.byId.has(id)) state.saved.delete(id);
    updateSavedCount();
    buildForm(meta);
    renderStatus(health.ai);
    renderWelcome();
  } catch (err) {
    renderStatus({ configured: false });
    $('#results-grid').innerHTML = emptyState('Could not load homes', err.message);
  }
}

init();
