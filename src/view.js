/**
 * The results UI, shared by the toolbar popup and the full-page view.
 *
 * Both surfaces render the same list from the same storage; they differ only in
 * how much room they have and in whether opening a search should close the window.
 * `mode` captures that difference so there is one renderer, not two that drift.
 */
import { getSearches, getResults, getSeen, getRunState, getSettings, computeNewItems } from './storage.js';

const $ = (id) => document.getElementById(id);
const expanded = new Set();

/** 'popup' | 'page' */
let mode = 'popup';

/** Ids of the rows currently drawn, so "Expand all" knows what it is acting on. */
let visibleIds = [];

/** searchId -> the line shown in place of the truncation note while pages are pulled. */
const pageFetchNote = new Map();

/** Last settings read by render(), for the row builders that need one or two of them. */
let currentSettings = {};

const FETCH_MORE_REFUSED = {
  sweep_running: 'Wait for the sweep to finish.',
  already_fetching: 'Already fetching pages for another search.',
  nothing_to_fetch: 'Nothing left to fetch.'
};

// The popup is 460px wide; the page has room for a lot more before scrolling hurts.
const ITEM_CAP = { popup: 24, page: 72 };

const STATUS_TEXT = {
  signin_required: 'Signed out of Amazon',
  captcha: 'Amazon showed a CAPTCHA',
  rate_limited: 'Amazon is rate-limiting requests',
  http_error: 'Amazon returned an error',
  network_error: 'Request failed',
  unrecognized: "Response wasn't a Vine page"
};

const ABORT_BANNER = {
  signin_required: 'Sweep stopped: you are signed out of Amazon. Sign in at amazon.com, then run again.',
  captcha: 'Sweep stopped: Amazon showed a CAPTCHA. Open amazon.com, clear it, then run again.',
  rate_limited: 'Sweep stopped: Amazon is rate-limiting. Wait a few minutes, or raise the delay in Options.',
  stopped: 'Sweep stopped early. Results below are from the searches that did run.'
};

function relTime(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * Row order within a group. Sorting happens per group, not across the whole list,
 * so searches with new items keep floating to the top whatever the setting says.
 */
const SORTERS = {
  count: (a, b) =>
    b.newItems.length - a.newItems.length ||
    (b.result ? b.result.total : 0) - (a.result ? a.result.total : 0),
  title: (a, b) =>
    a.search.label.localeCompare(b.search.label, undefined, { numeric: true, sensitivity: 'base' })
};

async function render() {
  const [searches, results, seen, run, settings] = await Promise.all([
    getSearches(),
    getResults(),
    getSeen(),
    getRunState(),
    getSettings()
  ]);

  renderHeader(searches, run);

  const rows = searches
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const result = results[s.id];
      const newItems = computeNewItems(result, seen);
      return { search: s, result, newItems };
    });

  currentSettings = settings;

  const cmp = SORTERS[settings.sortBy] || SORTERS.count;
  const withNew = rows.filter((r) => r.newItems.length).sort(cmp);
  const errored = rows.filter((r) => r.result && r.result.status !== 'ok').sort(cmp);
  const stocked = rows
    .filter((r) => !r.newItems.length && r.result && r.result.status === 'ok' && r.result.total > 0)
    .sort(cmp);
  const empty = rows.filter((r) => !r.newItems.length && r.result && r.result.status === 'ok' && !r.result.total);
  const unchecked = rows.filter((r) => !r.result);

  const list = $('list');
  list.replaceChildren();

  if (!searches.length) {
    list.innerHTML =
      '<div class="empty">No searches yet.<br><a href="#" id="go-options">Add your Vine search URLs</a> to get started.</div>';
    list.querySelector('#go-options').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    $('footer').textContent = '';
    visibleIds = [];
    renderExpandAll();
    return;
  }

  // Acknowledged searches still have items, they just have nothing left to look at.
  // hideSeen drops them from the list the way empty searches already are, so the rows
  // that need attention are not buried under a tail of handled ones.
  const visible = settings.hideSeen ? [...withNew, ...errored] : [...withNew, ...errored, ...stocked];
  for (const row of visible) list.append(renderRow(row));

  // Only rows on screen count: a hidden or filtered-out search must not leave the
  // button claiming everything is expanded when nothing visible is.
  visibleIds = visible.map((r) => r.search.id);
  renderExpandAll();

  if (!visible.length) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = rows.every((r) => !r.result)
      ? 'Nothing checked yet. Hit "Check all now".'
      : stocked.length
        ? 'Nothing new — every search with items has been seen.'
        : 'No items in any of your searches right now.';
    list.append(note);
  }

  const parts = [];
  if (settings.hideSeen && stocked.length) parts.push(`${stocked.length} already seen`);
  if (empty.length) parts.push(`${empty.length} with no items`);
  if (unchecked.length) parts.push(`${unchecked.length} not checked yet`);
  parts.push(`${rows.length} searches enabled`);
  $('footer').textContent = parts.join(' · ');
}

