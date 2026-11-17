/**
 * The results UI, shared by the toolbar popup and the full-page view.
 *
 * Both surfaces render the same list from the same storage; they differ only in
 * how much room they have and in whether opening a search should close the window.
 * `mode` captures that difference so there is one renderer, not two that drift.
 */
import {
  getSearches,
  getResults,
  getSeen,
  getRunState,
  getSettings,
  setSettings,
  getSoloJob,
  computeNewItems
} from './storage.js';

const $ = (id) => document.getElementById(id);
const expanded = new Set();

/** 'popup' | 'page' */
let mode = 'popup';

/** Ids of the rows currently drawn, so "Expand all" knows what it is acting on. */
let visibleIds = [];

/** searchId -> a one-off line the row shows for a few seconds; see flashNote(). */
const rowNote = new Map();

/**
 * The single-search job in flight, as the worker recorded it, or null.
 *
 * Read from storage on every render rather than tracked from the messages that
 * announce it: a page opened or reloaded mid-job has heard none of those, and used to
 * offer buttons that could only be refused.
 */
let currentJob = null;

/** Last settings read by render(), for the row builders that need one or two of them. */
let currentSettings = {};

/** What the row of the search being worked on says while the job runs. */
function jobNote(job) {
  if (job.kind === 'more') {
    return job.page ? `Fetching page ${job.page} of ${job.lastPage}…` : 'Fetching…';
  }
  return job.page ? `Checking page ${job.page}…` : 'Checking…';
}

/**
 * A job that died with the service worker. The worker says so itself when it next
 * wakes, which the keepalive alarm makes a matter of seconds.
 */
const INTERRUPTED = {
  // Pages are persisted as they arrive, so nothing fetched is lost — only the loop.
  VC_MORE_DONE: 'Stopped early. Pages already fetched were kept — click to carry on.',
  VC_RECHECK_DONE: 'The check was cut short — click Refresh to run it again.'
};

const REFUSED = {
  sweep_running: 'Wait for the sweep to finish.',
  already_fetching: 'Busy with another search.',
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
  repeated_failures:
    'Sweep stopped: several searches in a row failed, so the rest were not tried. Check your connection, then run Self-test in Options to see what Amazon returned.',
  stopped: 'Sweep stopped early. Results below are from the searches that did run.',
  interrupted:
    'The last sweep was cut short when the browser or the extension restarted. Results below are from the searches that did run.'
};

/** Aborts that are nobody's fault and need no fixing, so they read as a note, not an error. */
const MILD_ABORTS = new Set(['stopped', 'interrupted']);

