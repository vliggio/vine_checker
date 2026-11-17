/**
 * Pure helpers over a stored SearchResult. No chrome APIs, so they are unit-testable.
 */

/** An item pulled from beyond the swept pages, stamped with when it was last seen. */
export function markDeep(item, now) {
  return { ...item, deep: true, deepTs: now };
}

/**
 * Carry deep items across a sweep.
 *
 * A sweep only fetches `maxPages`, so an item the user pulled from page 5 would vanish
 * from the results on the next run and reappear as "new" the next time it drifted back
 * into range — Vine orders by relevance, so items move between pages on their own.
 * Keeping them costs nothing except that they are no longer confirmed to still exist,
 * which is what the age limit is for: anything not seen again within `keepMs` goes.
 *
 * An item the sweep returns itself is confirmed, so it loses its deep marking and is
 * simply part of the result again.
 *
 * Only a truncated result has pages it could not see. One that reached the last page
 * saw the whole search, so a deep item missing from it is confirmed gone rather than
 * out of range, and carrying it would list items under a search that has none.
 */
export function mergeRetainedItems(previous, fresh, { now, keepMs }) {
  if (!fresh || fresh.status !== 'ok') return fresh;
  if (!previous || previous.status !== 'ok') return fresh;
  if (!fresh.truncated) return fresh;

  const returned = new Set((fresh.items || []).map((i) => i.asin));
  const retained = (previous.items || []).filter(
    (item) => item.deep && !returned.has(item.asin) && now - (item.deepTs || 0) < keepMs
  );
  if (!retained.length) return fresh;

  return { ...fresh, items: [...(fresh.items || []), ...retained], retained: retained.length };
}

/**
 * A failed check says nothing about what the search holds, so it must not erase what
 * the last good one found.
 *
 * Storing the failure in place of the result emptied the row, dropped its unacknowledged
 * items from the badge, threw away its deep items, and then had the next good sweep
 * announce the same backlog as freshly appeared. The last good result stays, and the
 * failure rides along as `lastError` until a check succeeds and replaces the lot.
 *
 * A search with no good result behind it has nothing to keep, so the failure is stored
 * as the result, the way it always was.
 */
export function mergeFailedResult(previous, failed) {
  if (!previous || previous.status !== 'ok') return failed;
  return {
    ...previous,
    lastError: { status: failed.status, message: failed.message, ts: failed.lastRunTs }
  };
}

/** What a finished check stores, given what was there before. */
export function mergeSearchResult(previous, fresh, options) {
  if (!fresh) return fresh;
  return fresh.status === 'ok'
    ? mergeRetainedItems(previous, fresh, options)
    : mergeFailedResult(previous, fresh);
}

/** Drop deep items that have gone unseen for too long, wherever the list came from. */
export function expireRetainedItems(items, { now, keepMs }) {
  return (items || []).filter((item) => !item.deep || now - (item.deepTs || 0) < keepMs);
}
