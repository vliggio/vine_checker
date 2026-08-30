import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { withPage, labelFromUrl, isVineUrl, parseImportText, canonicalUrl } from '../src/urls.js';

const require = createRequire(import.meta.url);
const { asinFromRecommendationId, parseCountLine, classify, asinsByRegex } = require('../src/parse.js');

const VINE = 'https://www.amazon.com/vine/vine-items?queue=potluck&search=keyboard';

test('asinFromRecommendationId pulls the ASIN out of the middle segment', () => {
  assert.equal(asinFromRecommendationId('ATVPDKIKX0DER#B0H3ZDXTVP#vine.abcdef'), 'B0H3ZDXTVP');
  assert.equal(asinFromRecommendationId('ATVPDKIKX0DER#nope#vine.abcdef'), null);
  assert.equal(asinFromRecommendationId('single-segment'), null);
  assert.equal(asinFromRecommendationId(''), null);
  assert.equal(asinFromRecommendationId(null), null);
});

test('parseCountLine reads the availability line', () => {
  assert.equal(parseCountLine('50 item(s) matching "keyboard"'), 50);
  assert.equal(parseCountLine('1,204 item(s) matching "lamp"'), 1204);
  assert.equal(parseCountLine('No results found for "zzqqxxwwvv"'), 0);
  assert.equal(parseCountLine('something else entirely'), null);
  assert.equal(parseCountLine(''), null);
});

test('classify distinguishes results, sign-in, CAPTCHA and junk', () => {
  assert.equal(classify('<div id="vvp-items-grid"></div>', VINE), 'ok');
  assert.equal(classify('<div id="vvp-items-grid"></div>', 'https://www.amazon.com/ap/signin'), 'signin_required');
  assert.equal(classify('<input id="ap_email_login">', VINE), 'signin_required');
  assert.equal(classify('<input id="captchacharacters">', VINE), 'captcha');
  assert.equal(classify('<p>maintenance</p>', VINE), 'unrecognized');
});

test('asinsByRegex recovers deduped ASINs when tile markup changes', () => {
  const html = `
    <div data-recommendation-id="ATVPDKIKX0DER#B0H3ZDXTVP#tok1"></div>
    <span data-recommendation-id="ATVPDKIKX0DER#B0H3ZDXTVP#tok1"></span>
    <div data-recommendation-id="ATVPDKIKX0DER#B0H73R1BDC#tok2"></div>
    <div data-recommendation-id="garbage"></div>`;
  assert.deepEqual(
    asinsByRegex(html).map((i) => i.asin),
    ['B0H3ZDXTVP', 'B0H73R1BDC']
  );
});

test('withPage uses the `page` param and omits it for page 1', () => {
  assert.equal(withPage(VINE, 3), `${VINE}&page=3`);
  assert.equal(withPage(VINE, 1), VINE);
  assert.equal(withPage(`${VINE}&page=5`, 2), `${VINE}&page=2`);
  assert.equal(withPage(`${VINE}&page=5`, 1), VINE);
});

test('labelFromUrl prefers the search term', () => {
  assert.equal(labelFromUrl(VINE), 'keyboard (potluck)');
  assert.equal(labelFromUrl('https://www.amazon.com/vine/vine-items?queue=encore'), 'encore');
  assert.equal(labelFromUrl('https://www.amazon.com/vine/vine-items?queue=encore&cn=123'), 'encore / node 123');
});

test('isVineUrl only accepts https vine pages on www.amazon.com', () => {
  assert.equal(isVineUrl(VINE), true);
  assert.equal(isVineUrl('http://www.amazon.com/vine/vine-items'), false);
  assert.equal(isVineUrl('https://www.amazon.co.uk/vine/vine-items'), false);
  assert.equal(isVineUrl('https://www.amazon.com/dp/B0H3ZDXTVP'), false);
  assert.equal(isVineUrl('not a url'), false);
});

test('parseImportText handles tab, comma and bare-URL lines', () => {
  const { entries, invalid } = parseImportText(
    [
      `Keyboards\t${VINE}`,
      `Lamps, bright, ${VINE}&x=1`,
      VINE + '&x=2',
      '# a comment',
      '',
      'https://example.com/not-vine'
    ].join('\n')
  );

  assert.deepEqual(
    entries.map((e) => e.label),
    ['Keyboards', 'Lamps, bright', 'keyboard (potluck)']
  );
  assert.deepEqual(invalid, ['https://example.com/not-vine']);
});

test('canonicalUrl ignores param order and paging for dedupe', () => {
  assert.equal(
    canonicalUrl('https://www.amazon.com/vine/vine-items?search=keyboard&queue=potluck&page=4'),
    canonicalUrl(VINE)
  );
});
