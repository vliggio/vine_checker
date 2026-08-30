## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem being solved. If it changes a decision documented in the README or
     CONTRIBUTING, say which one and why it should change. -->

## How it was verified

<!-- CI covers the pure helpers and the manifest. It cannot exercise a real sweep,
     so say what you actually ran. Delete what does not apply. -->

- [ ] `npm test`
- [ ] `npm run manifest`
- [ ] Loaded unpacked and ran a real sweep over ___ searches
- [ ] Options → Self-test against a live search
- [ ] Checked the signed-out path (sweep stops cleanly rather than failing repeatedly)
- [ ] Popup and options page checked in both light and dark

<!-- Screenshots for anything visual. -->

## Checklist

- [ ] No new runtime dependencies and no build step
- [ ] Sweeps stay sequential and throttled
- [ ] Durable state goes through `src/storage.js`, not service worker globals
- [ ] Icons regenerated with `npm run icons` if `assets/icon.svg` changed
