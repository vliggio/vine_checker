/**
 * Orchestrator service worker.
 *
 * Owns the queue, throttling, storage, alarms, badge and notifications. It never
 * fetches Amazon itself -- every request goes through the collector content script
 * running in a real amazon.com tab (see src/collector.js for why).
 */

import {
  getSearches,
  getEnabledSearches,
  getResults,
  getSeen,
  getSettings,
  getRunState,
  setRunState,
  updateResult,
  markSeen,
  computeNewItems,
  countNewTotal
} from './storage.js';
import { withPage } from './urls.js';
import { markDeep, mergeRetainedItems, expireRetainedItems } from './results.js';

const AUTO_ALARM = 'vc-autocheck';
const KEEPALIVE_ALARM = 'vc-keepalive';
const COLLECTOR_URL = 'https://www.amazon.com/vine/vine-items';

/** Transient, per-service-worker-lifetime state. Everything durable lives in storage. */
let pumping = false;
/** Search id of the single-search job holding the collector (extra pages, or a recheck). */
let soloJob = null;
/**
 * Claim on the collector, taken synchronously before any entry point awaits.
 *
 * They all read storage before they record anything, so two clicks landing in the same
 * tick would each pass their guard and start fetching in parallel — exactly the
 * concurrency this extension is built to avoid.
 */
let claimingCollector = false;
let collectorTabId = null;
let collectorTabIsOurs = false;
/** Tabs that refused injection, so we stop re-picking the same broken host. */
const unusableTabs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function broadcast(message) {
  // No receiver is a normal condition (popup closed); swallow the resulting error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

/* ------------------------------------------------------------------ collector */

async function ensureCollectorTab() {
  if (collectorTabId !== null) {
    try {
      const tab = await chrome.tabs.get(collectorTabId);
      if (tab && tab.url && tab.url.startsWith('https://www.amazon.com/')) return collectorTabId;
    } catch (e) {
      /* tab is gone */
    }
    collectorTabId = null;
    collectorTabIsOurs = false;
  }

  const settings = await getSettings();
  if (settings.reuseExistingTab) {
    const existing = await chrome.tabs.query({ url: 'https://www.amazon.com/*' });
    const usable = existing.find((t) => t.status === 'complete' && !unusableTabs.has(t.id));
    if (usable) {
      try {
        await injectCollector(usable.id);
        collectorTabId = usable.id;
        collectorTabIsOurs = false;
        return collectorTabId;
      } catch (e) {
        // Fall through to opening our own tab rather than retrying this one forever.
        unusableTabs.add(usable.id);
      }
    }
  }

  const tab = await chrome.tabs.create({ url: COLLECTOR_URL, active: false });
  try {
    await waitForTabComplete(tab.id);
    await injectCollector(tab.id);
  } catch (e) {
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw e;
  }
  collectorTabId = tab.id;
  collectorTabIsOurs = true;
  return tab.id;
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out loading amazon.com'));
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, () => {});
  });
}

async function injectCollector(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['src/parse.js', 'src/collector.js']
  });
}

async function releaseCollectorTab() {
  if (collectorTabId !== null && collectorTabIsOurs) {
    try {
      await chrome.tabs.remove(collectorTabId);
    } catch (e) {
      /* already closed */
    }
  }
  collectorTabId = null;
  collectorTabIsOurs = false;
}

/**
 * One fetch through the collector, with a single re-injection retry for the case
 * where the host tab navigated or was closed between requests.
 */
async function collect(url) {
  let lastError = 'collector unavailable';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const tabId = await ensureCollectorTab();
      return await chrome.tabs.sendMessage(tabId, { type: 'VC_FETCH', url });
    } catch (e) {
      // The host tab navigated, closed, or refused injection: drop it and re-acquire.
      lastError = String((e && e.message) || e);
      collectorTabId = null;
      collectorTabIsOurs = false;
    }
  }
  return { ok: false, status: 'network_error', message: lastError };
}

/* ------------------------------------------------------------------- run loop */

