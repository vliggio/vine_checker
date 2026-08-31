import test from 'node:test';
import assert from 'node:assert/strict';

import { markDeep, mergeRetainedItems, expireRetainedItems } from '../src/results.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const KEEP = 14 * DAY;

const ok = (items) => ({ status: 'ok', total: items.length, items });

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
  const fresh = ok([{ asin: 'A1' }, { asin: 'A2' }]);

  const merged = mergeRetainedItems(previous, fresh, { now: NOW, keepMs: KEEP });

  assert.deepEqual(
    merged.items.map((i) => i.asin),
    ['A1', 'A2', 'D1']
  );
  assert.equal(merged.retained, 1);
});

test('a deep item the sweep returns again is confirmed, not retained', () => {
  const previous = ok([{ asin: 'D1', deep: true, deepTs: NOW - DAY }]);
  const fresh = ok([{ asin: 'D1' }]);

  const merged = mergeRetainedItems(previous, fresh, { now: NOW, keepMs: KEEP });

  assert.deepEqual(merged.items, [{ asin: 'D1' }]); // deep marking gone
  assert.equal(merged.retained, undefined);
});

test('mergeRetainedItems leaves a failed or absent result alone', () => {
  const previous = ok([{ asin: 'D1', deep: true, deepTs: NOW }]);
  const failed = { status: 'http_error', items: [] };

  assert.equal(mergeRetainedItems(previous, failed, { now: NOW, keepMs: KEEP }), failed);
  assert.deepEqual(
    mergeRetainedItems(undefined, ok([{ asin: 'A1' }]), { now: NOW, keepMs: KEEP }).items,
    [{ asin: 'A1' }]
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
