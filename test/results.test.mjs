import test from 'node:test';
import assert from 'node:assert/strict';

import {
  markDeep,
  mergeRetainedItems,
  mergeFailedResult,
  mergeSearchResult,
  expireRetainedItems
} from '../src/results.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const KEEP = 14 * DAY;

const ok = (items) => ({ status: 'ok', total: items.length, items });
/** A sweep that stopped at the page limit, the only kind with pages it could not see. */
const cut = (items) => ({ ...ok(items), truncated: true });

test('markDeep stamps an item without touching the original', () => {
  const item = { asin: 'A1', title: 'thing' };
  const marked = markDeep(item, NOW);

  assert.deepEqual(marked, { asin: 'A1', title: 'thing', deep: true, deepTs: NOW });
  assert.equal('deep' in item, false);
});

test('mergeRetainedItems carries deep items the sweep no longer reaches', () => {
  const previous = ok([
    { asin: 'A1' },
    { asin: 'D1', deep: true, deepTs: NOW - DAY },
    { asin: 'D2', deep: true, deepTs: NOW - 20 * DAY } // unseen too long
  ]);
  const fresh = cut([{ asin: 'A1' }, { asin: 'A2' }]);

  const merged = mergeRetainedItems(previous, fresh, { now: NOW, keepMs: KEEP });

  assert.deepEqual(
    merged.items.map((i) => i.asin),
    ['A1', 'A2', 'D1']
  );
  assert.equal(merged.retained, 1);
});

test('a sweep that reached the last page confirms a missing deep item gone', () => {
  const previous = ok([{ asin: 'A1' }, { asin: 'D1', deep: true, deepTs: NOW - DAY }]);

  const shrunk = ok([{ asin: 'A1' }]);
  assert.equal(mergeRetainedItems(previous, shrunk, { now: NOW, keepMs: KEEP }), shrunk);

  const emptied = ok([]);
  assert.deepEqual(mergeRetainedItems(previous, emptied, { now: NOW, keepMs: KEEP }).items, []);
});

test('a deep item the sweep returns again is confirmed, not retained', () => {
  const previous = ok([{ asin: 'D1', deep: true, deepTs: NOW - DAY }]);
  const fresh = cut([{ asin: 'D1' }]);

  const merged = mergeRetainedItems(previous, fresh, { now: NOW, keepMs: KEEP });

  assert.deepEqual(merged.items, [{ asin: 'D1' }]); // deep marking gone
  assert.equal(merged.retained, undefined);
});

test('mergeRetainedItems leaves a failed or absent result alone', () => {
  const previous = ok([{ asin: 'D1', deep: true, deepTs: NOW }]);
  const failed = { status: 'http_error', items: [] };

  assert.equal(mergeRetainedItems(previous, failed, { now: NOW, keepMs: KEEP }), failed);
  assert.deepEqual(
    mergeRetainedItems(undefined, cut([{ asin: 'A1' }]), { now: NOW, keepMs: KEEP }).items,
    [{ asin: 'A1' }]
  );
});

test('a failed check keeps the last good result and records the failure', () => {
  const previous = { ...cut([{ asin: 'A1' }, { asin: 'D1', deep: true, deepTs: NOW - DAY }]), lastRunTs: NOW - DAY };
  const failed = { status: 'http_error', message: 'HTTP 500', lastRunTs: NOW, total: null, items: [] };

  const merged = mergeFailedResult(previous, failed);

  assert.equal(merged.status, 'ok');
  assert.deepEqual(merged.items, previous.items);
  assert.equal(merged.lastRunTs, NOW - DAY); // still the time of the check that worked
  assert.deepEqual(merged.lastError, { status: 'http_error', message: 'HTTP 500', ts: NOW });
});

test('a failed check with no good result behind it is stored as the result', () => {
  const failed = { status: 'network_error', lastRunTs: NOW, total: null, items: [] };

  assert.equal(mergeFailedResult(undefined, failed), failed);
  assert.equal(mergeFailedResult({ status: 'http_error', items: [] }, failed), failed);
});

test('mergeSearchResult clears a recorded failure once a check succeeds', () => {
  const opts = { now: NOW, keepMs: KEEP };
  const good = cut([{ asin: 'A1' }, { asin: 'D1', deep: true, deepTs: NOW - DAY }]);
  const failed = { status: 'http_error', lastRunTs: NOW, total: null, items: [] };

  const afterFailure = mergeSearchResult(good, failed, opts);
  assert.equal(afterFailure.lastError.status, 'http_error');

  // The deep item rode through the failure, so the next good sweep can still carry it.
  const recovered = mergeSearchResult(afterFailure, cut([{ asin: 'A1' }]), opts);
  assert.equal('lastError' in recovered, false);
  assert.deepEqual(
    recovered.items.map((i) => i.asin),
    ['A1', 'D1']
  );
});

test('expireRetainedItems drops stale deep items and keeps swept ones', () => {
  const items = [
    { asin: 'A1' },
    { asin: 'D1', deep: true, deepTs: NOW - DAY },
    { asin: 'D2', deep: true, deepTs: NOW - 15 * DAY }
  ];

  assert.deepEqual(
    expireRetainedItems(items, { now: NOW, keepMs: KEEP }).map((i) => i.asin),
    ['A1', 'D1']
  );
});