/** Page-only; the button is absent from the popup, which has no room for the result. */
function renderExpandAll() {
  const button = $('expand-all');
  if (!button) return;
  button.disabled = !visibleIds.length;
  button.textContent = allVisibleExpanded() ? 'Collapse all' : 'Expand all';
}

function allVisibleExpanded() {
  return visibleIds.length > 0 && visibleIds.every((id) => expanded.has(id));
}

function renderHeader(searches, run) {
  const running = !!run.running;
  $('run').classList.toggle('hidden', running);
  $('stop').classList.toggle('hidden', !running);
  $('run').disabled = !searches.length;

  const progress = $('progress');
  progress.classList.toggle('hidden', !running);
  if (running) {
    const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
    $('progress-bar').style.width = `${pct}%`;
    const at = Math.min(run.done + 1, run.total);
    $('status').textContent = `Checking ${at} of ${run.total}${run.currentLabel ? ` — ${run.currentLabel}` : ''}`;
  } else {
    $('status').textContent = `Last checked ${relTime(run.lastRunTs || run.finishedTs)}`;
  }

  const banner = $('banner');
  const msg = !running && run.abortReason ? ABORT_BANNER[run.abortReason] : null;
  banner.classList.toggle('hidden', !msg);
  banner.classList.toggle('warn', run.abortReason === 'stopped');
  if (msg) banner.textContent = msg;
}

/**
 * What a truncated search says for itself. On the page it also offers to pull the
 * pages the sweep skipped; the popup only points at the setting, because it closes
 * on focus loss and a page walk takes minutes.
 */
function renderTruncationNote(search, result) {
  const note = document.createElement('div');
  note.className = 'row-actions';
  note.style.color = 'var(--muted)';
  note.style.fontSize = '11.5px';

  const pending = pageFetchNote.get(search.id);
  if (pending) {
    note.textContent = pending;
    return note;
  }

  const checked = result.lastPage
    ? `Only the first ${result.pagesFetched} of ${result.lastPage} pages were checked`
    : `Only the first ${result.pagesFetched} page(s) were checked`;

  const text = document.createElement('span');
  text.textContent =
    mode === 'page' ? `${checked}.` : `${checked} — raise "Pages per search" in Options to see the rest.`;
  note.append(text);

  if (mode !== 'page') return note;

  // One click takes the same bite the sweep does, so a 20-page search stays a series
  // of decisions. The row keeps saying "truncated" until the pages run out.
  const remaining = result.lastPage ? result.lastPage - result.pagesFetched : 0;
  const batch = remaining ? Math.min(remaining, Math.max(1, currentSettings.maxPages || 1)) : 0;
  const more = document.createElement('button');
  more.textContent = batch ? `Fetch ${batch} more page${batch === 1 ? '' : 's'}` : 'Fetch more pages';
  more.addEventListener('click', async () => {
    more.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'VC_FETCH_MORE', searchId: search.id });
    if (res && res.started) {
      pageFetchNote.set(search.id, 'Fetching…');
      render();
    } else {
      flashNote(search.id, (res && FETCH_MORE_REFUSED[res.reason]) || 'Could not start.');
    }
  });
  note.append(more);

  return note;
}

/** Show a one-off line on the row, then let the row go back to what it was saying. */
function flashNote(searchId, text) {
  pageFetchNote.set(searchId, text);
  render();
  setTimeout(() => {
    pageFetchNote.delete(searchId);
    render();
  }, 5000);
}

