# Vine Checker

A Chrome extension that sweeps your saved Amazon Vine searches, tells you which ones
have items right now, and flags the items you have never seen before.

It uses the Amazon session already in your browser. No credentials are stored, nothing
is sent anywhere, and no Amazon API is involved.

## Install

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick this folder.
3. Pin the extension so you can see the badge.

The icons are checked in; regenerate them with `npm run icons` if you change the design.

## Use

**Add your searches.** Right-click the icon → Options, paste your list into the import
box, one per line. Each line can be:

```
Mechanical keyboards	https://www.amazon.com/vine/vine-items?queue=potluck&search=mechanical+keyboard
Desk lamps, https://www.amazon.com/vine/vine-items?queue=encore&search=desk+lamp
https://www.amazon.com/vine/vine-items?queue=potluck&search=wool+socks
```

Tab-separated, comma-separated, or a bare URL (auto-labelled from the search term).
Duplicates are dropped, non-Vine URLs are reported and skipped.

**Sweep.** Click the icon → **Check all now**. Searches with new items sort to the top;
expand one to see thumbnails and titles.

**New means never acknowledged.** An item counts as new until you acknowledge it — by
hitting *Open search*, *Mark seen* on a row, or *Mark all seen*. Repeated sweeps will not
quietly clear a find you haven't looked at yet. Newness is global: an ASIN you have seen
in one search is not new in another.

**Background checks.** Options → *Check automatically in the background*. The toolbar
badge shows the total unacknowledged count, and you get a desktop notification when items
newly appear.

## Settings worth knowing

| Setting | Default | Notes |
| --- | --- | --- |
| Delay between requests | 1500 ms | Randomised up to 2×. Raise it if Amazon starts rate-limiting. |
| Pages per search | 2 | Vine returns 36 items per page. Vine search results are relevance-ordered, not date-ordered, so a new item in a large result set can sit past page 2 — raise this if your searches return hundreds of items. |
| Reuse an open amazon.com tab | on | Off means a background tab is opened for the sweep and closed after. |

A 150-search sweep at the defaults takes roughly 10–15 minutes. It runs in the background;
you can close the popup.

If you are signed out or Amazon shows a CAPTCHA, the sweep stops on the first occurrence
rather than hammering 150 requests, and tells you what to fix.

## How it works

```
background.js   queue, throttling, storage, alarms, badge, notifications
   │  chrome.tabs.sendMessage, one search URL at a time
   ▼
collector.js    content script in a real amazon.com tab: fetch + parse
   │
   ▼
parse.js        tiles → {asin, title, img}, plus totals and page count
```

Every request is made from a content script rather than the service worker. A fetch issued
by a real `amazon.com` page is an ordinary same-origin request: it carries the full session
cookie regardless of `SameSite` rules and looks to Amazon exactly like the page paging
itself. It also has `DOMParser`, which MV3 service workers do not.

Run progress is persisted after every search, so a sweep survives the service worker being
evicted mid-run and resumes on the next wake-up.

### What it reads from a Vine page

Confirmed against live Vine pages in August 2026:

- `.vvp-item-tile[data-recommendation-id="MARKETPLACE#ASIN#token"]` — 36 tiles per page
- `.a-truncate-full` inside the tile — full product title
- `data-img-url` on the tile — thumbnail
- `#vvp-items-grid-container > p` — `N item(s) matching "x"` or `No results found for "x"`
- `.a-pagination` — page count; the paging parameter is `page` (not `pn`, which is a category node)

If Amazon changes the tile markup, the parser falls back to a regex sweep for
`data-recommendation-id` so ASIN bookkeeping keeps working with titles and images missing.
The popup and self-test both surface that as *degraded*.

## Development

```bash
npm test
```

Covers the pure helpers: ASIN extraction, the availability line, response classification,
the regex fallback, URL paging, import parsing and dedupe.

The DOM parse path needs a browser, so it is verified live instead: **Options → Self-test**
fetches one search the same way a sweep does and prints what was extracted. Run it after any
Amazon layout change — if `parsed` is 0 or `degraded` is yes, the selectors above need updating.

## Limitations

- `www.amazon.com` only. Other marketplaces need their host added to `manifest.json`
  and to `isVineUrl()` in `src/urls.js`.
- Only counts and identifies items; it does not order anything.
- Vine search relevance ordering means a very large result set may hide new items beyond
  the page limit. See *Pages per search*.
