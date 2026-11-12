/** A shared pool for Home and its filters. Keep the continuation, not a growing range request. */
export function createHomeFeed(loadPage) {
  let videos = [], cursor = "", ended = false, pending = null;
  const ids = new Set();
  const merge = (batch) => {
    for (const v of batch) if (v?.id && !ids.has(v.id)) { ids.add(v.id); videos.push(v); }
  };
  return {
    merge,
    get videos() { return videos; },
    get ended() { return ended; },
    get loading() { return !!pending; },
    loadMore(matches = () => true) {
      if (pending) return pending;
      if (ended) return Promise.resolve(0);
      const before = videos.filter(matches).length;
      pending = (async () => {
        let restarted = false;
        // Sparse topics can need several recommendation pages. Bound each scroll request,
        // then offer a button so an empty topic cannot silently drain the whole feed.
        for (let page = 0; page < 4 && !ended; page++) {
          let result;
          try { result = await loadPage(cursor); }
          catch (error) {
            if (error.status === 410 && cursor && !restarted) { cursor = ""; restarted = true; page--; continue; }
            throw error;
          }
          if (!Array.isArray(result.videos) || !(result.nextCursor === null || typeof result.nextCursor === "string")) throw new Error("Invalid recommendation page.");
          merge(result.videos);
          ended = result.nextCursor === null; cursor = result.nextCursor ?? "";
          if (videos.filter(matches).length - before >= 12) break;
        }
        return videos.filter(matches).length - before;
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