function renderRow({ search, result, newItems }) {
  const row = document.createElement('div');
  row.className = 'row';

  const isError = result && result.status !== 'ok';
  if (isError) row.classList.add('error');

  const head = document.createElement('div');
  head.className = 'row-head';

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = expanded.has(search.id) ? '▼' : '▶';

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = search.label;
  label.title = search.url;

  const counts = document.createElement('span');
  counts.className = 'counts';
  if (isError) {
    counts.textContent = STATUS_TEXT[result.status] || result.status;
  } else if (result) {
    const total = `${result.total} item${result.total === 1 ? '' : 's'}`;
    counts.innerHTML = newItems.length
      ? `${total} · <span class="new">${newItems.length} new</span>`
      : total;
  } else {
    counts.textContent = 'not checked';
  }

  head.append(chev, label, counts);
  head.addEventListener('click', () => {
    if (expanded.has(search.id)) expanded.delete(search.id);
    else expanded.add(search.id);
    render();
  });
  row.append(head);

  if (!expanded.has(search.id)) return row;

  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const open = document.createElement('button');
  open.textContent = 'Open search';
  open.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'VC_ACK', searchId: search.id });
    chrome.tabs.create({ url: search.url });
    // The popup dies on focus loss anyway; the page should stay put and keep its list.
    if (mode === 'popup') window.close();
    else render();
  });
  actions.append(open);

  if (newItems.length) {
    const ack = document.createElement('button');
    ack.textContent = 'Mark seen';
    ack.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'VC_ACK', searchId: search.id });
      // Acknowledging empties newItems, so the row would re-render as an empty shell
      // holding one button. Collapse it — the click was the user saying "done with this".
      expanded.delete(search.id);
      render();
    });
    actions.append(ack);
  }
  row.append(actions);

  if (result && result.retained) {
    const kept = document.createElement('div');
    kept.className = 'row-actions';
    kept.style.color = 'var(--muted)';
    kept.style.fontSize = '11.5px';
    kept.textContent = `Includes ${result.retained} item(s) kept from pages past this sweep's reach.`;
    row.append(kept);
  }

  if (result && result.truncated) row.append(renderTruncationNote(search, result));

  if (newItems.length) {
    const grid = document.createElement('div');
    grid.className = 'items';
    for (const item of newItems.slice(0, ITEM_CAP[mode])) {
      const a = document.createElement('a');
      a.className = 'item';
      a.href = `https://www.amazon.com/dp/${item.asin}`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      if (item.img) {
        const img = document.createElement('img');
        img.src = item.img;
        img.alt = '';
        // Expanding every row at once is now one click, so don't request hundreds of
        // thumbnails from Amazon for rows the user has not scrolled to.
        img.loading = 'lazy';
        a.append(img);
      }
      const span = document.createElement('span');
      span.textContent = item.title || item.asin;
      a.append(span);
      grid.append(a);
    }
    row.append(grid);
  }

  return row;
}

const PAGE_URL = chrome.runtime.getURL('results.html');

/** Focus an already-open results tab rather than piling up duplicates. */
async function openResultsPage() {
  const [existing] = await chrome.tabs.query({ url: PAGE_URL });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: PAGE_URL });
  }
  if (mode === 'popup') window.close();
}

export function initView(viewMode) {
  mode = viewMode;

  $('run').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'VC_START' });
    if (res && !res.started && res.reason === 'no_searches') chrome.runtime.openOptionsPage();
    await render();
    // Otherwise the button just does nothing and the reason is invisible.
    if (res && !res.started && res.reason === 'fetching_more') {
      $('status').textContent = 'Fetching extra pages for one search — try again in a moment.';
    }
  });

  $('stop').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'VC_STOP' });
    render();
  });

  $('ack-all').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'VC_ACK_ALL' });
    expanded.clear(); // same reason as "Mark seen", for every row at once
    render();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  // Popup-only: the page is already the page.
  const openPage = $('open-page');
  if (openPage) openPage.addEventListener('click', openResultsPage);

  // Page-only: one click instead of a dozen when a sweep turns up a lot at once.
  const expandAll = $('expand-all');
  if (expandAll) {
    expandAll.addEventListener('click', () => {
      const collapsing = allVisibleExpanded();
      for (const id of visibleIds) {
        if (collapsing) expanded.delete(id);
        else expanded.add(id);
      }
      render();
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    if (msg.type === 'VC_PROGRESS' || msg.type === 'VC_DONE') {
      render();
    } else if (msg.type === 'VC_MORE_PROGRESS') {
      pageFetchNote.set(msg.searchId, `Fetching page ${msg.page} of ${msg.lastPage}…`);
      render();
    } else if (msg.type === 'VC_MORE_DONE') {
      pageFetchNote.delete(msg.searchId);
      if (msg.status === 'ok') render();
      else flashNote(msg.searchId, `Stopped: ${STATUS_TEXT[msg.status] || msg.status}.`);
    }
  });

  // A page left open outlives an Options edit, so pick sort/hide changes up live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) render();
  });

  render();
}