/** Fetch every page of one search (up to maxPages) and merge the items. */
async function checkSearch(search, settings) {
  const items = [];
  const byAsin = new Set();
  let total = null;
  let lastPage = 1;
  let degraded = false;

  for (let page = 1; page <= Math.max(1, settings.maxPages); page += 1) {
    if (page > lastPage) break;

    const url = withPage(search.url, page);
    let res = await collect(url);

    // Back off and retry on throttling before giving up on this search.
    for (let retry = 0; res && res.status === 'rate_limited' && retry < 3; retry += 1) {
      await sleep([5000, 15000, 45000][retry]);
      res = await collect(url);
    }

    if (!res || !res.ok) {
      if (res && (res.status === 'signin_required' || res.status === 'captcha' || res.status === 'rate_limited')) {
        return { abort: res.status };
      }
      return {
        result: {
          lastRunTs: Date.now(),
          status: (res && res.status) || 'network_error',
          message: res && res.message,
          total: null,
          items: []
        }
      };
    }

    total = page === 1 ? res.total : total;
    lastPage = res.lastPage || 1;
    degraded = degraded || !!res.degraded;

    for (const item of res.items) {
      if (!byAsin.has(item.asin)) {
        byAsin.add(item.asin);
        items.push(item);
      }
    }

    if (!res.items.length) break;
    if (page < Math.min(lastPage, settings.maxPages)) await throttle(settings);
  }

  return {
    result: {
      lastRunTs: Date.now(),
      status: 'ok',
      total: total === null ? items.length : total,
      pagesFetched: Math.min(lastPage, Math.max(1, settings.maxPages)),
      lastPage,
      truncated: lastPage > settings.maxPages,
      degraded,
      items
    }
  };
}

/* ------------------------------------------------------- on-demand extra pages */

/**
 * Pull the pages a sweep skipped for one search.
 *
 * Raising "Pages per search" is the alternative, and it is a bad one: it applies to
 * all ~150 searches and only takes effect on the next full sweep. Vine orders results
 * by relevance rather than date, so the new item you want is exactly the one sitting
 * past the cut.
 *
 * One click pulls at most `maxPages` more — the same bite the sweep takes — so a
 * search with twenty pages stays a series of decisions rather than one long wait.
 * The row stays truncated until the pages run out, so clicking again continues.
 *
 * Returns as soon as the walk starts; progress arrives as VC_MORE_PROGRESS and the
 * outcome as VC_MORE_DONE, because the walk can take minutes and a message port
 * cannot be held open that long.
 */
async function startFetchMore(searchId) {
  if (soloJob) return { started: false, reason: 'already_fetching' };
  if (claimingCollector) return { started: false, reason: 'sweep_running' };
  claimingCollector = true;

  try {
    const state = await getRunState();
    if (state.running) return { started: false, reason: 'sweep_running' };

    const [searches, results] = await Promise.all([getSearches(), getResults()]);
    const search = searches.find((s) => s.id === searchId);
    const result = results[searchId];
    if (!search || !result || result.status !== 'ok' || !result.truncated) {
      return { started: false, reason: 'nothing_to_fetch' };
    }

    soloJob = searchId;
    // Same keepalive a sweep uses: at the configured delay this outlives the worker's
    // idle timeout long before it runs out of pages.
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

    runFetchMore(search, result).finally(async () => {
      soloJob = null;
      await chrome.alarms.clear(KEEPALIVE_ALARM);
      await releaseCollectorTab();
    });

    return { started: true };
  } finally {
    claimingCollector = false;
  }
}

