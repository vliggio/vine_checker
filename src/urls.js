/**
 * Pure URL helpers shared by the service worker, popup and options page.
 * Kept out of parse.js so they can be an ES module (parse.js has to stay a
 * classic script for content-script injection).
 */

/** Rewrite a Vine search URL to a given page. Page 1 drops the param entirely. */
export function withPage(url, page) {
  const u = new URL(url);
  if (!page || page <= 1) u.searchParams.delete('page');
  else u.searchParams.set('page', String(page));
  return u.toString();
}

/** A short human label for a search URL, used when bare URLs are imported. */
export function labelFromUrl(url) {
  try {
    const u = new URL(url);
    // Sweeps search all of Vine, so naming the queue distinguishes nothing and just
    // pushes the part that identifies the search off the end of a narrow row.
    const search = u.searchParams.get('search');
    if (search) return search;

    // Only a URL with no search term at all needs something else to go by.
    const queue = u.searchParams.get('queue');
    const node = u.searchParams.get('cn') || u.searchParams.get('pn');
    if (queue && node) return `${queue} / node ${node}`;
    if (queue) return queue;
    if (node) return `node ${node}`;
    return u.pathname.split('/').filter(Boolean).pop().replace(/-/g, ' ') || url;
  } catch (e) {
    return url;
  }
}

/**
 * Searches by label, A-Z.
 *
 * Add order is not information anyone uses — nothing surfaces when a search was
 * added — so the stored array is kept sorted and every reader (Options list, export,
 * sweep queue) inherits it. URL breaks ties so the order cannot wobble between calls.
 */
export function sortSearches(searches) {
  return [...searches].sort(
    (a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.url.localeCompare(b.url)
  );
}

/** Only sweep real Vine pages on the marketplace we hold host permission for. */
export function isVineUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'www.amazon.com' && u.pathname.startsWith('/vine/');
  } catch (e) {
    return false;
  }
}

/**
 * Parse the options-page import box.
 * Accepts `Label<TAB>URL`, `Label,URL`, or a bare URL (auto-labelled).
 * Returns { entries:[{label,url}], invalid:[line] }.
 */
export function parseImportText(text) {
  const entries = [];
  const invalid = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let label = '';
    let url = line;

    const tab = line.indexOf('\t');
    if (tab !== -1) {
      label = line.slice(0, tab).trim();
      url = line.slice(tab + 1).trim();
    } else {
      // Split on the last comma before the URL so labels may contain commas.
      const m = line.match(/^(.*?),\s*(https?:\/\/\S+)$/);
      if (m) {
        label = m[1].trim();
        url = m[2].trim();
      }
    }

    if (!isVineUrl(url)) {
      invalid.push(line);
      continue;
    }
    entries.push({ label: label || labelFromUrl(url), url });
  }

  return { entries, invalid };
}

/** Canonical form used for dedupe: query params sorted, `page` dropped. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('page');
    const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    u.search = new URLSearchParams(params).toString();
    return u.toString();
  } catch (e) {
    return url;
  }
}
