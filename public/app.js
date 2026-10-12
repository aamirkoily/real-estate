// HomeMatch AI - frontend.
// The browser only talks to our own server; the Groq API key never reaches this file.

const SAVED_KEY = 'homematch:saved';

const state = {
  meta: null, // { listings, cities, types, features, priorities, loan }
  byId: new Map(),
  results: [], // [{ listing, matchScore, headline, pros, cons }]
  prefs: null, // preferences used for the last search
  lastResponse: null,
  saved: new Set(readSaved()),
  chat: [], // [{ role, content }]
  chatFocusId: null,
  chatBusy: false,
  view: 'results',
  busy: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const shortUsd = (n) => (n >= 1e6 ? `$${+(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);

function readSaved() {
  try {
    const ids = JSON.parse(localStorage.getItem(SAVED_KEY));
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function writeSaved() {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify([...state.saved]));
  } catch { /* storage unavailable (private mode) - saving still works for this visit */ }
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
  return (principal * r) / (1 - (1 + r) ** -n) + (listing.hoa || 0);
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
};

function artSVG(type) {
  const shade = 'rgba(0,0,0,.16)';
  let shapes = '';

  if (type === 'Townhouse') {
    shapes = [0, 1, 2].map((i) => {
      const x = 40 + i * 40;
      return `<path d="M${x} 50L${x + 20} 24L${x + 40} 50V100H${x}Z" fill="currentColor" opacity="${i === 1 ? 1 : 0.82}"/>
        <rect x="${x + 12}" y="56" width="16" height="12" rx="1.5" fill="${shade}"/>
        <rect x="${x + 14}" y="78" width="12" height="22" rx="1.5" fill="${shade}"/>`;
    }).join('');
  } else if (type === 'Condo' || type === 'Apartment') {
    const towers = type === 'Apartment' ? [[56, 8, 52], [114, 34, 34]] : [[70, 18, 60]]; // [x, top, width]
    shapes = towers.map(([x, top, width]) => {
      const cols = Math.floor((width - 6) / 13);
      const startX = x + (width - cols * 13 + 5) / 2;
      let windows = '';
      for (let y = top + 8; y <= 76; y += 13) {
        for (let c = 0; c < cols; c++) {
          windows += `<rect x="${startX + c * 13}" y="${y}" width="8" height="8" rx="1" fill="${shade}"/>`;
        }
      }
      return `<rect x="${x}" y="${top}" width="${width}" height="${100 - top}" rx="2" fill="currentColor"/>${windows}
        <rect x="${x + width / 2 - 7}" y="88" width="14" height="12" fill="${shade}"/>`;
    }).join('');
  } else {
    shapes = `<rect x="128" y="20" width="12" height="22" fill="currentColor"/>
      <path d="M40 52L100 14L160 52V100H40Z" fill="currentColor"/>
      <rect x="88" y="66" width="24" height="34" rx="2" fill="${shade}"/>
      <rect x="54" y="60" width="22" height="18" rx="2" fill="${shade}"/>
      <rect x="124" y="60" width="22" height="18" rx="2" fill="${shade}"/>`;
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
  const loan = state.meta.loan;
  let scoreClass = '';
  if (item.matchScore >= 80) scoreClass = 'is-great';
  else if (item.matchScore < 60) scoreClass = 'is-low';

  return `
  <article class="card home-card" data-id="${escapeHTML(l.id)}">
    <div class="home-media" data-type="${escapeHTML(l.type)}">
      ${artSVG(l.type)}
      <div class="badges">
        <span class="badge">${escapeHTML(l.type)}</span>
        ${rank === 1 ? '<span class="badge badge-top">Top pick</span>' : ''}
      </div>
      <button class="save-btn" type="button" data-action="save" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save home'}">
        ${saved ? ICONS.heart : ICONS.heartOutline}
      </button>
      ${hasScore ? `<div class="match ${scoreClass}" style="--p:${item.matchScore}" title="Match score"><span>${item.matchScore}<small>match</small></span></div>` : ''}
    </div>
    <div class="home-body">
      <div class="price">${usd(l.price)}
        <span class="monthly" title="Estimate: ${loan.downPayment * 100}% down, ${loan.annualRate * 100}% ${loan.years}-year fixed, plus HOA. Excludes taxes and insurance.">≈ ${usd(monthlyCost(l))}/mo estimated</span>
      </div>
      <h3>${escapeHTML(l.title)}</h3>
      <p class="location">${escapeHTML(l.neighborhood)} · ${escapeHTML(l.city)}, ${escapeHTML(l.state)}</p>
      <ul class="stats">
        <li><b>${l.beds}</b> bd</li>
        <li><b>${l.baths}</b> ba</li>
        <li><b>${l.sqft.toLocaleString('en-US')}</b> sqft</li>
        <li>Built <b>${l.yearBuilt}</b></li>
      </ul>
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
          <dt>School rating</dt><dd>${l.schoolRating}/10</dd>
          <dt>Walk Score</dt><dd>${l.walkScore}</dd>
          <dt>Commute downtown</dt><dd>${l.commuteMinutes} min</dd>
          <dt>HOA</dt><dd>${l.hoa ? `${usd(l.hoa)}/mo` : 'None'}</dd>
          <dt>Price / sqft</dt><dd>${usd(l.price / l.sqft)}</dd>
        </dl>
      </details>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm btn-block" type="button" data-action="ask">${ICONS.sparkle} Ask AI about this home</button>
      </div>
    </div>
  </article>`;
}

function emptyState(title, text) {
  return `<div class="card empty-state"><h2>${escapeHTML(title)}</h2><p>${escapeHTML(text)}</p></div>`;
}

function renderWelcome() {
  $('#summary').innerHTML = `
    <div class="steps">
      <div class="card step"><b>1</b><h3>Describe it</h3><p>Type what you want above, or set filters on the left.</p></div>
      <div class="card step"><b>2</b><h3>AI ranks homes</h3><p>Every match gets a score with honest pros and cons.</p></div>
      <div class="card step"><b>3</b><h3>Ask follow-ups</h3><p>Chat with the assistant to compare homes and plan viewings.</p></div>
    </div>
    <div class="section-head">
      <h2>Featured homes</h2>
      <p class="muted">A taste of what's listed. Search to get personalized matches.</p>
    </div>`;
  const featured = state.meta.listings.filter((_, i) => i % 5 === 0).slice(0, 6);
  $('#results-grid').innerHTML = featured.map((listing) => homeCard({ listing })).join('');
}

function prefTags(p) {
  if (!p) return [];
  const tags = [p.city || 'Any city'];
  if (p.minPrice && p.maxPrice) tags.push(`${shortUsd(p.minPrice)} – ${shortUsd(p.maxPrice)}`);
  else if (p.maxPrice) tags.push(`Up to ${shortUsd(p.maxPrice)}`);
  else if (p.minPrice) tags.push(`From ${shortUsd(p.minPrice)}`);
  if (p.types.length) tags.push(p.types.join(' / '));
  if (p.minBeds) tags.push(`${p.minBeds}+ beds`);
  if (p.minBaths) tags.push(`${p.minBaths}+ baths`);
  tags.push(...p.mustHaves, ...p.priorities.map((k) => state.meta?.priorities[k] || k));
  return tags;
}

function renderSummary(data) {
  const isAI = data.source === 'ai';
  $('#summary').innerHTML = `
    <div class="card summary-card${isAI ? ' is-ai' : ''}">
      <div class="summary-top">
        <span class="summary-label">${isAI ? `${ICONS.sparkle} AI summary` : 'Quick matches'}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="open-chat">Ask a follow-up</button>
      </div>
      <p class="summary-text">${escapeHTML(data.summary)}</p>
      <div class="pref-tags">${prefTags(data.prefs).map((t) => `<span class="pref-tag">${escapeHTML(t)}</span>`).join('')}</div>
    </div>`;
}

function renderResults() {
  $('#results-grid').innerHTML = state.results.length
    ? state.results.map((item, i) => homeCard(item, i + 1)).join('')
    : emptyState('No homes found', 'Try a different city, a higher budget or fewer must-haves.');
}

function renderLoading(message) {
  $('#summary').innerHTML = `<p class="thinking"><span class="spinner"></span>${escapeHTML(message)}</p>`;
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

function renderSaved() {
  const items = [...state.saved]
    .map((id) => state.results.find((r) => r.listing.id === id) || (state.byId.has(id) && { listing: state.byId.get(id) }))
    .filter(Boolean);
  $('#saved-grid').innerHTML = items.length
    ? items.map((item) => homeCard(item)).join('')
    : emptyState('No saved homes yet', 'Tap the heart on any home to keep it here.');
}

function renderStatus(ai) {
  const el = $('#ai-status');
  el.classList.toggle('is-on', ai.configured);
  el.classList.toggle('is-off', !ai.configured);
  $('.label', el).textContent = ai.configured ? 'AI ready' : 'AI offline';
  el.title = ai.configured ? `Model: ${ai.model}` : 'Add GROQ_API_KEY to .env and restart the server';
}

function updateSavedCount() {
  $('#saved-count').textContent = state.saved.size;
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

// ---------------------------------------------------------------------------
// Preferences form
// ---------------------------------------------------------------------------

const chip = (name, value, label) => `
  <label class="chip"><input type="checkbox" name="${name}" value="${escapeHTML(value)}"><span>${escapeHTML(label)}</span></label>`;

function buildForm(meta) {
  const form = $('#prefs-form');
  form.elements.city.insertAdjacentHTML('beforeend', meta.cities
    .map((c) => `<option value="${escapeHTML(c.city)}">${escapeHTML(c.city)}, ${escapeHTML(c.state)}</option>`).join(''));
  $('#type-chips').innerHTML = meta.types.map((t) => chip('types', t, t)).join('');
  $('#priority-chips').innerHTML = Object.entries(meta.priorities).map(([k, label]) => chip('priorities', k, label)).join('');
  $('#feature-chips').innerHTML = meta.features.map((f) => chip('mustHaves', f, f)).join('');
}

function readForm() {
  const data = new FormData($('#prefs-form'));
  return {
    city: data.get('city') || '',
    minPrice: Number(data.get('minPrice')) || 0,
    maxPrice: Number(data.get('maxPrice')) || 0,
    types: data.getAll('types'),
    minBeds: Number(data.get('minBeds')) || 0,
    minBaths: Number(data.get('minBaths')) || 0,
    mustHaves: data.getAll('mustHaves'),
    priorities: data.getAll('priorities'),
    notes: String(data.get('notes') || '').trim(),
  };
}

// Selects the largest option that does not exceed `value` (e.g. 6 beds -> "5+").
function setSelectAtMost(select, value) {
  const fits = [...select.options].map((o) => Number(o.value)).filter((v) => v <= (Number(value) || 0));
  select.value = String(fits.length ? Math.max(...fits) : 0);
}

function fillForm(p) {
  const { elements } = $('#prefs-form');
  elements.city.value = p.city || '';
  elements.minPrice.value = p.minPrice || '';
  elements.maxPrice.value = p.maxPrice || '';
  setSelectAtMost(elements.minBeds, p.minBeds);
  setSelectAtMost(elements.minBaths, p.minBaths);
  elements.notes.value = p.notes || '';
  for (const box of $$('#prefs-form input[type="checkbox"]')) {
    box.checked = (p[box.name] || []).includes(box.value);
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

function restoreResults() {
  if (state.lastResponse) {
    renderSummary(state.lastResponse);
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
  $('.layout').scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const prefs = await getPrefs();
    renderLoading('Finding and ranking your best matches…');
    const data = await api('/api/recommend', prefs);
    state.lastResponse = data;
    state.results = data.results;
    state.prefs = data.prefs;
    state.chatFocusId = null;
    renderSummary(data);
    renderResults();
    if (data.warning) showToast(`AI ranking unavailable, so these are quick matches. ${data.warning}`, 'warn');
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
  search(async () => {
    renderLoading('Reading your request…');
    const { prefs, unsupportedCity } = await api('/api/parse', { query: text });
    fillForm(prefs);
    if (unsupportedCity) {
      showToast(`We don't have listings in ${unsupportedCity} yet, so we searched every city.`, 'warn');
    }
    return prefs;
  });
}

