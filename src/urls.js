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
    const search = u.searchParams.get('search');
    const queue = u.searchParams.get('queue') || 'vine';
    if (search) return `${search} (${queue})`;
    const node = u.searchParams.get('cn') || u.searchParams.get('pn');
    return node ? `${queue} / node ${node}` : queue;
  } catch (e) {
    return url;
  }
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
