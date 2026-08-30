/**
 * Vine result parsing.
 *
 * Loaded two ways:
 *   - as a content script alongside collector.js, where it exports via globalThis.VineParse
 *   - as a CommonJS module in node, for the unit tests over the pure string helpers
 *
 * Structure confirmed against live Vine pages (2026-08):
 *   .vvp-item-tile[data-recommendation-id="MARKETPLACE#ASIN#token"][data-img-url]
 *     .a-truncate-full            -> full product title
 *     a.a-link-normal[href=/dp/X] -> ASIN fallback
 *   #vvp-items-grid-container > p -> 'N item(s) matching "x"' | 'No results found for "x"'
 *   .a-pagination li             -> page numbers; the paging param is `page`
 */
(function () {
  'use strict';

  var ASIN_RE = /^[A-Z0-9]{10}$/;

  /** `MARKETPLACE#ASIN#token` -> `ASIN`, or null if it doesn't look like one. */
  function asinFromRecommendationId(rid) {
    if (!rid) return null;
    var seg = String(rid).split('#')[1];
    return seg && ASIN_RE.test(seg) ? seg : null;
  }

  /** '50 item(s) matching "x"' -> 50; 'No results found for "x"' -> 0; anything else -> null. */
  function parseCountLine(text) {
    if (!text) return null;
    var t = String(text).trim();
    if (/^no results found/i.test(t)) return 0;
    var m = t.match(/^([\d,]+)\s+item/i);
    return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
  }

  /**
   * Decide what kind of response we got before trying to read items out of it.
   * Returns one of: ok | signin_required | captcha | unrecognized
   */
  function classify(html, finalUrl) {
    var url = finalUrl || '';
    if (/\/errors\/validateCaptcha/.test(url) || /id="captchacharacters"/.test(html)) return 'captcha';
    if (/\/ap\/signin/.test(url) || /id="ap_email/.test(html) || /name="signIn"/.test(html)) return 'signin_required';
    if (html.indexOf('id="vvp-items-grid"') === -1) return 'unrecognized';
    return 'ok';
  }

  /**
   * Degraded path: if the tile markup changes we can still recover ASINs, which is
   * all the new/seen bookkeeping actually needs. Titles and images are lost.
   */
  function asinsByRegex(html) {
    var out = [];
    var seen = Object.create(null);
    var re = /data-recommendation-id="([^"]+)"/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var asin = asinFromRecommendationId(m[1].replace(/&amp;/g, '&'));
      if (asin && !seen[asin]) {
        seen[asin] = true;
        out.push({ asin: asin, title: '', img: '' });
      }
    }
    return out;
  }

  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Full parse. Requires DOMParser, so this only runs in the collector content script.
   * Returns { status, total, lastPage, items:[{asin,title,img}], degraded }
   */
  function parseVineHtml(html, finalUrl) {
    var status = classify(html, finalUrl);
    if (status !== 'ok') return { status: status, total: null, lastPage: 1, items: [] };

    var doc = new DOMParser().parseFromString(html, 'text/html');
    var container = doc.querySelector('#vvp-items-grid-container');
    var countEl = container ? container.querySelector(':scope > p') : null;
    var total = parseCountLine(textOf(countEl));

    var pages = [];
    doc.querySelectorAll('.a-pagination li').forEach(function (li) {
      var n = parseInt(textOf(li), 10);
      if (!isNaN(n)) pages.push(n);
    });
    var lastPage = pages.length ? Math.max.apply(null, pages) : 1;

    var items = [];
    doc.querySelectorAll('.vvp-item-tile').forEach(function (tile) {
      var asin = asinFromRecommendationId(tile.getAttribute('data-recommendation-id'));
      if (!asin) {
        var a = tile.querySelector('a.a-link-normal[href*="/dp/"]');
        var m = a && (a.getAttribute('href') || '').match(/\/dp\/([A-Z0-9]{10})/);
        asin = m ? m[1] : null;
      }
      if (!asin) return;
      items.push({
        asin: asin,
        title: textOf(tile.querySelector('.a-truncate-full')),
        img: tile.getAttribute('data-img-url') || ''
      });
    });

    var degraded = false;
    if (!items.length && total) {
      items = asinsByRegex(html);
      degraded = items.length > 0;
    }

    // The count line is authoritative for "does this search have anything";
    // fall back to the tile count if Amazon ever drops that paragraph.
    if (total === null) total = items.length;

    return { status: 'ok', total: total, lastPage: lastPage, items: items, degraded: degraded };
  }

  var api = {
    asinFromRecommendationId: asinFromRecommendationId,
    parseCountLine: parseCountLine,
    classify: classify,
    asinsByRegex: asinsByRegex,
    parseVineHtml: parseVineHtml
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.VineParse = api;
})();
