/**
 * Typed accessors over chrome.storage.local, plus the few chrome.storage.session keys
 * at the bottom.
 *
 * Keys:
 *   searches  [{id, label, url, enabled}]
 *   seen      {asin: acknowledgedTimestamp}   -- global memory of everything you've looked at
 *   results   {searchId: SearchResult}
 *   settings  see DEFAULT_SETTINGS
 *   runState  {running, finished, manual, queue, total, done, foundNew, failStreak, startedTs,
 *              finishedTs, lastRunTs, abortReason, currentLabel}
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

/**
 * Drop results whose search no longer exists. Disabled searches keep theirs: turning
 * one back on should not cost a sweep to find out what it held.
 *
 * Called by the worker at the start of a sweep, never from Options when a search is
 * deleted — the worker is the only writer of `results`, and a second writer in another
 * page would race the sweep's own read-modify-write.
 */
export async function pruneResults(searches) {
  const keep = new Set(searches.map((s) => s.id));
  const results = await getResults();
  const orphans = Object.keys(results).filter((id) => !keep.has(id));
  if (!orphans.length) return;
  for (const id of orphans) delete results[id];
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

/* ---------- session ---------- */

/*
 * chrome.storage.session outlives a service worker eviction and is wiped when the
 * browser or the extension restarts. That is exactly the lifetime of the three things
 * kept here, and the wrong one for everything above:
 *
 *   collector  {tabId, ours}   a tab id means nothing in the next browser session
 *   soloJob    {kind, searchId, page, lastPage, ts}   the single-search job in flight
 *   sweepMark  startedTs of the sweep this browser session started
 *
 * sweepMark is how a wake-up tells an evicted sweep (mark still matches runState, so
 * resume it) from one the browser was closed on (mark gone, so do not).
 */

async function sessionGet(key) {
  const out = await chrome.storage.session.get(key);
  return out[key] === undefined ? null : out[key];
}

async function sessionSet(key, value) {
  if (value === null || value === undefined) await chrome.storage.session.remove(key);
  else await chrome.storage.session.set({ [key]: value });
}

export const getCollector = () => sessionGet('collector');
export const setCollector = (value) => sessionSet('collector', value);
export const getSoloJob = () => sessionGet('soloJob');
export const setSoloJob = (value) => sessionSet('soloJob', value);
export const getSweepMark = () => sessionGet('sweepMark');
export const setSweepMark = (value) => sessionSet('sweepMark', value);

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

/**
 * The results the list actually draws: one per enabled search.
 *
 * `results` also holds entries for disabled searches, and for deleted ones until the
 * next sweep prunes them. Anything that counts or acknowledges "what is listed" goes
 * through here, or the badge reports items no row will ever show.
 */
export function listedResults(searches, results) {
  return searches
    .filter((s) => s.enabled !== false && results[s.id])
    .map((s) => results[s.id]);
}

export function countNew(searches, results, seen) {
  let total = 0;
  for (const result of listedResults(searches, results)) total += computeNewItems(result, seen).length;
  return total;
}

export async function countNewTotal() {
  const [searches, results, seen] = await Promise.all([getSearches(), getResults(), getSeen()]);
  return countNew(searches, results, seen);
}