async function runFetchMore(search, result) {
  const settings = await getSettings();
  const now = Date.now();
  const keepMs = retentionMs(settings);
  const byAsin = new Map(
    expireRetainedItems(result.items || [], { now, keepMs }).map((item) => [item.asin, item])
  );
  let fetchedThrough = Math.max(1, result.pagesFetched || 1);
  // Results written before lastPage was recorded do not know where the end is. Ask for
  // one more page; the response says how far it actually goes.
  let lastPage = result.lastPage || fetchedThrough + 1;
  const stopAt = fetchedThrough + Math.max(1, settings.maxPages);
  let degraded = !!result.degraded;
  let status = 'ok';

  try {
    for (let page = fetchedThrough + 1; page <= Math.min(lastPage, stopAt); page += 1) {
      broadcast({ type: 'VC_MORE_PROGRESS', searchId: search.id, page, lastPage });

      const url = withPage(search.url, page);
      let res = await collect(url);

      // Same back-off as a sweep. One search asking for its own pages is not a reason
      // to lean on a session that is already being throttled.
      for (let retry = 0; res && res.status === 'rate_limited' && retry < 3; retry += 1) {
        await sleep([5000, 15000, 45000][retry]);
        res = await collect(url);
      }

      if (!res || !res.ok) {
        status = (res && res.status) || 'network_error';
        break;
      }

      lastPage = res.lastPage || lastPage;
      degraded = degraded || !!res.degraded;
      for (const item of res.items) {
        // Deep items are the ones a sweep will not see again, so they carry the stamp
        // that keeps them alive across sweeps. Re-fetching one resets its clock.
        byAsin.set(item.asin, page > Math.max(1, settings.maxPages) ? markDeep(item, Date.now()) : item);
      }
      fetchedThrough = page;
      // An empty page is the end of the results, whatever the pagination claimed.
      if (!res.items.length) lastPage = fetchedThrough;

      // Persisted per page: an eviction costs the loop, never the pages already paid
      // for. Items land in `results` only — acknowledgement stays the user's move.
      await updateResult(search.id, {
        ...result,
        items: [...byAsin.values()],
        degraded,
        lastPage,
        pagesFetched: fetchedThrough,
        truncated: fetchedThrough < lastPage
      });
      await refreshBadge();

      if (!res.items.length) break;
      if (page < Math.min(lastPage, stopAt)) await throttle(settings);
    }
  } catch (err) {
    status = 'error';
    console.error('[vine-checker] fetching remaining pages failed', err);
  }

  broadcast({
    type: 'VC_MORE_DONE',
    searchId: search.id,
    status,
    pagesFetched: fetchedThrough,
    lastPage,
    newTotal: await countNewTotal()
  });
}

/**
 * Re-check one search, without the 10-15 minutes a full sweep costs.
 *
 * Deliberately silent: no desktop notification, because the user is looking at the row
 * they just asked about. The badge is still refreshed — it is the unacknowledged count,
 * not an announcement, and would otherwise be wrong.
 */
async function startRecheck(searchId) {
  if (soloJob) return { started: false, reason: 'already_fetching' };
  if (claimingCollector) return { started: false, reason: 'sweep_running' };
  claimingCollector = true;

  try {
    const state = await getRunState();
    if (state.running) return { started: false, reason: 'sweep_running' };

    const search = (await getSearches()).find((s) => s.id === searchId);
    if (!search) return { started: false, reason: 'nothing_to_fetch' };

    soloJob = searchId;
    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

    runRecheck(search).finally(async () => {
      soloJob = null;
      await chrome.alarms.clear(KEEPALIVE_ALARM);
      await releaseCollectorTab();
    });

    return { started: true };
  } finally {
    claimingCollector = false;
  }
}

async function runRecheck(search) {
  const settings = await getSettings();
  let status = 'ok';

  try {
    const outcome = await checkSearch(search, settings);
    if (outcome.abort) {
      // Signed out, CAPTCHA or throttled: nothing to store, and the row must say why.
      status = outcome.abort;
    } else {
      // Same merge the sweep does, so pulled-in deep pages are not thrown away. A
      // per-search failure is stored as the result; the row renders it as an error.
      const previous = (await getResults())[search.id];
      await updateResult(
        search.id,
        mergeRetainedItems(previous, outcome.result, { now: Date.now(), keepMs: retentionMs(settings) })
      );
      await refreshBadge();
    }
  } catch (err) {
    status = 'error';
    console.error('[vine-checker] recheck failed', err);
  }

  broadcast({ type: 'VC_RECHECK_DONE', searchId: search.id, status, newTotal: await countNewTotal() });
}

/** How long an unconfirmed deep item survives, in ms. */
function retentionMs(settings) {
  return Math.max(1, settings.keepExtraDays) * 24 * 60 * 60 * 1000;
}

function throttle(settings) {
  const base = Math.max(250, settings.delayMs);
  return sleep(base + Math.floor(Math.random() * base));
}

