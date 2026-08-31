<img src="assets/logo.svg" alt="Vine Checker" width="300">

[![CI](https://github.com/vliggio/vine_checker/actions/workflows/ci.yml/badge.svg)](https://github.com/vliggio/vine_checker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-1a8256)](LICENSE)

A Chrome extension that sweeps your saved Amazon Vine searches, tells you which ones
have items right now, and flags the items you have never seen before.

It uses the Amazon session already in your browser. No credentials are stored, nothing
is sent anywhere, and no Amazon API is involved.

## Install

This extension is not on the Chrome Web Store — you load it from source.

**1. Get the code.**

```bash
git clone https://github.com/vliggio/vine_checker.git
```

No `npm install`, no build step: there are no runtime dependencies and the icons are
checked in. (No git? Use **Code → Download ZIP** on the repo page and unzip it.)

**2. Put the folder somewhere permanent.** Chrome loads an unpacked extension by path and
re-reads it at every browser start, so moving or deleting the folder later breaks the
extension. `~/Documents` or a projects directory is fine — `~/Downloads` is not.

**3. Load it.**

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select the `vine_checker` folder you just cloned
4. Pin the extension so you can see the badge

Chrome will show "Vine Checker" with a leaf icon. If you instead get an error, the folder
you picked is probably a level off — select the one directly containing `manifest.json`.

### Updating

```bash
git pull
```

Then open `chrome://extensions` and click the reload arrow on the Vine Checker card. Your
searches, settings and seen-item history live in Chrome's extension storage, so they
survive updates untouched.

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

**Full-page view.** The ↗ button in the popup header opens the same list in a tab. The
popup closes whenever it loses focus, so the tab is the better place to work through a
long list: it stays open next to the Vine tabs you are triaging, resizes, and shows more
thumbnails per row. It picks up sweep progress live, and reuses an already-open results
tab instead of stacking duplicates.

**Searches with more pages than you swept.** A search whose results ran past *Pages per
search* says so when expanded, and in the tab view offers to fetch the rest right there
— one search, at the same delay a sweep uses, without re-running all 150 at a higher
page count. It refuses while a sweep is running, since both go through the same tab and
the same rate limit.

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
| Sort searches by | Item count | Or by title (A–Z). Applied within each group, so searches with new items still come first either way. |
| Hide a search once marked seen | off | On, an acknowledged search leaves the list instead of dropping to the bottom; it is counted in the footer. Errors are never hidden. |

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
npm test          # pure helpers: ASIN extraction, availability line, response
                  # classification, regex fallback, URL paging, import and dedupe
npm run manifest  # manifest.json is valid and every file it references exists
```

Both run in CI on Node 24 and 26. There is nothing to install first — the extension has
no runtime dependencies and no build step, by design.

### Artwork

`assets/icon.svg` is the single source of truth for the mark — a leaf carrying a
checkmark. The leaf silhouette is what keeps it recognisable at 16px, where a bare
checkmark would look like every other extension. `assets/logo.svg` is the horizontal
lockup for docs.

After editing `assets/icon.svg`, regenerate the toolbar PNGs:

```bash
npm run icons
```

That rasterises the SVG through headless Chrome, so there is no image library to
install — if you can load this extension, you can build its icons. Set `CHROME=` to
point at a different binary.

### Parser coverage

The DOM parse path needs a browser, so it is verified live instead: **Options → Self-test**
fetches one search the same way a sweep does and prints what was extracted. Run it after any
Amazon layout change — if `parsed` is 0 or `degraded` is yes, the selectors above need updating.

## Limitations

- `www.amazon.com` only. Other marketplaces need their host added to `manifest.json`
  and to `isVineUrl()` in `src/urls.js`.
- Only counts and identifies items; it does not order anything.
- Vine search relevance ordering means a very large result set may hide new items beyond
  the page limit. See *Pages per search*.

## Contributing and reporting

- [Report a bug or parser breakage](https://github.com/vliggio/vine_checker/issues/new/choose)
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, the parser traps, and what gets declined
- [SECURITY.md](SECURITY.md) — report vulnerabilities privately, plus what this
  extension can actually reach
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE) © Vince Liggio.

Not affiliated with, endorsed by, or connected to Amazon. "Amazon" and "Amazon Vine" are
trademarks of Amazon.com, Inc. This tool reads pages you are already signed in to and
entitled to view; you are responsible for using it within the Vine program's terms.
