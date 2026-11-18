// IndexedDB wrapper — all data stays on the device.
const DB_NAME = 'training-app';
const DB_VERSION = 2;
export const STORES = ['weights', 'checkins', 'measurements', 'photos', 'workouts', 'exercises', 'reviews'];

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          store.createIndex('date', 'date');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        Promise.resolve(fn(s)).then((r) => (result = r));
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function put(store, obj) {
  if (!obj.id) obj.id = uid();
  if (!obj.date) obj.date = new Date().toISOString().slice(0, 10);
  if (!obj.createdAt) obj.createdAt = Date.now();
  obj.updatedAt = Date.now();
  await tx(store, 'readwrite', (s) => reqP(s.put(obj)));
  return obj;
}

export function get(store, id) {
  return tx(store, 'readonly', (s) => reqP(s.get(id)));
}

export function remove(store, id) {
  return tx(store, 'readwrite', (s) => reqP(s.delete(id)));
}

/** All items, sorted by date descending (newest first). */
export async function all(store) {
  const items = await tx(store, 'readonly', (s) => reqP(s.getAll()));
  return items.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}

export function clear(store) {
  return tx(store, 'readwrite', (s) => reqP(s.clear()));
}

// ---------- Backup ----------
const blobToDataURL = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const dataURLToBlob = async (url) => (await fetch(url)).blob();

export async function exportAll() {
  const out = { app: 'training-app', version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const name of STORES) {
    const items = await all(name);
    if (name === 'photos') {
      out.data[name] = await Promise.all(
        items.map(async (p) => ({ ...p, blob: undefined, dataURL: p.blob ? await blobToDataURL(p.blob) : null }))
      );
    } else if (name === 'checkins') {
      // Check-in photos are Blobs keyed by pose → store them as data URLs.
      out.data[name] = await Promise.all(
        items.map(async (c) => {
          const photos = {};
          for (const [k, b] of Object.entries(c.photos || {})) if (b) photos[k] = await blobToDataURL(b);
          return { ...c, photos };
        })
      );
    } else {
      out.data[name] = items;
    }
  }
  return out;
}

export async function importAll(json, { replace = false } = {}) {
  if (!json || json.app !== 'training-app' || !json.data) throw new Error('קובץ גיבוי לא תקין');
  for (const name of STORES) {
    const items = json.data[name] || [];
    if (replace) await clear(name);
    for (const item of items) {
      if (name === 'photos' && item.dataURL) {
        item.blob = await dataURLToBlob(item.dataURL);
        delete item.dataURL;
      }
      if (name === 'checkins' && item.photos) {
        for (const [k, v] of Object.entries(item.photos)) if (typeof v === 'string') item.photos[k] = await dataURLToBlob(v);
      }
      await tx(name, 'readwrite', (s) => reqP(s.put(item)));
    }
  }
}