export async function startRun({ manual = true } = {}) {
  // They share the collector tab and the same rate limit.
  if (soloJob) return { started: false, reason: 'fetching_more' };
  if (claimingCollector) return { started: false, reason: 'already_running' };
  claimingCollector = true;

  try {
    const state = await getRunState();
    if (state.running) return { started: false, reason: 'already_running' };

    const searches = await getEnabledSearches();
    if (!searches.length) return { started: false, reason: 'no_searches' };

    await setRunState({
      running: true,
      manual,
      startedTs: Date.now(),
      total: searches.length,
      done: 0,
      queue: searches.map((s) => s.id),
      foundNew: 0,
      currentLabel: '',
      abortReason: null
    });

    await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    pump();
    return { started: true };
  } finally {
    // Safe to drop here: runState.running is written before this point, so the next
    // caller's own guard sees the sweep.
    claimingCollector = false;
  }
}

/**
 * Requests a stop. The pump notices on its next iteration and runs finishRun itself,
 * so we never tear the collector tab down underneath an in-flight fetch.
 */
export async function stopRun(reason = 'stopped') {
  const state = await getRunState();
  if (!state.running) return;
  await setRunState({ ...state, running: false, abortReason: reason });
  if (!pumping) await finishRun(reason);
}

/**
 * Drains the queue. Progress is persisted after every search, so if the service
 * worker is evicted mid-run the next wake-up resumes where it left off.
 */
async function pump() {
  if (pumping) return;
  pumping = true;

  let abortReason = null;
  try {
    for (;;) {
      const state = await getRunState();
      if (!state.running) {
        abortReason = state.abortReason || 'stopped';
        break;
      }
      if (!state.queue || !state.queue.length) break;

      const settings = await getSettings();
      const searches = await getEnabledSearches();
      const search = searches.find((s) => s.id === state.queue[0]);

      // The search was deleted or disabled while queued: drop it silently.
      if (!search) {
        await setRunState({ ...state, queue: state.queue.slice(1), done: state.done + 1 });
        continue;
      }

      await setRunState({ ...state, currentLabel: search.label });
      broadcast({ type: 'VC_PROGRESS', done: state.done, total: state.total, label: search.label });

      const outcome = await checkSearch(search, settings);

      if (outcome.abort) {
        abortReason = outcome.abort;
        break;
      }

      // A sweep only reaches maxPages, so deep items would drop out of the results and
      // come back as "new" the next time relevance floated them into range.
      const previous = (await getResults())[search.id];
      const merged = mergeRetainedItems(previous, outcome.result, {
        now: Date.now(),
        keepMs: retentionMs(settings)
      });

      const fresh = await countFreshlyAppeared(search.id, merged);
      await updateResult(search.id, merged);

      const next = await getRunState();
      await setRunState({
        ...next,
        queue: next.queue.slice(1),
        done: next.done + 1,
        foundNew: (next.foundNew || 0) + fresh
      });
      await refreshBadge();
      broadcast({ type: 'VC_PROGRESS', done: next.done + 1, total: next.total, label: search.label });

      const remaining = (await getRunState()).queue;
      if (remaining && remaining.length) await throttle(settings);
    }
  } catch (err) {
    abortReason = 'error';
    console.error('[vine-checker] sweep failed', err);
  } finally {
    pumping = false;
    await finishRun(abortReason);
  }
}

/**
 * Items worth notifying about: present now, absent from the previous run of this
 * search, and never acknowledged. Counting only newly-appeared items stops a
 * scheduled sweep from re-announcing a backlog you simply haven't cleared yet.
 */
async function countFreshlyAppeared(searchId, result) {
  if (!result || result.status !== 'ok' || !result.items.length) return 0;
  const [results, seen] = await Promise.all([getResults(), getSeen()]);
  const previous = new Set(((results[searchId] && results[searchId].items) || []).map((i) => i.asin));
  return result.items.filter((i) => !previous.has(i.asin) && !(i.asin in seen)).length;
}

