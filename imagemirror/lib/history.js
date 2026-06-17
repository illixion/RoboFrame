// Per-display request history: the in-memory buffers that back /history
// (HTML) and /history.json (JSON). Extracted into its own module so the
// per-device bucketing, dedup, and cap behavior is testable without booting
// the whole image API.
//
// Each display (keyed by the `deviceId` a kiosk passes on its /get requests)
// gets its own newest-first ring buffer, capped independently so one busy
// display can't evict another's history. Requests whose display is unknown —
// an iOS Shortcut hitting /random, or any /get without a deviceId — collect
// under the OTHERS bucket. A global monotonic `seq` stamp on every entry lets
// /history.json merge the buckets back into one newest-first stream.

const OTHERS = 'others';

function createHistory({ maxSize = 50 } = {}) {
  const buckets = new Map();   // deviceId → entries[] (newest-first)
  let seq = 0;

  function bucketOf(deviceId) {
    let arr = buckets.get(deviceId);
    if (!arr) { arr = []; buckets.set(deviceId, arr); }
    return arr;
  }

  function addEntry(entry) {
    const deviceId = entry.deviceId || OTHERS;
    const arr = bucketOf(deviceId);
    const existingIndex = arr.findIndex((e) => e.id === entry.id);
    if (existingIndex !== -1) arr.splice(existingIndex, 1);
    seq += 1;
    arr.unshift({ id: entry.id, ext: entry.ext, deviceId, seq });
    if (arr.length > maxSize) arr.pop();
  }

  function findCached(id) {
    for (const arr of buckets.values()) {
      const hit = arr.find((e) => e.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  // /history (HTML) groups by display, newest-active display first. Each
  // group carries id-only posts (ext stays out of the browser template) plus
  // the bucket size so the page can decide how many to show before expanding.
  function listGroups() {
    return [...buckets.entries()]
      .map(([deviceId, arr]) => ({
        deviceId,
        posts: arr.map((e) => ({ id: e.id })),
        seq: arr.length ? arr[0].seq : 0,
      }))
      .filter((g) => g.posts.length > 0)
      .sort((a, b) => b.seq - a.seq)
      .map(({ deviceId, posts }) => ({ deviceId, posts }));
  }

  // /history.json flattens every bucket back into one newest-first stream,
  // deduped by id (the same post shown on two displays appears once), with
  // id + ext so non-browser clients (e.g. the visionOS app) can tell images
  // from videos without a second round-trip.
  function listJson() {
    const all = [];
    for (const arr of buckets.values()) all.push(...arr);
    all.sort((a, b) => b.seq - a.seq);
    const seen = new Set();
    const out = [];
    for (const e of all) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push({ id: e.id, ext: e.ext });
    }
    return out;
  }

  return { addEntry, findCached, listGroups, listJson, OTHERS };
}

module.exports = { createHistory, OTHERS };
