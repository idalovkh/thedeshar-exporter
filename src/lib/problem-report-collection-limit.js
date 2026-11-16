const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).byteLength;
const eventKey = value => JSON.stringify([value.stage, value.status, value.reason, value.url, value.assetId]);
const importantStatuses = new Set(['failed', 'cancelled', 'retrying', 'unavailable', 'skipped']);

/** Reserve space for report events while retaining the last failure and its full browser trace. */
export function boundProblemCollection(collection, maxBytes) {
  const fixedBytes = bytes({ ...collection, events: [] });
  const rows = collection.events.map(event => ({ event, bytes: bytes(event) }));
  let total = fixedBytes + rows.reduce((sum, row) => sum + row.bytes, 0) + Math.max(0, rows.length - 1);
  if (total <= maxBytes) return collection;
  const latestFailure = [...rows].reverse().find(row => ['failed', 'cancelled'].includes(row.event.status));
  const repeated = new Set();
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index], key = eventKey(row.event);
    row.priority = row === latestFailure ? 3 : repeated.has(key) || !importantStatuses.has(row.event.status) ? 0 : 1;
    repeated.add(key);
  }
  let removed = 0;
  const omitted = () => Math.min(Number.MAX_SAFE_INTEGER, collection.omittedEvents + removed);
  const size = () => total + bytes(omitted()) - bytes(collection.omittedEvents);
  const remove = index => {
    total -= rows[index].bytes + (rows.length > 1 ? 1 : 0);
    rows.splice(index, 1);
    removed++;
  };
  for (const priority of [0, 1]) {
    for (let index = 0; index < rows.length && size() > maxBytes;) {
      if (rows[index].priority === priority) remove(index);
      else index++;
    }
  }
  while (size() > maxBytes && rows.length > 1) {
    const index = rows.findIndex(row => row !== latestFailure);
    if (index < 0) break;
    remove(index);
  }
  return { ...collection, omittedEvents: omitted(), events: rows.map(row => row.event) };
}
