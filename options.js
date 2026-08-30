import {
  getSearches,
  setSearches,
  getSettings,
  setSettings,
  clearSeen,
  DEFAULT_SETTINGS
} from './src/storage.js';
import { parseImportText, canonicalUrl, isVineUrl } from './src/urls.js';

const $ = (id) => document.getElementById(id);
let searches = [];
let settings = { ...DEFAULT_SETTINGS };

/* ------------------------------------------------------------------ searches */

function renderSearches() {
  const filter = $('filter').value.trim().toLowerCase();
  const host = $('searches');
  host.replaceChildren();
  $('count').textContent = String(searches.length);

  for (const search of searches) {
    if (filter && !`${search.label} ${search.url}`.toLowerCase().includes(filter)) continue;

    const row = document.createElement('div');
    row.className = 'srow' + (search.enabled === false ? ' off' : '');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = search.enabled !== false;
    toggle.title = 'Include in sweeps';
    toggle.addEventListener('change', async () => {
      search.enabled = toggle.checked;
      await persist();
      row.classList.toggle('off', !toggle.checked);
    });

    const label = document.createElement('input');
    label.type = 'text';
    label.value = search.label;
    label.addEventListener('change', async () => {
      search.label = label.value.trim() || search.label;
      label.value = search.label;
      await persist();
    });

    const link = document.createElement('a');
    link.className = 'url';
    link.href = search.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = search.url.replace('https://www.amazon.com/vine/', '');
    link.title = search.url;

    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = 'Remove';
    del.addEventListener('click', async () => {
      searches = searches.filter((s) => s.id !== search.id);
      await persist();
      renderSearches();
      renderEta();
    });

    row.append(toggle, label, link, del);
    host.append(row);
  }
}

async function persist() {
  await setSearches(searches);
}

function say(el, text, cls) {
  el.textContent = text;
  el.className = `result${cls ? ' ' + cls : ''}`;
}

$('import').addEventListener('click', async () => {
  const { entries, invalid } = parseImportText($('import-text').value);
  const existing = new Set(searches.map((s) => canonicalUrl(s.url)));

  let added = 0;
  let dupes = 0;
  for (const entry of entries) {
    const key = canonicalUrl(entry.url);
    if (existing.has(key)) {
      dupes += 1;
      continue;
    }
    existing.add(key);
    searches.push({ id: crypto.randomUUID(), label: entry.label, url: entry.url, enabled: true });
    added += 1;
  }

  await persist();
  renderSearches();
  renderEta();

  const parts = [`${added} added`];
  if (dupes) parts.push(`${dupes} already present`);
  if (invalid.length) parts.push(`${invalid.length} skipped (not a Vine URL)`);
  say($('import-result'), parts.join(' · '), invalid.length ? 'bad' : 'ok');
  if (added) $('import-text').value = invalid.join('\n');
});

$('export').addEventListener('click', async () => {
  const text = searches.map((s) => `${s.label}\t${s.url}`).join('\n');
  await navigator.clipboard.writeText(text);
  say($('import-result'), `Copied ${searches.length} searches to the clipboard.`, 'ok');
});

$('filter').addEventListener('input', renderSearches);

$('enable-all').addEventListener('click', async () => {
  searches.forEach((s) => (s.enabled = true));
  await persist();
  renderSearches();
  renderEta();
});

$('disable-all').addEventListener('click', async () => {
  searches.forEach((s) => (s.enabled = false));
  await persist();
  renderSearches();
  renderEta();
});

/* ------------------------------------------------------------------ settings */

const SETTING_FIELDS = {
  autoCheck: 'checkbox',
  intervalMinutes: 'number',
  notify: 'checkbox',
  delayMs: 'number',
  maxPages: 'number',
  reuseExistingTab: 'checkbox',
  sortBy: 'select',
  hideSeen: 'checkbox'
};

function renderSettings() {
  for (const [key, kind] of Object.entries(SETTING_FIELDS)) {
    const el = $(key);
    if (kind === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
  }
  renderEta();
}

/** Rough wall-clock estimate so the delay/pages trade-off is visible while editing. */
function renderEta() {
  const enabled = searches.filter((s) => s.enabled !== false).length;
  const requests = enabled * Math.max(1, Number($('maxPages').value) || 1);
  const perRequest = (Number($('delayMs').value) || 0) * 1.5 + 400;
  const mins = (requests * perRequest) / 60000;
  $('eta').textContent = enabled
    ? `— a full sweep takes roughly ${mins < 1 ? '<1' : Math.round(mins)} min`
    : '';
}

for (const [key, kind] of Object.entries(SETTING_FIELDS)) {
  $(key).addEventListener('change', async () => {
    const el = $(key);
    const value = kind === 'checkbox' ? el.checked : kind === 'select' ? el.value : Number(el.value);
    settings = await setSettings({ [key]: value });
    await chrome.runtime.sendMessage({ type: 'VC_SETTINGS_CHANGED' });
    renderEta();
  });
  if (kind === 'number') $(key).addEventListener('input', renderEta);
}

/* ------------------------------------------------------------------ selftest */

$('selftest').addEventListener('click', async () => {
  const out = $('selftest-out');
  const url = $('selftest-url').value.trim() || (searches[0] && searches[0].url);

  out.classList.remove('hidden', 'ok', 'bad');
  if (!url || !isVineUrl(url)) {
    out.classList.add('bad');
    out.textContent = 'Enter an https://www.amazon.com/vine/… URL (or add a search above).';
    return;
  }

  out.textContent = 'Fetching…';
  const res = await chrome.runtime.sendMessage({ type: 'VC_SELFTEST', url });

  if (!res || !res.ok) {
    out.classList.add('bad');
    out.textContent = `status: ${res ? res.status : 'no response'}\n${
      res && res.message ? res.message : ''
    }\n\nIf this says signin_required, sign in to amazon.com and retry.`;
    return;
  }

  out.classList.add('ok');
  out.textContent = [
    `status:     ok`,
    `total:      ${res.total} item(s) reported by Amazon`,
    `pages:      ${res.lastPage}`,
    `parsed:     ${res.items.length} tiles on page 1`,
    `degraded:   ${res.degraded ? 'yes — titles/images unavailable, ASINs only' : 'no'}`,
    '',
    ...res.items.slice(0, 5).map((i) => `  ${i.asin}  ${i.title.slice(0, 70)}`)
  ].join('\n');
});

/* --------------------------------------------------------------------- reset */

$('reset-seen').addEventListener('click', async () => {
  if (!confirm('Forget every seen item? Everything currently listed will count as new again.')) return;
  await clearSeen();
  await chrome.runtime.sendMessage({ type: 'VC_REFRESH_BADGE' });
  say($('reset-result'), 'Seen history cleared.', 'ok');
});

$('reset-all').addEventListener('click', async () => {
  if (!confirm('Delete all searches, results and seen history? This cannot be undone.')) return;
  await chrome.storage.local.clear();
  searches = [];
  settings = { ...DEFAULT_SETTINGS };
  await chrome.runtime.sendMessage({ type: 'VC_SETTINGS_CHANGED' });
  renderSearches();
  renderSettings();
  say($('reset-result'), 'Everything cleared.', 'ok');
});

/* ---------------------------------------------------------------------- init */

(async () => {
  [searches, settings] = await Promise.all([getSearches(), getSettings()]);
  renderSearches();
  renderSettings();
})();
