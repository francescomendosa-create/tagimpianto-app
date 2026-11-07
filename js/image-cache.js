/**
 * Cache locale delle PNG mappa in IndexedDB (Blob).
 * Dopo il primo download su un dispositivo, i cambi pagina usano i file locali.
 * Se l’immagine sul sito cambia (stesso path), va invalidata con clear / nuovo ?v=.
 */

const DB_NAME = "tag-impianto";
const DB_VER = 2;
const STORE = "images";

/** @type {Promise<IDBDatabase>|null} */
let dbp = null;
/** @type {Map<string, string>} url remota -> blob: URL */
const blobUrls = new Map();

function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("maps")) {
        db.createObjectStore("maps", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function absUrl(src) {
  return new URL(src, location.href).href;
}

/** Path senza query, per cancellare anche chiavi vecchie. */
function urlStem(src) {
  try {
    const u = new URL(src, location.href);
    u.search = "";
    u.hash = "";
    return u.href;
  } catch (_) {
    return String(src || "").split("?")[0];
  }
}

/** Path file senza query (es. assets/maps/foo.png). */
function networkPath(src) {
  return String(src || "").split("?")[0];
}

/**
 * Le PNG non stanno più nel bundle Pages (troppo lento da pubblicare).
 * Ordine: IndexedDB già gestito sopra → locale Pages (se c’è) → CDN jsDelivr dal repo git.
 */
function mapFetchCandidates(src) {
  const raw = String(src || "");
  const path = (networkPath(raw) || raw.split("?")[0] || "").replace(/^\.\//, "");
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
  const bust = `?t=${Date.now()}`;
  const local = path.startsWith("assets/") ? `./${path}` : path;
  const cdnBase =
    "https://cdn.jsdelivr.net/gh/francescomendosa-create/tagimpianto-app@master/";
  const cdn = cdnBase + path.replace(/^\.\//, "");
  const rawGh =
    "https://raw.githubusercontent.com/francescomendosa-create/tagimpianto-app/master/" +
    path.replace(/^\.\//, "");
  return [
    local + (q || bust),
    cdn + (q || bust),
    rawGh + (q || bust),
    local,
    cdn,
    rawGh,
    src,
  ].filter(Boolean);
}

async function fetchMapBlob(src) {
  const candidates = mapFetchCandidates(src);
  let lastErr = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store", mode: "cors" });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      const blob = await res.blob();
      if (!blob || blob.size < 2000) {
        lastErr = new Error("blob vuoto");
        continue;
      }
      return blob;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Download mappa fallito");
}

async function getRecord(url) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function putRecord(url, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({
      url,
      blob,
      size: blob.size,
      type: blob.type || "image/png",
      savedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function revokeBlob(key) {
  const u = blobUrls.get(key);
  if (u) {
    try {
      URL.revokeObjectURL(u);
    } catch (_) {
      /* ignore */
    }
    blobUrls.delete(key);
  }
}

/** Cancella una mappa (tutte le varianti ?v= dello stesso file). */
export async function deleteLocalImage(src) {
  if (!src) return;
  const stem = urlStem(src);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result || []) {
        if (String(key) === stem || String(key).startsWith(stem + "?") || String(key) === absUrl(src)) {
          store.delete(key);
          revokeBlob(String(key));
        }
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Svuota tutta la cache immagini locale (IndexedDB + blob URL). */
export async function clearAllLocalImages() {
  for (const key of [...blobUrls.keys()]) revokeBlob(key);
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function hasLocalImage(src) {
  const rec = await getRecord(absUrl(src));
  return !!(rec && rec.blob);
}

/** Cerca in IndexedDB una PNG dello stesso path (anche con ?v= diverso). */
async function findBlobByStem(src) {
  const stem = urlStem(src);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = req.result || [];
      let best = null;
      for (const rec of rows) {
        if (!rec?.blob || rec.blob.size < 2000) continue;
        const k = String(rec.url || "");
        if (k === stem || k.startsWith(stem + "?") || urlStem(k) === stem) {
          if (!best || (rec.savedAt || 0) > (best.savedAt || 0)) best = rec;
        }
      }
      resolve(best);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Restituisce URL per <img>.
 * - Se c’è già la revisione esatta (?v=) in IndexedDB → locale.
 * - Se online e la revisione è nuova → scarica dal sito (non riusa PNG vecchie).
 * - Se offline → riusa la stessa mappa (anche con ?v= diverso).
 */
export async function resolveLocalImageUrl(src) {
  if (!src) throw new Error("URL immagine mancante");
  const key = absUrl(src);

  if (blobUrls.has(key)) return blobUrls.get(key);

  let existing = await getRecord(key);
  if (existing?.blob && existing.blob.size >= 2000) {
    const u = URL.createObjectURL(existing.blob);
    blobUrls.set(key, u);
    return u;
  }

  // Revisione nuova online: scarica subito (Aggiorna / seedRev / ?v=)
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const blob = await fetchMapBlob(src);
      try {
        await deleteLocalImage(src);
      } catch (_) {
        /* ignore */
      }
      try {
        await putRecord(key, blob);
      } catch (err) {
        console.warn("Quota IndexedDB immagini:", err);
      }
      const u = URL.createObjectURL(blob);
      blobUrls.set(key, u);
      return u;
    } catch (err) {
      console.warn("Download mappa (online) fallito, provo cache stem:", err);
    }
  }

  // Offline (o rete ko): riusa qualunque revisione dello stesso file
  try {
    existing = await findBlobByStem(src);
  } catch (_) {
    existing = null;
  }
  if (existing?.blob && existing.blob.size >= 2000) {
    try {
      if (String(existing.url) !== key) await putRecord(key, existing.blob);
    } catch (_) {
      /* ignore */
    }
    const u = URL.createObjectURL(existing.blob);
    blobUrls.set(key, u);
    return u;
  }

  const blob = await fetchMapBlob(src);
  try {
    await putRecord(key, blob);
  } catch (err) {
    console.warn("Quota IndexedDB immagini:", err);
  }
  const u = URL.createObjectURL(blob);
  blobUrls.set(key, u);
  return u;
}

/** Rimuove PNG obsolete (path senza ?v= o revisioni vecchie). */
export async function pruneStaleMapImages(maps) {
  const keep = new Set(
    (maps || [])
      .map((m) => m?.image)
      .filter(Boolean)
      .map((src) => absUrl(src))
  );
  const stems = new Set(
    [...keep].map((u) => {
      try {
        const x = new URL(u);
        x.search = "";
        return x.href;
      } catch (_) {
        return u.split("?")[0];
      }
    })
  );
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      for (const key of req.result || []) {
        const k = String(key);
        if (keep.has(k)) continue;
        // tieni solo URL esatte della revisione corrente
        let stem;
        try {
          const x = new URL(k);
          x.search = "";
          stem = x.href;
        } catch (_) {
          stem = k.split("?")[0];
        }
        if (stems.has(stem) || k.includes("/assets/maps/")) {
          store.delete(key);
          // Non revocare blob ancora mostrati in <img> (rompe la mappa a video)
          const blobUrl = blobUrls.get(k);
          if (!blobUrl || !document.querySelector(`img[src="${blobUrl}"]`)) {
            revokeBlob(k);
          } else {
            blobUrls.delete(k);
          }
        }
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Allinea la cache locale alle mappe attuali: cancella vecchie e scarica quelle nuove.
 * @param {{ image?: string, name?: string, id?: string }[]} maps
 * @param {(done: number, total: number, name: string) => void} [onProgress]
 * @param {{ force?: boolean }} [opts]
 */
export async function warmAllMapImages(maps, onProgress, opts = {}) {
  const list = (maps || []).filter((m) => m?.image);
  const force = !!opts.force;
  try {
    await pruneStaleMapImages(list);
  } catch (err) {
    console.warn("prune images", err);
  }
  const total = list.length;
  let done = 0;
  const concurrency = 4;
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const m = list[idx];
      const name = m.name || m.id || "";
      try {
        const key = absUrl(m.image);
        const have = force ? null : await getRecord(key);
        if (!have?.blob || have.blob.size < 2000) {
          if (force) {
            try {
              await deleteLocalImage(m.image);
            } catch (_) {
              /* ignore */
            }
          }
          const blob = await fetchMapBlob(m.image);
          try {
            await putRecord(key, blob);
          } catch (err) {
            console.warn("Quota IndexedDB:", err);
          }
        }
      } catch (err) {
        console.warn("warm map fail", m.id, err);
      }
      done += 1;
      if (onProgress) onProgress(done, total, name);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, () => worker())
  );
  return { done, total };
}

export async function countLocalImages() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}
