import { readFileSync } from 'node:fs';

// Sample data. Swap data/listings.json for a real feed (MLS, Zillow, etc.) later -
// the rest of the app only depends on the fields used below.
export const listings = JSON.parse(
  readFileSync(new URL('../data/listings.json', import.meta.url), 'utf8'),
);

export const listingsById = new Map(listings.map((l) => [l.id, l]));

export const CITIES = [...new Map(listings.map((l) => [l.city, { city: l.city, state: l.state }])).values()];
export const TYPES = [...new Set(listings.map((l) => l.type))].sort();
export const FEATURES = [...new Set(listings.flatMap((l) => l.features))].sort();

export const PRIORITIES = {
  schools: 'Great schools',
  walkability: 'Walkability',
  commute: 'Short commute',
  space: 'More space',
  value: 'Best value',
  newer: 'Newer build',
};

// Assumptions for the rough monthly cost estimate (shared with the frontend via /api/listings).
export const LOAN = { downPayment: 0.2, annualRate: 0.065, years: 30 };

export function monthlyCost(l) {
  const principal = l.price * (1 - LOAN.downPayment);
  const r = LOAN.annualRate / 12;
  const n = LOAN.years * 12;
  return (principal * r) / (1 - (1 + r) ** -n) + (l.hoa || 0);
}

const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

// One compact line per home keeps AI prompts small (the free tier is token-limited).
export function compactListing(l) {
  return [
    `[${l.id}] ${l.title} - ${l.type} in ${l.neighborhood}, ${l.city} ${l.state}`,
    usd(l.price),
    `${l.beds}bd/${l.baths}ba`,
    `${l.sqft.toLocaleString('en-US')} sqft`,
    `built ${l.yearBuilt}`,
    `schools ${l.schoolRating}/10`,
    `walk score ${l.walkScore}`,
    `${l.commuteMinutes} min to downtown`,
    `HOA ${usd(l.hoa)}/mo`,
    `est. ${usd(monthlyCost(l))}/mo total`,
    l.features.join(', '),
    l.description,
  ].join(' | ');
}
