import test from 'node:test';
import assert from 'node:assert/strict';

// storage.js only touches chrome.* inside its async accessors, so the pure helpers
// import cleanly under Node.
import { computeNewItems, listedResults, countNew } from '../src/storage.js';

const search = (id, extra = {}) => ({ id, label: id, url: `https://www.amazon.com/vine/vine-items?search=${id}`, ...extra });
const ok = (...asins) => ({ status: 'ok', total: asins.length, items: asins.map((asin) => ({ asin })) });

test('computeNewItems is everything listed that was never acknowledged', () => {
  assert.deepEqual(
    computeNewItems(ok('A1', 'A2', 'A3'), { A2: 1 }).map((i) => i.asin),
    ['A1', 'A3']
  );
  assert.deepEqual(computeNewItems(undefined, {}), []);
});

test('listedResults skips disabled, deleted and unchecked searches', () => {
  const searches = [search('on'), search('off', { enabled: false }), search('unchecked')];
  const results = { on: ok('A1'), off: ok('A2'), deleted: ok('A3') };

  assert.deepEqual(listedResults(searches, results), [results.on]);
});

test('countNew matches what the list can show, not everything in storage', () => {
  const searches = [search('on'), search('off', { enabled: false })];
  const results = { on: ok('A1', 'A2'), off: ok('A3', 'A4'), deleted: ok('A5') };

  assert.equal(countNew(searches, results, {}), 2);
  assert.equal(countNew(searches, results, { A1: 1 }), 1);
});

test('a row kept through a failed check still counts its unacknowledged items', () => {
  const kept = { ...ok('A1'), lastError: { status: 'http_error', ts: 1 } };

  assert.equal(countNew([search('on')], { on: kept }, {}), 1);
});
