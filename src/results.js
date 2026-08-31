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
 */
export function mergeRetainedItems(previous, fresh, { now, keepMs }) {
  if (!fresh || fresh.status !== 'ok') return fresh;
  if (!previous || previous.status !== 'ok') return fresh;

  const returned = new Set((fresh.items || []).map((i) => i.asin));
  const retained = (previous.items || []).filter(
    (item) => item.deep && !returned.has(item.asin) && now - (item.deepTs || 0) < keepMs
  );
  if (!retained.length) return fresh;

  return { ...fresh, items: [...(fresh.items || []), ...retained], retained: retained.length };
}

/** Drop deep items that have gone unseen for too long, wherever the list came from. */
export function expireRetainedItems(items, { now, keepMs }) {
  return (items || []).filter((item) => !item.deep || now - (item.deepTs || 0) < keepMs);
}
