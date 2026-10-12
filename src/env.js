import { existsSync, readFileSync } from 'node:fs';

// Minimal .env loader so the app needs no npm dependencies.
// Variables already set in the real environment take priority over the file.
export function loadEnv(path) {
  if (!existsSync(path)) return;

  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);

    if (!(key in process.env)) process.env[key] = value;
  }
}