function toggleSave(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  writeSaved();
  updateSavedCount();

  const saved = state.saved.has(id);
  for (const btn of $$(`.home-card[data-id="${CSS.escape(id)}"] [data-action="save"]`)) {
    btn.setAttribute('aria-pressed', saved);
    btn.setAttribute('aria-label', saved ? 'Remove from saved' : 'Save home');
    btn.innerHTML = saved ? ICONS.heart : ICONS.heartOutline;
  }
  if (state.view === 'saved') renderSaved();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function chatSuggestions() {
  if (!state.results.length && !state.saved.size) {
    return ['Should I buy a condo or a house?', 'What should I look for at a viewing?', 'What costs come with buying a home?'];
  }
  return ['Which home is the best fit for me?', 'Compare the top two homes', 'Which one is the best value?', 'What should I ask at a viewing?'];
}

function chatContextIds() {
  const ids = state.view === 'saved' ? [...state.saved] : state.results.map((r) => r.listing.id);
  if (!ids.length) ids.push(...state.saved);
  if (state.chatFocusId) ids.unshift(state.chatFocusId);
  return [...new Set(ids)].slice(0, 6);
}

function renderChat(typing = false) {
  const log = $('#chat-log');
  const intro = `<div class="msg msg-assistant"><p>Hi! I'm your HomeMatch assistant. I can compare the homes on screen, explain trade-offs, estimate costs or suggest what to ask at a viewing.</p></div>`;
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
    search(async () => readForm());
  });

  // The filters panel only collapses on narrow screens.
  $('#filters summary').addEventListener('click', (e) => {
    if (!isNarrow()) e.preventDefault();
  });

  for (const tab of $$('.tab')) tab.addEventListener('click', () => setView(tab.dataset.view));

  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const id = target.closest('.home-card')?.dataset.id;
    if (target.dataset.action === 'save' && id) toggleSave(id);
    else if (target.dataset.action === 'ask' && id) askAboutHome(id);
    else if (target.dataset.action === 'open-chat') openChat();
  });

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
    if (e.key === 'Escape' && !$('#chat').hidden) closeChat();
  });
}

async function init() {
  bindEvents();
  updateSavedCount();
  syncFiltersPanel();
  narrowScreen.addEventListener('change', syncFiltersPanel);

  try {
    const [meta, health] = await Promise.all([api('/api/listings'), api('/api/health')]);
    state.meta = meta;
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
