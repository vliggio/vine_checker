import { getSearches, getResults, getSeen, getRunState, getSettings, computeNewItems } from './src/storage.js';

const $ = (id) => document.getElementById(id);
const expanded = new Set();

const STATUS_TEXT = {
  signin_required: 'Signed out of Amazon',
  captcha: 'Amazon showed a CAPTCHA',
  rate_limited: 'Amazon rate-limited the sweep',
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
    return;
  }

  for (const row of [...withNew, ...errored, ...stocked]) list.append(renderRow(row));

  if (!withNew.length && !errored.length && !stocked.length) {
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = rows.every((r) => !r.result)
      ? 'Nothing checked yet. Hit "Check all now".'
      : 'No items in any of your searches right now.';
    list.append(note);
  }

  const parts = [];
  if (empty.length) parts.push(`${empty.length} with no items`);
  if (unchecked.length) parts.push(`${unchecked.length} not checked yet`);
  parts.push(`${rows.length} searches enabled`);
  $('footer').textContent = parts.join(' · ');
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
    window.close();
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

  if (result && result.truncated) {
    const note = document.createElement('div');
    note.className = 'row-actions';
    note.style.color = 'var(--muted)';
    note.style.fontSize = '11.5px';
    note.textContent = `Only the first ${result.pagesFetched} page(s) were checked — raise "Pages per search" in Options to see the rest.`;
    row.append(note);
  }

  if (newItems.length) {
    const grid = document.createElement('div');
    grid.className = 'items';
    for (const item of newItems.slice(0, 24)) {
      const a = document.createElement('a');
      a.className = 'item';
      a.href = `https://www.amazon.com/dp/${item.asin}`;
      a.target = '_blank';
      a.rel = 'noreferrer';
      if (item.img) {
        const img = document.createElement('img');
        img.src = item.img;
        img.alt = '';
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

$('run').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'VC_START' });
  if (res && !res.started && res.reason === 'no_searches') chrome.runtime.openOptionsPage();
  render();
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && (msg.type === 'VC_PROGRESS' || msg.type === 'VC_DONE')) render();
});

render();
