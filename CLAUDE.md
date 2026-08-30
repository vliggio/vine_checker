# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension that sweeps a list of saved Amazon Vine search URLs (~150 of them),
reports which have items, and flags items never seen before. It scrapes signed-in Vine
pages using the browser's existing Amazon session — there is no API, no backend, and no
server anywhere in the picture.

## Commands

```bash
npm test                                    # unit tests (pure helpers only)
npm run manifest                            # manifest.json valid + all referenced files exist
npm run icons                               # regenerate icons/*.png from assets/icon.svg (needs Chrome)

node --test test/parse.test.mjs             # a single test file
node --test --test-name-pattern "parseCountLine" test/*.test.mjs   # a single test
```

Add `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` when invoking `node --test` directly
to silence the ESM-detection warning (`npm test` already does).

Pass `node --test` explicit files, never a directory — `node --test test/` resolves the
directory as a module and fails on Node 22/24.

There is no build step, no bundler, and no runtime dependencies. This is a hard constraint:
the repo must stay loadable as an unpacked folder.

**Manual loading:** `chrome://extensions` → Developer mode → Load unpacked → repo root.
After changing anything in `src/`, click the reload arrow on the extension card. Popup and
options changes only need the page reopened.

**Debugging:** `chrome://extensions` → Vine Checker → **service worker** link opens the
orchestrator's console. Sweep failures surface there, not in the popup.

## Architecture

### The request path (the thing to understand first)

```
background.js  ── chrome.tabs.sendMessage(VC_FETCH) ──▶  collector.js
(service worker)                                        (content script in an amazon.com tab)
                                                              │
                                                        fetch + parse.js
```

`background.js` **never fetches Amazon itself.** It opens (or reuses) a tab on
`www.amazon.com` and messages the injected collector one URL at a time. This detour is
load-bearing for two reasons: a fetch from a real amazon.com page is same-origin, so it
carries the session cookie regardless of SameSite rules; and MV3 service workers have no
`DOMParser`. Do not "simplify" this into a direct fetch from the worker.

### Module system split

- ES modules: `src/background.js`, `src/storage.js`, `src/urls.js`, `popup.js`, `options.js`
- Classic scripts: `src/parse.js`, `src/collector.js`

`parse.js` and `collector.js` must stay classic because `chrome.scripting.executeScript({files})`
injects classic scripts. `parse.js` dual-exports — `globalThis.VineParse` in the browser,
`module.exports` under Node for the tests.

This is why pure URL helpers live in `src/urls.js` (ESM, importable by the worker) and
**not** in `parse.js`. Don't reintroduce that duplication.

### State

Everything durable is in `chrome.storage.local` behind `src/storage.js`. Keys: `searches`,
`seen`, `results`, `settings`, `runState`. Service worker globals do not survive eviction
mid-sweep — only `runState` does.

**The acknowledgement model is the core design decision.** An ASIN enters `seen` *only*
when the user acknowledges it (Open search / Mark seen / Mark all seen), never at check
time. "New" = present in the current results AND absent from `seen`. That is what stops a
background sweep from silently clearing a find nobody has looked at yet.

### Run loop and service worker eviction

A 150-search sweep runs ~10–15 minutes, far longer than an MV3 worker's idle life. So:

- `runState.queue` is persisted after every search; `pump()` drains it
- A top-level `getRunState().then(...)` in `background.js` resumes an interrupted sweep on
  every worker wake-up, and a 30s keepalive alarm forces those wake-ups
- `pumping` (in-memory) prevents concurrent pumps; `runState.finished` makes `finishRun`
  idempotent, since `stopRun` and `pump` can both reach it
- `stopRun` only flips `running: false` when a pump is active — the pump notices and calls
  `finishRun` itself, so the collector tab is never torn down under an in-flight fetch

