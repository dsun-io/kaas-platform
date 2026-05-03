import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'kaas-events-queue';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('pending')) {
        const pendingStore = db.createObjectStore('pending', {
          keyPath: 'id',
          autoIncrement: true,
        });
        pendingStore.createIndex('next_retry_at', 'next_retry_at');
        pendingStore.createIndex('created_at', 'created_at');
      }

      if (!db.objectStoreNames.contains('dead_letter')) {
        db.createObjectStore('dead_letter', {
          keyPath: 'id',
          autoIncrement: true,
        });
      }
    },
  });

  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

let indexedDbAvailable = true;

export function isIndexedDbAvailable(): boolean {
  return indexedDbAvailable;
}

export function setIndexedDbUnavailable(): void {
  indexedDbAvailable = false;
  dbPromise = null;
}
