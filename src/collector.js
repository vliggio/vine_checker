/**
 * Collector content script.
 *
 * Every request to Vine is made from here rather than from the service worker.
 * A fetch issued by a real amazon.com page is an ordinary same-origin request: it
 * carries the full session cookie regardless of SameSite rules, and looks to Amazon
 * exactly like the page paging itself. It also has DOMParser, which MV3 service
 * workers do not.
 *
 * Injected on demand by background.js together with parse.js.
 */
(function () {
  'use strict';

  if (globalThis.__vineCheckerCollector) return;
  globalThis.__vineCheckerCollector = true;

  async function fetchAndParse(url) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });

    if (res.status === 429 || res.status === 503) {
      return { ok: false, status: 'rate_limited', httpStatus: res.status };
    }
    if (!res.ok) {
      return { ok: false, status: 'http_error', httpStatus: res.status };
    }

    const html = await res.text();
    const parsed = globalThis.VineParse.parseVineHtml(html, res.url);
    return Object.assign({ ok: parsed.status === 'ok', httpStatus: res.status }, parsed);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'VC_FETCH') return undefined;

    fetchAndParse(msg.url)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, status: 'network_error', message: String((err && err.message) || err) })
      );

    return true; // keep the message channel open for the async response
  });
})();