**Abort semantics:** `signin_required`, `captcha` and `rate_limited` abort the entire
sweep. Any other error marks that one search and the sweep continues. This distinction is
deliberate — 150 doomed requests against a signed-out session is the failure mode being
prevented.

### Messages

Worker ← UI: `VC_START`, `VC_STOP`, `VC_ACK`, `VC_ACK_ALL`, `VC_SELFTEST`,
`VC_SETTINGS_CHANGED`, `VC_REFRESH_BADGE`. Worker → UI broadcasts: `VC_PROGRESS`,
`VC_DONE`. Worker → collector: `VC_FETCH`.

## Vine page facts (confirmed against live pages, Aug 2026)

- `.vvp-item-tile[data-recommendation-id="MARKETPLACE#ASIN#token"]` — ASIN is segment 1;
  36 tiles per page
- `.a-truncate-full` = title, `data-img-url` = thumbnail
- `#vvp-items-grid-container > p` = `N item(s) matching "x"` | `No results found for "x"`
- **Paging is `page`, not `pn`.** `pn`/`cn` are category nodes; `pn=2` silently returns
  "no results" instead of page 2
- Search results are relevance-ordered, not date-ordered, so new items in a large result
  set can sit past the page limit (`maxPages`, default 2)

### Two traps that have already cost time

1. **Never trust the rendered DOM.** VineHelper (installed in this project's primary
   browser) injects `vh-*` classes and a `data-asin` attribute that does **not** exist in
   Amazon's server HTML. Verify selectors against a raw `fetch()` response only.
2. `tools/make-icons.js` deliberately omits `--user-data-dir`. Passing it makes headless
   Chrome hang indefinitely on macOS.

## Testing reality

Unit tests cover only the pure string helpers (`node --test`, no DOM available). The
`parseVineHtml` DOM path needs a browser and is verified live via **Options → Self-test**,
which fetches one real search the way a sweep does and prints what it extracted —
`parsed: 0` or `degraded: yes` means selectors need updating. Don't try to add DOM unit
tests without adding a dependency, which the no-dependencies constraint forbids.

CI (`.github/workflows/ci.yml`) runs `npm test` and `npm run manifest` on Node 22 and 24.

## Conventions

- Comments explain *why*, not *what* — this codebase has several non-obvious decisions and
  they are all annotated at the point of the decision
- Sweeps stay sequential and throttled. Parallelising requests, removing the inter-request
  delay, or retrying harder on rate limiting is explicitly out of bounds (see
  `CONTRIBUTING.md`)
- `www.amazon.com` only; other marketplaces need `manifest.json` host permissions plus
  `isVineUrl()` in `src/urls.js`
- `assets/icon.svg` is the single source of truth for the mark; `icons/*.png` are generated

## Automated review

`.coderabbit.yaml` configures the CodeRabbit bot that reviews every PR. It restates the
constraints above as path instructions and advisory pre-merge checks — no dependencies,
sequential sweeps, the acknowledgement model, the classic vs ES module split, the `page`
paging param, the raw-fetch-not-rendered-DOM rule. If one of those rules changes, change
it there in the same commit, or the bot keeps enforcing the old one. The file validates
against `https://coderabbit.ai/integrations/schema.v2.json`.

## Git

`main` is protected by a repository ruleset ("main protection"): changes land through a
pull request, CI (`test (22.x)` and `test (24.x)`) must pass, and force-pushes and branch
deletion are blocked. Required approvals are 0, so a solo maintainer can merge their own
PR — but the PR itself is not optional. Work on a branch and open a PR; do not assume a
direct push to `main` will be accepted.

If a push or `gh pr merge` is refused with *"refusing to allow an OAuth App to create or
update workflow ... without `workflow` scope"*, the `gh` token is missing that scope. Fix
it once with `gh auth refresh -s workflow` (interactive device flow) rather than working
around it per-push. Note the refusal applies to the GitHub *merge API* too, not just git
pushes, so it can block merging someone else's workflow-touching PR.