function relTime(ts) {
  if (!ts) return 'never';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * Why "Check all now" did nothing, for the refusals that would otherwise be silent: the
 * button is on screen and enabled in both cases.
 */
const START_REFUSED = {
  fetching_more: 'Busy with a single search — try again in a moment.',
  stopping: 'Still finishing the last request of the stopped sweep — try again in a moment.'
};

/**
 * Row order within a group. Sorting happens per group, not across the whole list,
 * so searches with new items keep floating to the top whatever the setting says.
 */
const SORTERS = {
  count: (a, b) =>
    b.newItems.length - a.newItems.length ||
    (b.result ? b.result.total : 0) - (a.result ? a.result.total : 0),
  // Small result sets are the ones worth opening — a search with 3 items is scannable,
  // one with 400 is not — so ascending order is a way to work, not just the inverse view.
  countAsc: (a, b) =>
    a.newItems.length - b.newItems.length ||
    (a.result ? a.result.total : 0) - (b.result ? b.result.total : 0),
  title: (a, b) => byLabel(a, b),
  titleDesc: (a, b) => byLabel(b, a)
};

function byLabel(a, b) {
  return a.search.label.localeCompare(b.search.label, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * The page-only column headers, in click order: the first click on a column takes its
 * natural direction, the second reverses it. Both directions are real `sortBy` values,
 * so the headers write the same setting the Options select does — the choice survives a
 * reload and the two surfaces can never disagree about what the list is sorted by.
 */
const SORT_COLUMNS = {
  title: ['title', 'titleDesc'],
  count: ['count', 'countAsc']
};

const SORT_ARROW = { title: '\u25b2', titleDesc: '\u25bc', count: '\u25bc', countAsc: '\u25b2' };

/**
 * The key the list is sorted by, seeded from settings on the first render and advanced
 * synchronously on a header click. It is not read back out of `currentSettings`, because
 * that only catches up once setSettings() resolves — a fast second click on one column
 * has to reverse it, not compute the same value from a key the write has not landed yet.
 */
let sortBy = null;

/** Which column a stored sortBy belongs to, and how far through its cycle it is. */
function sortState(sortBy) {
  for (const [column, keys] of Object.entries(SORT_COLUMNS)) {
    const index = keys.indexOf(sortBy);
    if (index !== -1) return { column, index };
  }
  return { column: 'count', index: 0 };
}

async function render() {
  const [searches, results, seen, run, settings, job] = await Promise.all([
    getSearches(),
    getResults(),
    getSeen(),
    getRunState(),
    getSettings(),
    getSoloJob()
  ]);
  currentJob = job;

  renderHeader(searches, run);
  if (sortBy === null) sortBy = settings.sortBy;
  renderSortHeader();

  const rows = searches
    .filter((s) => s.enabled !== false)
    .map((s) => {
      const result = results[s.id];
      const newItems = computeNewItems(result, seen);
      return { search: s, result, newItems };
    });

  currentSettings = settings;

  const cmp = SORTERS[sortBy] || SORTERS.count;
  // A row whose last check failed keeps the items from the check before it, so it can
  // hold new items and a failure at once. New wins — it is listed once, at the top —
  // and a failed row with nothing new still stays out of the groups hideSeen hides.
  const failed = (r) => r.result && (r.result.status !== 'ok' || r.result.lastError);
  const settled = (r) => !r.newItems.length && r.result && !failed(r);
  const withNew = rows.filter((r) => r.newItems.length).sort(cmp);
  const errored = rows.filter((r) => !r.newItems.length && failed(r)).sort(cmp);
  const stocked = rows.filter((r) => settled(r) && r.result.total > 0).sort(cmp);
  const empty = rows.filter((r) => settled(r) && !r.result.total);
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

/** Page-only, like the button above it: the popup has no room for a column header. */
function renderSortHeader() {
  const bar = $('sort-row');
  if (!bar) return;
  const active = sortState(sortBy);
  for (const button of bar.querySelectorAll('[data-column]')) {
    const on = button.dataset.column === active.column;
    const key = SORT_COLUMNS[button.dataset.column][active.index];
    button.classList.toggle('active', on);
    button.setAttribute('aria-sort', on ? (SORT_ARROW[key] === '\u25b2' ? 'ascending' : 'descending') : 'none');
    button.querySelector('.arrow').textContent = on ? SORT_ARROW[key] : '';
  }
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
  banner.classList.toggle('warn', MILD_ABORTS.has(run.abortReason));
  if (msg) banner.textContent = msg;
}

function mutedLine(text) {
  const line = document.createElement('div');
  line.className = 'row-actions';
  line.style.color = 'var(--muted)';
  line.style.fontSize = '11.5px';
  if (text) line.textContent = text;
  return line;
}

/**
 * What a truncated search says for itself. On the page it also offers to pull the
 * pages the sweep skipped; the popup only points at the setting, because it closes
 * on focus loss and a page walk takes minutes.
 */
function renderTruncationNote(search, result) {
  const note = mutedLine();

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
  more.disabled = !!currentJob; // one job at a time; the worker would refuse anyway
  more.addEventListener('click', async () => {
    more.disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'VC_FETCH_MORE', searchId: search.id });
    // The worker records the job before it answers, so a plain render picks it up.
    if (res && res.started) render();
    else flashNote(search.id, (res && REFUSED[res.reason]) || 'Could not start.');
  });
  note.append(more);

  return note;
}

/** Show a one-off line on the row, then let the row go back to what it was saying. */
function flashNote(searchId, text) {
  rowNote.set(searchId, text);
  render();
  setTimeout(() => {
    rowNote.delete(searchId);
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
    // The numbers are from the last check that worked; say so without opening the row.
    if (result.lastError) counts.innerHTML += ' · <span class="failed">check failed</span>';
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

  // Page-only, like the page walk: a re-check is quick, but the popup still dies on
  // focus loss and would leave the request reporting into nothing.
  if (mode === 'page') {
    const refresh = document.createElement('button');
    refresh.textContent = 'Refresh';
    refresh.title = 'Check this search again now';
    refresh.disabled = !!currentJob;
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: 'VC_RECHECK', searchId: search.id });
      if (res && res.started) render();
      else flashNote(search.id, (res && REFUSED[res.reason]) || 'Could not start.');
    });
    actions.append(refresh);
  }

  // A row draws a capped batch. "Mark seen" acknowledges that batch and nothing else:
  // the items past the cap have not been on screen, and clearing them here would be
  // exactly the silent acknowledgement the whole model exists to prevent.
  const shown = newItems.slice(0, ITEM_CAP[mode]);
  const held = newItems.length - shown.length;

  if (shown.length) {
    const ack = document.createElement('button');
    ack.textContent = held ? `Mark these ${shown.length} seen` : 'Mark seen';
    ack.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'VC_ACK',
        searchId: search.id,
        asins: shown.map((item) => item.asin)
      });
      // Acknowledging the last of them empties the row, which would re-render as a
      // shell holding one button. Collapse it — the click was the user saying "done
      // with this". With more held back it stays open and shows the next batch.
      if (!held) expanded.delete(search.id);
      render();
    });
    actions.append(ack);
  }
  row.append(actions);

  if (result && result.retained) {
    row.append(mutedLine(`Includes ${result.retained} item(s) kept from pages past this sweep's reach.`));
  }

  if (result && result.status === 'ok' && result.lastError) {
    const why = STATUS_TEXT[result.lastError.status] || result.lastError.status;
    row.append(
      mutedLine(
        `Last check failed ${relTime(result.lastError.ts)} (${why}). Showing what the check before it found, from ${relTime(result.lastRunTs)}.`
      )
    );
  }

  const note = rowNote.get(search.id);
  if (note) row.append(mutedLine(note));
  else if (currentJob && currentJob.searchId === search.id) row.append(mutedLine(jobNote(currentJob)));
  else if (result && result.truncated) row.append(renderTruncationNote(search, result));

  if (held) {
    row.append(
      mutedLine(
        `Showing ${shown.length} of ${newItems.length} new. Mark these seen to bring up the next ${Math.min(held, ITEM_CAP[mode])}.`
      )
    );
  }

  if (shown.length) {
    const grid = document.createElement('div');
    grid.className = 'items';
    for (const item of shown) {
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
    if (res && !res.started && START_REFUSED[res.reason]) {
      $('status').textContent = START_REFUSED[res.reason];
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

  // Page-only: sorting from the list's own header, rather than a round trip to Options.
  const sortRow = $('sort-row');
  if (sortRow) {
    sortRow.addEventListener('click', async (e) => {
      const button = e.target.closest('[data-column]');
      if (!button) return;
      const column = button.dataset.column;
      const active = sortState(sortBy);
      const keys = SORT_COLUMNS[column];
      sortBy = active.column === column ? keys[(active.index + 1) % keys.length] : keys[0];
      render();
      await setSettings({ sortBy });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;

    // Progress is drawn from what the worker stored, not from the message: the message
    // only says "look again".
    const redraw = ['VC_PROGRESS', 'VC_DONE', 'VC_MORE_PROGRESS', 'VC_RECHECK_PROGRESS'];
    if (redraw.includes(msg.type)) {
      render();
    } else if (msg.type === 'VC_RECHECK_DONE' || msg.type === 'VC_MORE_DONE') {
      rowNote.delete(msg.searchId);
      // A per-search failure is stored on the result and the row renders it; only an
      // aborted or interrupted job has nothing to show for itself.
      if (msg.status === 'ok') render();
      else if (msg.status === 'interrupted') flashNote(msg.searchId, INTERRUPTED[msg.type]);
      else flashNote(msg.searchId, `Stopped: ${STATUS_TEXT[msg.status] || msg.status}.`);
    }
  });

  // A page left open outlives an Options edit, so pick sort/hide changes up live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    // Re-seed from whatever was stored, whether Options wrote it or a header click did.
    sortBy = null;
    render();
  });

  render();
}
