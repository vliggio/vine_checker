# Contributing

Thanks for looking. This is a small personal tool, so the bar is "does it work and stay
readable", not ceremony.

## Getting set up

No dependencies to install — the extension is plain ES modules, and the tooling uses only
Node's standard library plus the Chrome you already have.

```bash
git clone https://github.com/vliggio/vine_checker.git
cd vine_checker
npm test
```

Then load it: `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the
repo folder. After changing anything under `src/`, hit the reload arrow on the extension
card. Changes to `popup.*` and `options.*` just need the page reopened.

## Checks

```bash
npm test          # unit tests over the pure helpers
npm run manifest  # manifest.json is valid and every file it references exists
npm run icons     # regenerate icons/*.png from assets/icon.svg (needs Chrome)
```

CI runs the first two on every push and pull request.

## The thing to understand before changing the parser

Amazon serves Vine as ordinary server-rendered HTML, and this extension reads it with
selectors that are confirmed correct **at a point in time**, not guaranteed by any API.
The current structure is documented under *What it reads from a Vine page* in the README.

Two traps that have already caught people:

- **Do not trust the rendered DOM.** If you have VineHelper or a similar extension
  installed, it injects its own attributes into `.vvp-item-tile` — including a
  `data-asin` that does not exist in Amazon's HTML. Always check against the response
  from a raw `fetch()`, not from DevTools' Elements panel.
- **The paging parameter is `page`.** `pn` and `cn` are category nodes. Setting `pn=2`
  silently returns "no results" rather than page 2.

After any parser change, run **Options → Self-test**. It fetches one live search exactly
the way a sweep does and prints what it extracted. `parsed: 0` or `degraded: yes` means
the selectors need work. That live check is the real coverage; the unit tests only cover
the pure string helpers, because the DOM path needs a browser.

## Being a good citizen of Amazon's servers

Sweeps are deliberately slow and sequential. Please do not send changes that parallelise
requests, remove the delay between them, or retry harder on rate limiting. The defaults
exist so that checking 150 searches looks like a person browsing rather than a scraper,
and so a signed-out session fails once instead of 150 times.

## Style

Match what is already there:

- ES modules for anything loaded by the service worker, popup or options page;
  `src/parse.js` stays a classic script because content-script injection requires it
- No build step, no bundler, no framework, no runtime dependencies — this must stay
  loadable as an unpacked folder
- Comments explain *why*, not *what*. The non-obvious decisions in this codebase are
  worth a sentence; the obvious ones are not
- Durable state goes in `chrome.storage.local` through `src/storage.js`. Service worker
  globals do not survive eviction mid-sweep

## Pull requests

Keep them focused, and say what you actually verified — including on real Vine pages,
since a sweep cannot be exercised in CI. Mention it if you only tested the happy path.

Screenshots help for anything touching the popup or options page.

CodeRabbit reviews every pull request automatically. It has been told this project's
constraints in [`.coderabbit.yaml`](.coderabbit.yaml) — no dependencies, sequential
sweeps, the acknowledgement model, the classic-script split — so when it flags one of
those it is usually right. Nothing it says blocks a merge; replying on the comment or
`@coderabbitai resolve` is a fine answer. If it is wrong about a rule this project
actually holds, fix the rule in `.coderabbit.yaml` in the same PR rather than arguing
with it on every one.

## Reporting things

- Bugs and parser breakage: [issue templates](https://github.com/vliggio/vine_checker/issues/new/choose)
- Security problems: **not** a public issue — see [SECURITY.md](SECURITY.md)