async function finishRun(abortReason) {
  const state = await getRunState();
  if (state.finished) return; // stopRun and pump can both land here

  const reason = abortReason || state.abortReason || null;
  await setRunState({
    ...state,
    running: false,
    finished: true,
    queue: [],
    currentLabel: '',
    finishedTs: Date.now(),
    lastRunTs: Date.now(),
    abortReason: reason
  });

  await chrome.alarms.clear(KEEPALIVE_ALARM);
  await releaseCollectorTab();
  unusableTabs.clear();
  await refreshBadge();

  const settings = await getSettings();
  const gained = state.foundNew || 0;

  if (settings.notify && gained > 0) await notifyNewItems(gained);
  if (reason === 'signin_required' || reason === 'captcha') await notifyBlocked(reason);

  broadcast({ type: 'VC_DONE', abortReason: reason, newTotal: await countNewTotal() });
}

async function notifyNewItems(gained) {
  const [results, seen] = await Promise.all([getResults(), getSeen()]);
  const titles = [];
  for (const id of Object.keys(results)) {
    for (const item of computeNewItems(results[id], seen)) {
      if (item.title && titles.length < 3) titles.push('• ' + item.title.slice(0, 60));
    }
  }
  chrome.notifications.create('vc-new-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: gained + (gained === 1 ? ' new Vine item' : ' new Vine items'),
    message: titles.join('\n') || 'Open Vine Checker to see them.',
    priority: 1
  });
}

async function notifyBlocked(reason) {
  chrome.notifications.create('vc-blocked-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Vine Checker stopped',
    message:
      reason === 'captcha'
        ? 'Amazon showed a CAPTCHA. Open amazon.com, clear it, then run again.'
        : 'You are signed out of Amazon. Sign in, then run again.',
    priority: 2
  });
}

/* --------------------------------------------------------------------- badge */

async function refreshBadge() {
  const total = await countNewTotal();
  await chrome.action.setBadgeBackgroundColor({ color: '#d13212' });
  await chrome.action.setBadgeText({ text: total ? (total > 99 ? '99+' : String(total)) : '' });
}

/* -------------------------------------------------------------------- alarms */

async function syncAutoAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(AUTO_ALARM);
  if (settings.autoCheck) {
    await chrome.alarms.create(AUTO_ALARM, {
      periodInMinutes: Math.max(1, settings.intervalMinutes),
      delayInMinutes: Math.max(1, settings.intervalMinutes)
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === AUTO_ALARM) {
    await startRun({ manual: false });
  } else if (alarm.name === KEEPALIVE_ALARM) {
    // Waking for this alarm is enough to keep a long sweep alive; resume if the
    // worker was evicted between searches.
    const state = await getRunState();
    if (state.running) pump();
  }
});

/* ------------------------------------------------------------------ messages */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('VC_')) return undefined;

  (async () => {
    switch (msg.type) {
      case 'VC_START':
        sendResponse(await startRun({ manual: true }));
        break;

      case 'VC_STOP':
        await stopRun('stopped');
        sendResponse({ ok: true });
        break;

      case 'VC_ACK': {
        const results = await getResults();
        const result = results[msg.searchId];
        await markSeen((result && result.items ? result.items : []).map((i) => i.asin));
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'VC_ACK_ALL': {
        const results = await getResults();
        const asins = [];
        for (const id of Object.keys(results)) {
          for (const item of results[id].items || []) asins.push(item.asin);
        }
        await markSeen(asins);
        await refreshBadge();
        sendResponse({ ok: true });
        break;
      }

      case 'VC_RECHECK':
        sendResponse(await startRecheck(msg.searchId));
        break;

      case 'VC_FETCH_MORE':
        sendResponse(await startFetchMore(msg.searchId));
        break;

      case 'VC_SELFTEST': {
        const res = await collect(msg.url);
        await releaseCollectorTab();
        sendResponse(res);
        break;
      }

      case 'VC_SETTINGS_CHANGED':
        await syncAutoAlarm();
        await refreshBadge();
        sendResponse({ ok: true });
        break;

      case 'VC_REFRESH_BADGE':
        await refreshBadge();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();

  return true;
});

/* ------------------------------------------------------------------ lifecycle */

chrome.runtime.onInstalled.addListener(async () => {
  await syncAutoAlarm();
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAutoAlarm();
  await refreshBadge();
});

// Resume an interrupted sweep as soon as the worker comes back to life.
getRunState().then((state) => {
  if (state && state.running) pump();
});
