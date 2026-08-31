/**
 * Typed accessors over chrome.storage.local.
 *
 * Keys:
 *   searches  [{id, label, url, enabled}]
 *   seen      {asin: acknowledgedTimestamp}   -- global memory of everything you've looked at
 *   results   {searchId: SearchResult}
 *   settings  see DEFAULT_SETTINGS
 *   runState  {running, index, total, startedTs, finishedTs, abortReason, currentLabel}
 */

import { sortSearches } from './urls.js';

export const DEFAULT_SETTINGS = {
  autoCheck: false,
  intervalMinutes: 60,
  notify: true,
  delayMs: 1500,
  maxPages: 2,
  reuseExistingTab: true,
  sortBy: 'count',
  hideSeen: false,
  keepExtraDays: 14
};

const SEEN_HIGH_WATER = 60000;
const SEEN_KEEP = 40000;

async function get(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] === undefined ? fallback : out[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/* ---------- searches ---------- */

// Sorted on read as well as write, so a list stored before this was introduced comes
// out in order without a migration step.
export async function getSearches() {
  return sortSearches(await get('searches', []));
}

export async function setSearches(searches) {
  await set('searches', sortSearches(searches));
}

export async function getEnabledSearches() {
  return (await getSearches()).filter((s) => s.enabled !== false);
}

/* ---------- seen ASINs ---------- */

export async function getSeen() {
  return get('seen', {});
}

/**
 * Acknowledge ASINs: they stop counting as new. Pruned oldest-first once the map
 * grows past the high-water mark so long-running installs don't grow without bound.
 */
export async function markSeen(asins) {
  if (!asins || !asins.length) return;
  const seen = await getSeen();
  const now = Date.now();
  for (const asin of asins) if (!seen[asin]) seen[asin] = now;

  const keys = Object.keys(seen);
  if (keys.length > SEEN_HIGH_WATER) {
    keys.sort((a, b) => seen[a] - seen[b]);
    for (const key of keys.slice(0, keys.length - SEEN_KEEP)) delete seen[key];
  }
  await set('seen', seen);
}

export async function clearSeen() {
  await set('seen', {});
}

/* ---------- results ---------- */

export async function getResults() {
  return get('results', {});
}

export async function setResults(results) {
  await set('results', results);
}

export async function updateResult(searchId, result) {
  const results = await getResults();
  results[searchId] = result;
  await set('results', results);
}

/* ---------- settings ---------- */

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await get('settings', {})) };
}

export async function setSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await set('settings', next);
  return next;
}

/* ---------- run state ---------- */

export async function getRunState() {
  return get('runState', { running: false });
}

export async function setRunState(state) {
  await set('runState', state);
}

/* ---------- derived ---------- */

/**
 * New items per search: everything currently listed whose ASIN has never been
 * acknowledged. Because `seen` is only written on acknowledgement, an item stays
 * flagged across repeated runs until you have actually looked at it.
 */
export function computeNewItems(result, seen) {
  if (!result || !result.items) return [];
  return result.items.filter((item) => !(item.asin in seen));
}

export async function countNewTotal() {
  const [results, seen] = await Promise.all([getResults(), getSeen()]);
  let total = 0;
  for (const id of Object.keys(results)) total += computeNewItems(results[id], seen).length;
  return total;
}
