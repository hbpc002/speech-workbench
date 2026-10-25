// The one IndexedDB schema for this app.
//
// This module exists because of a specific failure mode that already bit this
// codebase once: two modules opening the same database with the same version
// number, each creating only the stores it knows about. Whichever opens first
// wins, and the other one then finds no store and every write fails with a
// `NotFoundError` that names nothing useful.
//
// Bumping the version does not fix that, because the upgrade callback only runs
// for the connection that actually triggered the upgrade. The schema has to be
// one list, in one place, created in full by whoever opens the database first.

export const DB_NAME = 'speech-workbench';

/** Bump when a store is added or a keyPath changes. */
export const DB_VERSION = 5;

/**
 * Every store, with its key path.
 *
 * `id` everywhere: records are written whole and never patched in place, so
 * there is nothing for a compound key to buy.
 */
export const STORES = {
  'tts-records': 'id',
  'voice-previews': 'id',
  'voice-clones': 'id',
  'voice-meta': 'id',
  'voice-list': 'id',
  'video-assets': 'id',
};

/** Open the database, creating any missing store. */
export function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('数据库被另一个标签页占用，请关掉其他标签页再试。'));
  });
}

/**
 * Run one transaction against one store.
 *
 * Resolves with the request's result on commit, not on request success: a write
 * that resolves before the transaction commits can be rolled back afterwards,
 * which makes a failed save look like it worked.
 */
export function tx(storeName, mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(storeName, mode);
        } catch (error) {
          // A missing store throws here rather than in the request.
          reject(error);
          return;
        }
        const request = run(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(request && request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}
