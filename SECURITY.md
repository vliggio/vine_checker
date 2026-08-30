# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/vliggio/vine_checker/security/advisories/new).
That creates a private advisory only you and the maintainer can see.

This is a personal project maintained in spare time. Expect a first response within
about two weeks. If a report is valid, the fix and a public advisory land together.

Please include:

- what an attacker can do, not just what looks wrong
- the steps to reproduce it, and the Chrome and extension versions
- whether it needs a malicious page, a malicious extension, or local machine access

## What this extension can do

Understanding the blast radius helps in judging whether something is a real finding.

The extension holds `https://www.amazon.com/*` host permission plus `storage`, `alarms`,
`notifications`, `tabs` and `scripting`. With those it can:

- read your signed-in Amazon Vine pages, using the session cookie already in your browser
- inject `src/parse.js` and `src/collector.js` into a tab on `www.amazon.com`
- read the URL of any open tab (`tabs`), in order to find an amazon.com tab to reuse
- store search URLs, results and seen ASINs in `chrome.storage.local`

It does **not**: transmit anything off your machine, contact any server other than
`www.amazon.com`, handle your Amazon credentials, or place orders. There is no backend,
no analytics and no telemetry. All data stays in local extension storage.

## In scope

- Anything letting a web page, another extension, or a remote party read or alter
  extension storage, or reach the collector's message handlers
- Injection through parsed Amazon HTML — the parser handles untrusted markup, and the
  popup renders titles and image URLs that came from it
- Any path that widens the extension's permissions or leaks the Amazon session
- A crafted import list escalating beyond adding a search entry
- Data reaching any host other than `www.amazon.com`

## Out of scope

- Amazon's own site, servers or CAPTCHA behaviour — report those to Amazon
- Rate limiting or account issues arising from sweeping too aggressively; that is a
  configuration matter, see *Settings worth knowing* in the README
- Anything requiring an already-compromised machine or browser profile
- Breakage from Amazon changing their markup — that is a bug, not a vulnerability.
  File it with the [parser template](https://github.com/vliggio/vine_checker/issues/new?template=parser_broken.yml)

## Supported versions

The latest commit on `main` is the only supported version. There are no backports.

## Installing safely

Load this extension from source you have reviewed. It is not on the Chrome Web Store,
so any listing claiming to be it is not from this project.
