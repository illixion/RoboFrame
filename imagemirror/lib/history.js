// Rolling request history: the in-memory buffer that backs /get's cache,
// /history (HTML), /history.json (JSON), and /addtohistory. Extracted into
// its own module so the dedup + cap behavior is testable without booting
// the whole image API.

function createHistory({ maxSize = 50 } = {}) {
  const entries = [];

  function addEntry(entry) {
    const existingIndex = entries.findIndex((e) => e.id === entry.id);
    if (existingIndex !== -1) entries.splice(existingIndex, 1);
    entries.unshift(entry);
    if (entries.length > maxSize) entries.pop();
  }

  function findCached(id) {
    return entries.find((e) => e.id === id);
  }

  // /history (HTML) currently exposes id-only to avoid leaking ext to the
  // browser-rendered template.
  function listPreview() {
    return entries.map((post) => ({ id: post.id }));
  }

  // /history.json exposes id + ext so non-browser clients (e.g. the
  // visionOS app) can tell images from videos without a second request.
  function listJson() {
    return entries.map((post) => ({ id: post.id, ext: post.ext }));
  }

  return { entries, addEntry, findCached, listPreview, listJson };
}

module.exports = { createHistory };
