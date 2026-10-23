// Generates the sample Abu Dhabi listings: node scripts/generate-abu-dhabi.js
// Output is deterministic (seeded), so re-running it gives the same data.
//   data/listings.json      the listings the app serves
//   data/communities.json   community metadata (region, aliases, freehold) used by search
// Photos come from data/community-photos.json (freely licensed, picked per community).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { COMMUNITIES, REGIONS } from './abu-dhabi-communities.js';

const root = new URL('../', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const write = (path, data) => writeFileSync(new URL(path, root), `${compactJSON(data)}\n`);

// Keep short string arrays on one line so the file stays readable.
function compactJSON(data) {
  return JSON.stringify(data, null, 2)
    .replace(/\[\n\s+("[^\]]*?")\n\s+\]/g, (_, inner) => `[${inner.replace(/,\n\s+/g, ', ')}]`);
}

// Small seeded PRNG (mulberry32) for reproducible data.
let seed = 20261023;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = ([a, b]) => a + rand() * (b - a);
const intBetween = (a, b) => Math.floor(a + rand() * (b - a + 1));
const roundTo = (n, step) => Math.round(n / step) * step;
const pick = (items) => items[Math.floor(rand() * items.length)];
function weighted(table) {
  const entries = Object.entries(table);
  let r = rand() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [value, w] of entries) if ((r -= w) <= 0) return Number(value);
  return Number(entries.at(-1)[0]);
}

const BEDS = {
  Apartment: { 0: 0.12, 1: 0.36, 2: 0.32, 3: 0.2 },
  Penthouse: { 3: 0.4, 4: 0.4, 5: 0.2 },
  Townhouse: { 2: 0.2, 3: 0.5, 4: 0.3 },
  Villa: { 3: 0.18, 4: 0.34, 5: 0.3, 6: 0.12, 7: 0.06 },
};
const SQFT = {
  Apartment: { 0: [400, 520], 1: [700, 920], 2: [1100, 1450], 3: [1550, 2050] },
  Penthouse: { 3: [3000, 3800], 4: [3800, 5000], 5: [5000, 7000] },
  Townhouse: { 2: [1500, 1900], 3: [1900, 2500], 4: [2500, 3200] },
  Villa: { 3: [2800, 3500], 4: [3500, 4600], 5: [4600, 6000], 6: [6000, 8000], 7: [8000, 11000] },
};
const LUXURY = new Set(['Nurai Island', 'Ramhan Island', 'Al Hudayriyat Island', 'Al Jubail Island', 'Saadiyat Island', 'Al Bateen']);
const HIGHLIGHTS = ['Private pool', 'Beach access', 'Sea view', 'Golf course view', 'Canal view', 'Mangrove view', 'Skyline view', 'Rooftop terrace', 'Private garden', "Maid's room", 'Study'];

const DOWNTOWN = { lat: 24.487, lng: 54.357 };
const AL_AIN = { lat: 24.2217, lng: 55.782 };
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function typeFeatures(type, beds, community) {
  const f = new Set();
  const chance = (p) => rand() < p;
  if (type === 'Apartment' || type === 'Penthouse') {
    if (chance(0.85)) f.add('Balcony');
    if (chance(0.9)) f.add('Shared pool');
    if (chance(0.9)) f.add('Gym');
    if (chance(0.95)) f.add('Covered parking');
    if (chance(0.3)) f.add('Chiller free');
    if (beds >= 3 && chance(0.6)) f.add("Maid's room");
    if (type === 'Penthouse') {
      f.add('Rooftop terrace');
      if (chance(0.5)) f.add('Private pool');
      if (chance(0.6)) f.add('Concierge');
    }
  } else {
    f.add('Covered parking');
    if (chance(type === 'Villa' ? 0.85 : 0.7)) f.add('Private garden');
    if (beds >= 3 && chance(type === 'Villa' ? 0.85 : 0.55)) f.add("Maid's room");
    if (type === 'Villa' && beds >= 5 && chance(0.55)) f.add("Driver's room");
    if (type === 'Villa' && chance(LUXURY.has(community.name) ? 0.75 : 0.3)) f.add('Private pool');
    if (chance(0.3)) f.add('Study');
    if (chance(0.25)) f.add('Rooftop terrace');
  }
  for (const [feature, p] of Object.entries(community.features)) {
    // Majlis and driver's rooms only make sense in villas.
    if ((feature === 'Majlis' || feature === "Driver's room") && type !== 'Villa') continue;
    if (chance(p)) f.add(feature);
  }
  return [...f];
}

