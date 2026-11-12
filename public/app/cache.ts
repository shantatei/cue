// A small persistent cache in IndexedDB. It holds the signed-in lists (subscriptions, feed, history…)
// so the next visit can draw from it immediately and refresh in the background. Keys are per profile.
const DB = "own-cache", STORE = "kv";
let opening: Promise<IDBDatabase | null> | undefined;
const open = () => (opening ??= new Promise<IDBDatabase | null>((resolve) => {
  try {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  } catch { resolve(null); }   // private mode etc.: work without a cache
}));
const run = async <T = void>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> => {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try { const tx = db.transaction(STORE, mode); const out = fn(tx.objectStore(STORE)); tx.oncomplete = () => resolve(out?.result); tx.onerror = tx.onabort = () => resolve(undefined); }
    catch { resolve(undefined); }
  });
};
export const cache = {
  get: <T>(key: string) => run<T>("readonly", (s) => s.get(key)),
  set: (key: string, value: unknown) => run("readwrite", (s) => s.put(value, key)),
  delete: (key: string) => run("readwrite", (s) => s.delete(key)),
  /** Remove everything whose key starts with `prefix` (a disconnected or deleted profile). */
  clear: (prefix: string) => run("readwrite", (s) => { s.openKeyCursor().onsuccess = (e) => { const c = (e.target as IDBRequest<IDBCursor | null>).result; if (c) { if (String(c.key).startsWith(prefix)) s.delete(c.key); c.continue(); } }; }),
};
