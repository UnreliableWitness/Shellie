import { b64url, secretFromLink } from '../../../src/shared/reader';

/**
 * What this phone keeps in the browser's local storage: the secret, the brain last chosen, and the place in each
 * text. All of it stays on the phone. Every key starts with `shellie.reader.`, so "Forget this phone" finds them.
 */

const PREFIX = 'shellie.reader.';
export const SECRET_KEY = `${PREFIX}secret`;
const BRAIN_KEY = `${PREFIX}brain`;
const PLACES_KEY = `${PREFIX}places`;

// Storage can be refused (a private window, a full disk): the site then works for as long as the page is open.
function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function set(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* kept for this page only */
  }
}

type Secret = Uint8Array<ArrayBuffer>;
/** The secret for as long as the page is open, when the browser refuses to store it. */
let unstored: Secret | null = null;

export function storeSecret(secret: Secret) {
  set(SECRET_KEY, b64url(secret));
  unstored = get(SECRET_KEY) ? null : secret;
}

export function loadSecret(): Secret | null {
  const kept = get(SECRET_KEY);
  return (kept ? secretFromLink(kept) : null) ?? unstored;
}

/**
 * The secret in the address, when the page was opened with the link from Shellie: kept, and taken out of the address
 * bar at once, so it is in no history entry, no screenshot and no share sheet.
 */
export function takeSecretFromAddress(): Secret | null {
  const { hash, pathname, search } = window.location;
  if (hash.length < 2) return null;
  const secret = secretFromLink(hash);
  if (!secret) return null;
  history.replaceState(history.state, '', pathname + search);
  storeSecret(secret);
  return secret;
}

export const chosenBrain = () => get(BRAIN_KEY);
export const chooseBrain = (brainId: string) => set(BRAIN_KEY, brainId);

/** How far each text was read, by item id: a fraction from 0 to 1. */
export type Places = Record<string, number>;

export function loadPlaces(): Places {
  try {
    const value: unknown = JSON.parse(get(PLACES_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Places = {};
    for (const [id, f] of Object.entries(value))
      if (typeof f === 'number' && f >= 0 && f <= 1) out[id] = f;
    return out;
  } catch {
    return {};
  }
}

export function savePlace(id: string, fraction: number) {
  const places = loadPlaces();
  places[id] = Math.min(1, Math.max(0, fraction));
  set(PLACES_KEY, JSON.stringify(places));
}

/** Drops the places of items that are no longer on the shelves. */
export function prunePlaces(known: ReadonlySet<string>) {
  const places = loadPlaces();
  const gone = Object.keys(places).filter((id) => !known.has(id));
  if (!gone.length) return;
  for (const id of gone) delete places[id];
  set(PLACES_KEY, JSON.stringify(places));
}

/** Removes everything this site keeps in local storage. */
export function forgetLocal() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    /* nothing was kept */
  }
  unstored = null;
}