function completionFor(project) {
  if (rand() >= project.offplan) return null;
  return `Q${intBetween(1, 4)} ${intBetween(2027, 2029)}`;
}

// "Khalifa City Villas" reads badly in "Villa in Khalifa City Villas"; use the area name instead.
function placeName(project, community) {
  const stripped = project.name.replace(/ (Villas|Towers|Residences)$/, '');
  const known = [community.name, ...community.aliases].map((n) => n.toLowerCase());
  return known.some((n) => n.includes(stripped.toLowerCase()) || stripped.toLowerCase().includes(n)) ? stripped : project.name;
}

function titleFor(type, beds, project, community, features) {
  const size = beds === 0 ? 'Studio' : `${beds}-Bed`;
  const highlight = HIGHLIGHTS.find((h) => features.includes(h));
  const what = beds === 0 ? 'Apartment' : type;
  return `${size} ${what} in ${placeName(project, community)}${highlight ? ` with ${highlight.toLowerCase()}` : ''}`;
}

function describe(listing, community, project) {
  const status = listing.completion === 'Ready'
    ? `Ready-to-move ${listing.type.toLowerCase()}`
    : `Off-plan ${listing.type.toLowerCase()} (handover ${listing.completion})`;
  const where = project.name === community.name ? community.name : `${project.name}, ${community.name}`;
  const top = listing.features.filter((f) => !['Covered parking', 'Gym', 'Shared pool', 'Balcony'].includes(f)).slice(0, 3);
  const highlights = top.length ? ` Highlights: ${top.join(', ').toLowerCase()}.` : '';
  return `${status} in ${where}. ${community.blurb}${highlights}`;
}

const photos = existsSync(new URL('data/community-photos.json', root)) ? read('data/community-photos.json') : {};
const listings = [];

for (const community of COMMUNITIES) {
  const communityPhotos = photos[community.name] || [];
  for (let i = 0; i < community.count; i++) {
    // Spread listings across projects before repeating one.
    const project = community.projects[i % community.projects.length];
    const type = pick(project.types);
    const beds = weighted(BEDS[type]);
    let sqft = between(SQFT[type][beds]);
    if (type === 'Villa' && LUXURY.has(community.name)) sqft *= 1.2;
    sqft = roundTo(sqft, 10);

    const price = roundTo(sqft * between(community.ppsf[type]), 5000);
    const completionQuarter = completionFor(project);
    const yearBuilt = completionQuarter
      ? Number(completionQuarter.slice(-4))
      : intBetween(...community.built.map((y) => Math.min(y, 2026)));
    const position = {
      lat: +(project.lat + (rand() - 0.5) * 0.006).toFixed(5),
      lng: +(project.lng + (rand() - 0.5) * 0.006).toFixed(5),
    };
    const hub = community.region === 'alain' ? AL_AIN : DOWNTOWN;
    const features = typeFeatures(type, beds, community).sort();

    const listing = {
      id: `auh-${String(listings.length + 1).padStart(3, '0')}`,
      title: titleFor(type, beds, project, community, features),
      emirate: 'Abu Dhabi',
      region: REGIONS[community.region],
      community: community.name,
      project: project.name,
      type,
      price,
      beds,
      baths: beds === 0 ? 1 : Math.min(beds + (rand() < 0.7 ? 1 : 0), 8),
      sqft,
      yearBuilt,
      completion: completionQuarter || 'Ready',
      freehold: community.freehold,
      schoolRating: Math.min(10, Math.max(4, community.schoolRating + (rand() < 0.25 ? -1 : 0))),
      walkScore: Math.round(between(community.walkScore)),
      commuteMinutes: Math.round(distanceKm(position, hub) * 1.15 + 6),
      commuteTo: community.region === 'alain' ? 'Al Ain city centre' : 'Downtown Abu Dhabi',
      serviceCharge: roundTo(sqft * between(community.sc[type]), 500),
      rentalYield: +between(community.yield).toFixed(1),
      lat: position.lat,
      lng: position.lng,
      features,
      description: '',
    };
    listing.description = describe(listing, community, project);
    if (communityPhotos.length) listing.image = communityPhotos[i % communityPhotos.length];
    listings.push(listing);
  }
}

const communities = COMMUNITIES.map((c) => ({
  name: c.name,
  region: REGIONS[c.region],
  freehold: c.freehold,
  aliases: c.aliases,
  projects: c.projects.map((p) => p.name),
}));

write('data/listings.json', listings);
write('data/communities.json', communities);

const withPhotos = listings.filter((l) => l.image).length;
console.log(`Generated ${listings.length} listings in ${communities.length} communities (${withPhotos} with photos).`);
