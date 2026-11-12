import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js?v=1.8.73";

const DB_NAME = "tag-impianto";
const DB_VER = 2;
const STORE = "maps";
const STORE_IMAGES = "images";

let idb;
let firestore = null;
let storage = null;
let cloudReady = false;

function openIdb() {
  if (idb) return idb;
  idb = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idb;
}

async function idbGetAll() {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(map) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(map);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isCloudReady() {
  return cloudReady;
}

export async function initCloud() {
  if (!isFirebaseConfigured()) {
    cloudReady = false;
    return { ok: false, reason: "Firebase non configurato" };
  }
  // Già connesso (secondo Sync / hot reload)
  if (cloudReady && firestore) return { ok: true };
  try {
    const [
      { initializeApp, getApps, getApp },
      { initializeFirestore, getFirestore },
      { getStorage },
    ] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js"),
    ]);
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    // Long polling: su tablet/PWA il canale WebChannel si blocca (1 tag/minuto).
    try {
      firestore = initializeFirestore(app, {
        experimentalForceLongPolling: true,
      });
    } catch {
      firestore = getFirestore(app);
    }
    storage = getStorage(app);
    cloudReady = true;
    return { ok: true };
  } catch (err) {
    cloudReady = false;
    return { ok: false, reason: String(err?.message || err) };
  }
}

function remapTagsAfterCrop(tags, cropLeft, oldW, newW) {
  return (tags || []).map((t) => {
    const x = Number(t.x) * oldW;
    const w = Number(t.w) * oldW;
    return {
      ...t,
      x: Math.max(0, (x - cropLeft) / newW),
      w: Math.max(0.02, w / newW),
    };
  });
}

/** Dopo ritaglio barra superiore (SF3 / HOLD-UP / ...). */
function remapTagsAfterCropTop(tags, cropTop, oldH, newH) {
  return (tags || [])
    .map((t) => {
      const y = Number(t.y) * oldH;
      const hh = Number(t.h) * oldH;
      let y2 = y - cropTop;
      let h2 = hh;
      if (y2 + h2 <= 2) return null;
      if (y2 < 0) {
        h2 += y2;
        y2 = 0;
      }
      const ny = Math.max(0, Math.min(1, y2 / newH));
      const nh = Math.max(0.012, Math.min(1 - ny, h2 / newH));
      return { ...t, y: ny, h: nh };
    })
    .filter(Boolean);
}

async function resolveSeedPaths() {
  try {
    const res = await fetch("./data/manifest.json", { cache: "no-store" });
    if (res.ok) {
      const man = await res.json();
      if (Array.isArray(man.maps) && man.maps.length) return man.maps;
    }
  } catch (_) {
    /* fallback sotto */
  }
  return [
    "./data/sediflottatore-b.json",
    "./data/biologico-mbbr-123.json",
    "./data/ultrafiltrazione-mbr-ad.json",
  ];
}

/**
 * All'avvio: se IndexedDB ha già le mappe, NON tocca la rete (offline-first).
 * Solo DB vuoto (primo avvio) scarica i seed dal sito.
 * Per aggiornare catalogo/immagini dal sito: forceReloadSeeds / Aggiorna.
 */
export async function loadSeedIfEmpty() {
  const existing = await idbGetAll();
  if (existing.length > 0) {
    return existing;
  }
  return mergeSeedsFromSite();
}

/** Scarica/merge seed dal sito (usato da Aggiorna / ripristino / primo avvio). */
export async function mergeSeedsFromSite() {
  const existing = await idbGetAll();
  const byId = new Map(existing.map((m) => [m.id, m]));
  const paths = await resolveSeedPaths();

  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) continue;
      const seed = await res.json();
      if (!seed?.id) continue;
      const local = byId.get(seed.id);

      if (!local) {
        seed.updatedAt = Date.now();
        await idbPut(seed);
        byId.set(seed.id, seed);
        continue;
      }

      let changed = false;
      const seedRev = Number(seed.seedRev) || 0;
      const localRev = Number(local.seedRev) || 0;
      const seedTagN = (seed.tags || []).length;
      const localTagN = (local.tags || []).length;
      // Aggiorna se revision più nuova OPPURE il seed ha molti più tag (fix catalogo/OCR)
      if (seedRev > localRev || seedTagN > localTagN + 3) {
        let localTags = local.tags || [];
        const seedCropTop = Number(seed.cropTop) || 0;
        const localCropTop = Number(local.cropTop) || 0;
        if (
          seedCropTop > localCropTop &&
          local.height &&
          seed.height &&
          local.height > seed.height
        ) {
          const dy = seedCropTop - localCropTop;
          localTags = remapTagsAfterCropTop(localTags, dy, local.height, seed.height);
        }
        const merged = mergeSeedTags(seed.tags || [], localTags);
        if (seed.image && seed.image !== local.image) {
          try {
            const { deleteLocalImage } = await import("./image-cache.js?v=1.8.73");
            await deleteLocalImage(local.image);
            await deleteLocalImage(seed.image);
          } catch (_) {
            /* ignore */
          }
        }
        local.image = seed.image || local.image;
        local.width = seed.width || local.width;
        local.height = seed.height || local.height;
        local.cropLeft = seed.cropLeft ?? local.cropLeft ?? 0;
        local.cropTop = seed.cropTop ?? local.cropTop ?? 0;
        local.name = seed.name || local.name;
        local.area = seed.area || local.area;
        local.notes = seed.notes || local.notes;
        local.seedRev = Math.max(seedRev, localRev, 1);
        local.tags = merged;
        local.updatedAt = Date.now();
        await idbPut(local);
        byId.set(seed.id, local);
        continue;
      }

      const cropLeft = Number(seed.cropLeft) || 0;
      if (
        cropLeft > 0 &&
        local.width &&
        seed.width &&
        local.width > seed.width &&
        local.width - seed.width === cropLeft
      ) {
        local.tags = remapTagsAfterCrop(local.tags, cropLeft, local.width, seed.width);
        local.width = seed.width;
        local.height = seed.height;
        local.cropLeft = cropLeft;
        changed = true;
      }

      const cropTop = Number(seed.cropTop) || 0;
      const localCropTop = Number(local.cropTop) || 0;
      if (
        cropTop > localCropTop &&
        local.height &&
        seed.height &&
        local.height > seed.height
      ) {
        local.tags = remapTagsAfterCropTop(
          local.tags,
          cropTop - localCropTop,
          local.height,
          seed.height
        );
        local.width = seed.width || local.width;
        local.height = seed.height;
        local.cropTop = cropTop;
        if (seed.image) local.image = seed.image;
        changed = true;
      }

      if (seed.image && local.image !== seed.image) {
        try {
          const { deleteLocalImage } = await import("./image-cache.js?v=1.8.73");
          await deleteLocalImage(local.image);
          await deleteLocalImage(seed.image);
        } catch (_) {
          /* ignore */
        }
        local.image = seed.image;
        if (seed.width) local.width = seed.width;
        if (seed.height) local.height = seed.height;
        if (seed.cropTop != null) local.cropTop = seed.cropTop;
        changed = true;
      }
      if (seed.width && local.width !== seed.width && !changed) {
        local.width = seed.width;
        local.height = seed.height;
        local.cropLeft = seed.cropLeft;
        if (!(local.tags || []).length) local.tags = seed.tags || [];
        changed = true;
      }
      if (seed.name && local.name !== seed.name) {
        local.name = seed.name;
        changed = true;
      }
      if (seed.area && local.area !== seed.area) {
        local.area = seed.area;
        changed = true;
      }

      if (changed) {
        local.updatedAt = Date.now();
        await idbPut(local);
      }
    } catch (err) {
      console.warn("Seed mappa non caricato:", path, err);
    }
  }

  return idbGetAll();
}

/**
 * Forza merge dei seed dal sito (tiene i tag manual/locked).
 * Usato dal pulsante Aggiorna.
 */
export async function forceReloadSeeds() {
  const existing = await idbGetAll();
  const byId = new Map(existing.map((m) => [m.id, m]));
  const paths = await resolveSeedPaths();
  let updated = 0;

  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) continue;
      const seed = await res.json();
      if (!seed?.id) continue;
      const local = byId.get(seed.id);
      if (!local) {
        seed.updatedAt = Date.now();
        await idbPut(seed);
        byId.set(seed.id, seed);
        updated += 1;
        continue;
      }
      let localTags = local.tags || [];
      const seedCropTop = Number(seed.cropTop) || 0;
      const localCropTop = Number(local.cropTop) || 0;
      if (
        seedCropTop > localCropTop &&
        local.height &&
        seed.height &&
        local.height > seed.height
      ) {
        localTags = remapTagsAfterCropTop(
          localTags,
          seedCropTop - localCropTop,
          local.height,
          seed.height
        );
      }
      const merged = mergeSeedTags(seed.tags || [], localTags);
      local.image = seed.image || local.image;
      local.width = seed.width || local.width;
      local.height = seed.height || local.height;
      local.cropLeft = seed.cropLeft ?? local.cropLeft ?? 0;
      local.cropTop = seed.cropTop ?? local.cropTop ?? 0;
      local.name = seed.name || local.name;
      local.area = seed.area || local.area;
      local.notes = seed.notes || local.notes;
      local.seedRev = Math.max(Number(seed.seedRev) || 0, Number(local.seedRev) || 0, 1);
      local.tags = merged;
      local.updatedAt = Date.now();
      await idbPut(local);
      byId.set(seed.id, local);
      updated += 1;
    } catch (err) {
      console.warn("forceReloadSeeds", path, err);
    }
  }
  return { updated, maps: await idbGetAll() };
}

/** Cancella le mappe locali e ricarica i seed dal sito (ripristino). */
export async function resetMapsFromSeed() {
  const db = await openIdb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return loadSeedIfEmpty();
}

export async function listMaps() {
  const local = await idbGetAll();
  local.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "it"));
  return local;
}

export async function getMap(id) {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function tagHasUserData(t) {
  return !!(
    t?.locked ||
    t?.source === "manual" ||
    String(t?.note || "").trim() ||
    // Riposizionato almeno una volta (anche senza flag locked vecchio)
    Number(t?.updatedAt) > 0
  );
}

/** Ha dati utente (nota / riposizionato / manuale). */
function tagHasLocalEdits(t) {
  if (!t) return false;
  if (String(t.note || "").trim()) return true;
  if (t.locked || t.source === "manual") return true;
  return false;
}

function pendingKey(mapId, tagId) {
  return `${String(mapId || "")}::${String(tagId || "").toUpperCase()}`;
}

/** Coda esplicita: SOLO ciò che l’utente ha salvato dopo il baseline. */
const PENDING_LS = "ti-cloud-pending-v3";
const PENDING_FLAG = "ti-sync-pending-v3";

function readPendingMap() {
  try {
    const raw = localStorage.getItem(PENDING_LS);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function writePendingMap(pend) {
  try {
    localStorage.setItem(PENDING_LS, JSON.stringify(pend));
  } catch (err) {
    console.warn("pending cloud registry write failed", err);
  }
}

/**
 * Da inviare SOLO se è in coda pending (Salva/sposta).
 * Mai più “tutte le note storiche” a ogni Sync.
 */
function tagNeedsCloudPush(t, mapId) {
  if (!t?.id || !mapId) return false;
  if (!tagHasLocalEdits(t)) return false;
  return !!readPendingMap()[pendingKey(mapId, t.id)];
}

function markTagCloudSynced(t, mapId, pend) {
  if (!t) return;
  const at = Number(t.updatedAt) || Date.now();
  t.updatedAt = at;
  t.cloudSyncedAt = at;
  if (mapId && t.id) {
    const p = pend || readPendingMap();
    delete p[pendingKey(mapId, t.id)];
    if (!pend) writePendingMap(p);
  }
}

function markTagsCloudSyncedMany(items) {
  const pend = readPendingMap();
  for (const { tag, mapId } of items) {
    markTagCloudSynced(tag, mapId, pend);
  }
  writePendingMap(pend);
}

/** Dopo modifica locale: entra in coda Sync (solo questo tag). */
export function markTagPendingCloud(t, mapId) {
  if (!t) return;
  t.updatedAt = Date.now();
  delete t.cloudSyncedAt;
  if (mapId && t.id) {
    const pend = readPendingMap();
    pend[pendingKey(mapId, t.id)] = t.updatedAt;
    writePendingMap(pend);
  }
}

/** Quanti tag sono in coda Sync (per UI). */
export function countPendingCloud() {
  return Object.keys(readPendingMap()).length;
}

function withTimeout(promise, ms, label) {
  let timer;
  // Evita rejection non gestita se setDoc finisce DOPO il timeout
  const guarded = Promise.resolve(promise).catch((err) => {
    if (err && err.__tiTimeout) throw err;
    const e = err instanceof Error ? err : new Error(String(err));
    throw e;
  });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timeout ${label} (${Math.round(ms / 1000)}s)`);
      err.__tiTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}

let firestoreModPromise = null;
function loadFirestoreMod() {
  if (!firestoreModPromise) {
    firestoreModPromise = import(
      "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
    );
  }
  return firestoreModPromise;
}

/**
 * Unisce tag seed + locali: le coordinate locali NON si perdono mai se il tag esiste già.
 * Il seed può aggiornare label/kind/image meta, non cancellare il lavoro di riposizionamento.
 */
function mergeSeedTags(seedTags, localTags) {
  const localById = new Map(
    (localTags || [])
      .filter((t) => t?.id)
      .map((t) => [String(t.id).toUpperCase(), t])
  );
  const merged = [];
  const seen = new Set();
  for (const st of seedTags || []) {
    if (!st?.id) continue;
    const key = String(st.id).toUpperCase();
    const loc = localById.get(key);
    seen.add(key);
    if (!loc) {
      merged.push({ ...st });
      continue;
    }
    // Geometria e note utente vincono sempre (cloudSyncedAt locale non si perde)
    merged.push({
      ...st,
      ...loc,
      id: loc.id || st.id,
      label: loc.label || st.label,
      kind: loc.kind || st.kind,
      x: loc.x != null ? loc.x : st.x,
      y: loc.y != null ? loc.y : st.y,
      w: loc.w != null ? loc.w : st.w,
      h: loc.h != null ? loc.h : st.h,
      note: String(loc.note || "").trim() ? loc.note : st.note,
      locked: !!(loc.locked || st.locked),
      source: loc.source || st.source,
      updatedAt: Math.max(Number(loc.updatedAt) || 0, Number(st.updatedAt) || 0) || undefined,
      cloudSyncedAt: loc.cloudSyncedAt,
    });
  }
  for (const [key, loc] of localById) {
    if (!seen.has(key)) merged.push({ ...loc });
  }
  return merged;
}

/**
 * Salva in IndexedDB. Di default NON tocca Firebase (veloce, non blocca la UI).
 * Il cloud si fa con Sync (solo novità).
 */
export async function saveMap(map, { sync = false } = {}) {
  map.updatedAt = Date.now();
  // Qualcosa da mandare al prossimo Sync
  if ((map.tags || []).some((t) => tagNeedsCloudPush(t, map.id))) {
    map.cloudPending = true;
  }
  await idbPut(map);
  let cloudSynced = false;
  let cloudError = null;
  if (sync && cloudReady) {
    try {
      await pushMapToCloud(map, { onlyUserTags: true });
      cloudSynced = true;
      map.cloudPending = false;
      await idbPut(map);
    } catch (err) {
      cloudError = String(err?.message || err);
      console.warn("Sync cloud fallita:", err);
      map.cloudPending = true;
      await idbPut(map);
    }
  }
  return { map, cloudSynced, cloudError };
}

/** Confronti ricerca: ignora spazi, -, _, punti e maiuscole (tk 11002 â‰ˆ TK-11002 â‰ˆ tk11002). */
export function normalizeSearchKey(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Etichette tipo tag (anche per ricerca semantica). */
const KIND_WORDS = {
  pompa: ["pompa", "pompe", "pump"],
  valvola: ["valvola", "valvole", "valve"],
  serbatoio: ["serbatoio", "serbatoi", "tank", "vasca", "vasche"],
  apparecchio: ["apparecchio", "apparecchi"],
  filtro: ["filtro", "filtri", "filter", "filtrazione"],
  strumento: ["strumento", "strumenti", "misura"],
  mixer: ["mixer", "mescolatore", "agitatore"],
  compressor: ["compressore", "compressori", "compressor"],
  altro: ["altro"],
};

/** Sinonimi / espansioni query -> chiavi normalizzate. */
const QUERY_SYNONYMS = {
  FILTRI: ["FILTRO", "FILTRAZIONE", "FILTER"],
  FILTRO: ["FILTRI", "FILTRAZIONE", "FILTER"],
  FILTRAZIONE: ["FILTRO", "FILTRI"],
  POMPE: ["POMPA", "PUMP"],
  POMPA: ["POMPE", "PUMP"],
  VALVOLE: ["VALVOLA", "VALVE", "XV"],
  VALVOLA: ["VALVOLE", "VALVE"],
  SERBATOI: ["SERBATOIO", "TANK", "VASCA"],
  SERBATOIO: ["SERBATOI", "TANK", "VASCA"],
  VASCHE: ["VASCA", "SERBATOIO"],
  VASCA: ["VASCHE", "SERBATOIO"],
};

/**
 * Prefissi sigla equivalenti: MP ≈ P (P abbreviazione di MP).
 * Solo se dopo il prefisso c'è almeno una cifra (evita di listare tutte le P cercando solo "MP").
 */
function expandSiglaPrefixKeys(key) {
  const k = normalizeSearchKey(key);
  if (!k) return [];
  const out = new Set([k]);
  if (/^MP\d/.test(k)) out.add(`P${k.slice(2)}`);
  if (/^P\d/.test(k)) out.add(`MP${k.slice(1)}`);
  return [...out];
}

/**
 * Radice "soft" IT: filtri/filtro -> FILTR, pompe/pompa -> POMP.
 * Serve a match semantici senza dizionario completo.
 */
export function stemSearchKey(s) {
  let w = normalizeSearchKey(s);
  if (w.length < 4) return w;
  if (w.endsWith("ZIONE") || w.endsWith("ZIONI")) {
    w = w.replace(/ZIONI?$/, "");
  } else if (w.endsWith("MENTI") || w.endsWith("MENTO")) {
    w = w.replace(/MENT[IO]$/, "");
  } else if (w.endsWith("AGGI") || w.endsWith("AGGIO")) {
    w = w.replace(/AGGI?O?$/, "AGG");
  } else if (w.endsWith("IONI")) {
    w = w.slice(0, -1); // AZIONI -> AZIONE-ish: drop I
  } else if (w.endsWith("HE") && w.length > 4) {
    w = w.slice(0, -1); // vecchie -> vecch
  } else if (w.endsWith("I") && w.length > 4 && !/(AI|OI|UI)$/.test(w)) {
    w = w.slice(0, -1); // FILTRI -> FILTR
  } else if (w.endsWith("E") && w.length > 4) {
    w = w.slice(0, -1); // POMPE -> POMP, VALVOLE -> VALVOL
  } else if (/(A|O)$/.test(w) && w.length > 4) {
    w = w.slice(0, -1); // FILTRO -> FILTR, POMPA -> POMP
  }
  return w.length >= 3 ? w : normalizeSearchKey(s);
}

function expandQueryKeys(qRaw) {
  const base = normalizeSearchKey(qRaw);
  const keys = new Set();
  if (!base) return [];
  for (const v of expandSiglaPrefixKeys(base)) {
    keys.add(v);
    keys.add(stemSearchKey(v));
  }
  for (const syn of QUERY_SYNONYMS[base] || []) {
    keys.add(normalizeSearchKey(syn));
    keys.add(stemSearchKey(syn));
  }
  // parole separate: "filtri carboni" -> FILTRI, CARBONI, ...
  for (const part of String(qRaw).split(/[\s,;./\\|+\---]+/)) {
    const p = normalizeSearchKey(part);
    if (p.length < 3) continue;
    for (const v of expandSiglaPrefixKeys(p)) {
      keys.add(v);
      keys.add(stemSearchKey(v));
    }
    for (const syn of QUERY_SYNONYMS[p] || []) {
      keys.add(normalizeSearchKey(syn));
      keys.add(stemSearchKey(syn));
    }
  }
  return [...keys].filter(Boolean);
}

function tagSearchKeys(tag) {
  const id = String(tag.id || "");
  const label = String(tag.label || "");
  const note = String(tag.note || "").trim();
  const kind = String(tag.kind || "").trim();
  const keys = new Set();
  for (const v of expandSiglaPrefixKeys(id)) keys.add(v);
  for (const v of expandSiglaPrefixKeys(label)) keys.add(v);
  const codePart = label.split(/\s+/)[0] || "";
  if (codePart) {
    for (const v of expandSiglaPrefixKeys(codePart)) keys.add(v);
  }
  // Nota: frase intera + singole parole (≥3) per ritrovare dalla descrizione
  if (note) {
    keys.add(normalizeSearchKey(note));
    for (const word of note.split(/[\s,;./\\|+\---]+/)) {
      if (word.length >= 3) {
        const k = normalizeSearchKey(word);
        keys.add(k);
        keys.add(stemSearchKey(k));
      }
    }
  }
  // Tipo / kind + sinonimi (filtro ->” filtri)
  if (kind) {
    keys.add(normalizeSearchKey(kind));
    keys.add(stemSearchKey(kind));
    for (const w of KIND_WORDS[kind] || []) {
      keys.add(normalizeSearchKey(w));
      keys.add(stemSearchKey(w));
    }
  }
  // Stem anche di id/label per near semantic
  keys.add(stemSearchKey(id));
  keys.add(stemSearchKey(label));
  return [...keys].filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[b.length];
}

/** Punteggio 0-100 + motivo leggibile per suggerimenti "intelligenti". */
function scoreAgainstKey(q, key) {
  if (!q || !key) return null;
  if (key === q) {
    return { score: 100, tier: "exact", reason: "Corrispondenza esatta" };
  }

  // Semantica leggera: stessa radice (filtri ->” filtro, pompe ->” pompa)
  const qs = stemSearchKey(q);
  const ks = stemSearchKey(key);
  if (qs.length >= 3 && ks.length >= 3) {
    if (qs === ks) {
      return {
        score: 94,
        tier: "exact",
        reason: "Stesso significato (singolare/plurale o radice)",
      };
    }
    if (qs.startsWith(ks) || ks.startsWith(qs)) {
      const diff = Math.abs(qs.length - ks.length);
      if (diff <= 3) {
        return {
          score: 90 - diff,
          tier: "exact",
          reason: "Radice simile (ricerca semantica)",
        };
      }
    }
  }

  if (key.startsWith(q)) {
    return {
      score: 92 - Math.min(10, key.length - q.length),
      tier: "exact",
      reason: "Inizia con la sigla digitata",
    };
  }
  if (q.startsWith(key) && key.length >= 4) {
    return {
      score: 88,
      tier: "exact",
      reason: "Sigla più corta, stesso inizio",
    };
  }
  if (key.includes(q) && q.length >= 3) {
    return {
      score: 82,
      tier: "exact",
      reason: "Contiene la sequenza digitata",
    };
  }
  if (q.includes(key) && key.length >= 4) {
    return {
      score: 78,
      tier: "near",
      reason: "Hai digitato più caratteri del necessario",
    };
  }

  const dist = levenshtein(q, key);
  const maxLen = Math.max(q.length, key.length);
  const sim = 1 - dist / maxLen;

  // 1-2 caratteri di differenza (trattino già ignorato in normalize)
  if (q.length >= 4 && dist <= 2) {
    return {
      score: Math.round(70 - dist * 8 + sim * 15),
      tier: "near",
      reason:
        dist === 1
          ? "Sigla vicina (forse 1 carattere diverso / mancante)"
          : "Sigla simile (piccola differenza)",
    };
  }
  if (q.length >= 5 && sim >= 0.75) {
    return {
      score: 55 + Math.round(sim * 20),
      tier: "near",
      reason: "Possibile corrispondenza per somiglianza",
    };
  }

  // stesso "nucleo" numerico: TK11002 vs 11002 o P11100A vs 11100A
  const qDigits = q.replace(/\D/g, "");
  const kDigits = key.replace(/\D/g, "");
  if (qDigits.length >= 4 && kDigits.includes(qDigits)) {
    return {
      score: 74,
      tier: "near",
      reason: "Stesso numero di tag, prefisso diverso o assente",
    };
  }
  if (kDigits.length >= 4 && qDigits.includes(kDigits) && q.length >= 4) {
    return {
      score: 72,
      tier: "near",
      reason: "Numero interno della sigla riconosciuto",
    };
  }

  return null;
}

function bestScoreForTag(queryKeys, tagKeys) {
  let best = null;
  for (const q of queryKeys) {
    for (const key of tagKeys) {
      const s = scoreAgainstKey(q, key);
      if (!s) continue;
      if (!best || s.score > best.score) best = { ...s, key, q };
    }
  }
  return best;
}

/** Parole significative della query (≥3 lettere/cifre normalizzate). */
function queryTokens(qRaw) {
  return String(qRaw || "")
    .split(/[\s,;./\\|+\---]+/)
    .map((w) => normalizeSearchKey(w))
    .filter((w) => w.length >= 3);
}

const KIND_TOKEN_SET = new Set(
  Object.values(KIND_WORDS)
    .flat()
    .map((w) => normalizeSearchKey(w))
    .concat(Object.keys(KIND_WORDS).map((k) => normalizeSearchKey(k)))
);

function isKindishToken(tok) {
  if (!tok) return false;
  if (KIND_TOKEN_SET.has(tok)) return true;
  const st = stemSearchKey(tok);
  for (const k of KIND_TOKEN_SET) {
    if (stemSearchKey(k) === st) return true;
  }
  return false;
}

/** Token presente in nota/etichetta/id (non solo nel tipo). */
function tokenInTagText(tok, noteN, labelN, idN) {
  if (!tok) return false;
  const variants = expandSiglaPrefixKeys(tok);
  for (const t of variants.length ? variants : [tok]) {
    if (noteN.includes(t) || labelN.includes(t) || idN.includes(t)) return true;
    const st = stemSearchKey(t);
    if (st.length >= 3) {
      if (noteN.includes(st) || labelN.includes(st) || idN.includes(st)) return true;
    }
  }
  return false;
}

/**
 * Punteggio tag: priorità alle NOTE.
 * Evita che "pompa …" faccia match su tutte le pompe solo per il tipo.
 */
export function scoreTagForQuery(qRaw, tag) {
  const noteN = normalizeSearchKey(tag.note);
  const labelN = normalizeSearchKey(tag.label || "");
  const idN = normalizeSearchKey(tag.id || "");
  const qFull = normalizeSearchKey(qRaw);
  const tokens = queryTokens(qRaw);
  const tagKeys = tagSearchKeys(tag);

  // Frase intera nella nota / etichetta / sigla (anche MP ↔ P)
  if (qFull.length >= 4) {
    for (const alt of expandSiglaPrefixKeys(qFull)) {
      if (alt.length < 4) continue;
      if (noteN && noteN.includes(alt)) {
        return {
          score: 100,
          tier: "exact",
          reason: alt === qFull ? "Nota: testo cercato" : "Nota: MP≈P",
        };
      }
      if (labelN && labelN.includes(alt)) {
        return {
          score: 99,
          tier: "exact",
          reason: alt === qFull ? "Etichetta: testo cercato" : "Sigla: MP≈P",
        };
      }
      if (idN && idN.includes(alt)) {
        return {
          score: 98,
          tier: "exact",
          reason: alt === qFull ? "Sigla: testo cercato" : "Sigla: MP≈P",
        };
      }
    }
  }

  // Più parole: devono stare (quasi tutte) nel testo; il solo tipo non basta
  if (tokens.length >= 2) {
    const textHits = tokens.filter((t) => tokenInTagText(t, noteN, labelN, idN));
    const distinctive = tokens.filter((t) => !isKindishToken(t));
    const distTextHits = distinctive.filter((t) =>
      tokenInTagText(t, noteN, labelN, idN)
    );

    if (textHits.length === tokens.length) {
      return {
        score: 97,
        tier: "exact",
        reason: "Nota/etichetta: tutte le parole",
      };
    }
    // Parole distintive (es. riciclofanghi) obbligatoriamente nel testo
    if (distinctive.length && distTextHits.length === distinctive.length) {
      const kindOk = tokens
        .filter((t) => isKindishToken(t))
        .every(
          (t) =>
            tokenInTagText(t, noteN, labelN, idN) ||
            !!bestScoreForTag([t, stemSearchKey(t)], tagKeys)
        );
      if (kindOk || !tokens.some((t) => isKindishToken(t))) {
        return {
          score: 95,
          tier: "exact",
          reason: "Nota: parole chiave trovate",
        };
      }
      return {
        score: 93,
        tier: "exact",
        reason: "Nota: corrispondenza principale",
      };
    }
    // Almeno una distintiva nel testo + altre parole (anche tipo)
    if (distTextHits.length >= 1) {
      let otherOk = 0;
      for (const t of tokens) {
        if (tokenInTagText(t, noteN, labelN, idN)) {
          otherOk++;
          continue;
        }
        if (bestScoreForTag([t, stemSearchKey(t)], tagKeys)) otherOk++;
      }
      if (otherOk === tokens.length) {
        return {
          score: 88,
          tier: "exact",
          reason: "Nota + tipo",
        };
      }
      if (distTextHits.length === distinctive.length && otherOk >= tokens.length - 1) {
        return {
          score: 80,
          tier: "near",
          reason: "Nota quasi completa",
        };
      }
    }
    // Niente parole distintive nel testo → non elencare tutte le pompe/valvole
    return null;
  }

  // Una sola parola: match classico, ma il solo tipo vale meno
  const queryKeys = expandQueryKeys(qRaw);
  const best = bestScoreForTag(queryKeys, tagKeys);
  if (!best || best.score < 55) return null;

  const onlyKind =
    isKindishToken(tokens[0] || qFull) &&
    !tokenInTagText(tokens[0] || qFull, noteN, labelN, idN) &&
    best.score >= 88;

  if (onlyKind) {
    return {
      score: Math.min(68, best.score - 25),
      tier: "near",
      reason: `Tipo: ${String(tag.kind || "").trim() || "altro"}`,
    };
  }

  // Match nota/etichetta a singola parola
  if (tokenInTagText(tokens[0] || qFull, noteN, labelN, idN)) {
    return {
      score: Math.max(best.score, 96),
      tier: "exact",
      reason: noteN ? "Trovato nella nota" : "Trovato in etichetta/sigla",
    };
  }

  return best;
}

/**
 * Ricerca semantica leggera: radici IT, sinonimi, tipo tag, proposte vicine.
 * Priorità alle note utente (non annegate tra centinaia di match per "tipo").
 * @param {string} query
 * @param {{ kind?: string|null }} [opts] kind = valore Tipo (pompa, valvola, ...) oppure "tutti"/vuoto
 * @returns {Promise<Array<{mapId,mapName,tag,match:{score,tier,reason}}>>}
 */
export async function searchAllTags(query, opts = {}) {
  const kindRaw = String(opts.kind || "tutti").trim().toLowerCase();
  const kindFilter = !kindRaw || kindRaw === "tutti" ? null : kindRaw;
  const qRaw = String(query || "").trim();
  const queryKeys = expandQueryKeys(qRaw);
  const hasQuery = queryKeys.length > 0 && !queryKeys.every((k) => k.length < 2);

  // Senza testo: solo se c'è un filtro tipo (sfoglia quella categoria)
  if (!hasQuery && !kindFilter) return [];

  const maps = await listMaps();
  const hits = [];
  for (const map of maps) {
    for (const tag of map.tags || []) {
      const tagKind = String(tag.kind || "altro").toLowerCase();
      if (kindFilter && tagKind !== kindFilter) continue;

      if (hasQuery) {
        const match = scoreTagForQuery(qRaw, tag);
        if (!match || match.score < 55) continue;
        hits.push({
          mapId: map.id,
          mapName: map.name,
          tag,
          match: {
            score: match.score,
            tier: match.tier,
            reason: match.reason,
          },
        });
      } else {
        hits.push({
          mapId: map.id,
          mapName: map.name,
          tag,
          match: {
            score: 100,
            tier: "exact",
            reason: `Tipo: ${tagKind}`,
          },
        });
      }
    }
  }

  hits.sort((a, b) => {
    if (hasQuery) {
      if (b.match.score !== a.match.score) return b.match.score - a.match.score;
      if (a.match.tier !== b.match.tier) return a.match.tier === "exact" ? -1 : 1;
      // A parità: prima chi ha nota (più utile in ricerca testuale)
      const an = String(a.tag.note || "").trim() ? 1 : 0;
      const bn = String(b.tag.note || "").trim() ? 1 : 0;
      if (bn !== an) return bn - an;
    }
    return String(a.tag.id).localeCompare(String(b.tag.id), "it");
  });

  if (hasQuery) {
    const strong = hits.filter((h) => h.match.score >= 88);
    if (strong.length >= 1) {
      return strong.slice(0, 40);
    }
    const exactCount = hits.filter((h) => h.match.tier === "exact").length;
    if (exactCount >= 8) {
      return hits.filter((h) => h.match.tier === "exact").slice(0, 40);
    }
  }
  return hits.slice(0, 60);
}

function mergeTagCloudLocal(localTag, cloudTag) {
  if (!localTag) return { ...cloudTag };
  if (!cloudTag) return { ...localTag };
  const lt = Number(localTag.updatedAt) || 0;
  const ct = Number(cloudTag.updatedAt) || 0;
  const localUser = tagHasUserData(localTag);
  const cloudUser = tagHasUserData(cloudTag);
  // Note / riposizionamenti locali non devono sparire per un seed cloud più fresco
  if (localUser && !cloudUser) return { ...localTag };
  if (cloudUser && !localUser) return { ...cloudTag };
  if (localUser && cloudUser) {
    // Entrambi "utente": più recente, ma tieni geometria del più recente
    return ct > lt ? { ...cloudTag } : { ...localTag };
  }
  if (ct > lt) return { ...cloudTag };
  if (lt > ct) return { ...localTag };
  return { ...localTag };
}

/** Firestore rifiuta `undefined` -> togli i campi vuoti. */
function stripUndefined(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function tagCloudPayload(tag, map) {
  const id = String(tag.id || "")
    .trim()
    .replace(/\//g, "_")
    .slice(0, 700);
  if (!id) return null;
  const payload = stripUndefined({
    id,
    label: tag.label || id,
    kind: tag.kind || "altro",
    x: Number(tag.x) || 0,
    y: Number(tag.y) || 0,
    w: Number(tag.w) || 0.04,
    h: Number(tag.h) || 0.05,
    note: tag.note || "",
    source: tag.source || "manual",
    locked: !!tag.locked,
    confidence: tag.confidence == null ? null : Number(tag.confidence),
    updatedAt: Number(tag.updatedAt) || Number(map.updatedAt) || Date.now(),
  });
  if (payload.confidence == null) delete payload.confidence;
  return { id, payload };
}

function firestoreRestValue(v) {
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number" && Number.isFinite(v)) {
    if (Math.floor(v) === v && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
      return { integerValue: String(v) };
    }
    return { doubleValue: v };
  }
  return { stringValue: v == null ? "" : String(v) };
}

function firestoreTagDocName(mapId, tagId) {
  const seg = (s) => encodeURIComponent(String(s));
  return `projects/${firebaseConfig.projectId}/databases/(default)/documents/tagImpianto_maps/${seg(mapId)}/tags/${seg(tagId)}`;
}

/** Un POST HTTP: niente WebChannel SDK (quello che sul tablet resta appeso). */
async function firestoreRestCommit(writes, timeoutMs) {
  const url =
    `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}` +
    `/databases/(default)/documents:commit?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ writes }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Firestore HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Timeout invio (${Math.round(timeoutMs / 1000)}s)`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tutte le note in 1 richiesta HTTP (file microscopici).
 * Dopo l'OK escono dalla coda: il Sync successivo non riparte da capo.
 * @returns {Promise<{ wrote: number, errors: string[] }>}
 */
async function commitTagQueue(queue, report) {
  if (!queue.length) return { wrote: 0, errors: [] };
  const CHUNK = 200;
  let wrote = 0;
  const errors = [];

  async function persistMaps(items) {
    const maps = new Map();
    for (const { map } of items) maps.set(map.id, map);
    for (const map of maps.values()) {
      map.cloudPending = (map.tags || []).some((t) =>
        tagNeedsCloudPush(t, map.id)
      );
      try {
        await idbPut(map);
      } catch (err) {
        console.warn("idbPut dopo sync", map.id, err);
      }
    }
  }

  for (let i = 0; i < queue.length; i += CHUNK) {
    const slice = queue.slice(i, i + CHUNK);
    const writes = [];
    const okItems = [];
    for (const item of slice) {
      const { map, tag } = item;
      if (!tagNeedsCloudPush(tag, map.id)) continue;
      const packed = tagCloudPayload(tag, map);
      if (!packed) continue;
      const fields = {};
      for (const [k, v] of Object.entries(packed.payload)) {
        fields[k] = firestoreRestValue(v);
      }
      writes.push({
        update: {
          name: firestoreTagDocName(map.id, packed.id),
          fields,
        },
      });
      okItems.push(item);
    }
    if (!writes.length) continue;
    report(`Invio ${writes.length} note in un colpo…`);
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await firestoreRestCommit(writes, 20000);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        report(
          attempt === 1
            ? `Rete lenta, riprovo lo stesso invio…`
            : `Invio non riuscito`
        );
      }
    }
    if (lastErr) {
      errors.push(String(lastErr?.message || lastErr));
      continue;
    }
    markTagsCloudSyncedMany(
      okItems.map(({ map, tag }) => ({ tag, mapId: map.id }))
    );
    await persistMaps(okItems);
    wrote += okItems.length;
    report(`Inviate ${wrote}…`);
  }

  return { wrote, errors };
}

/**
 * @param {object} map
 * @param {{ onlyUserTags?: boolean, onProgress?: (msg: string) => void }} [opts]
 */
async function pushMapToCloud(map, opts = {}) {
  const onlyUserTags = !!opts.onlyUserTags;
  const report = (msg) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* ignore */
    }
  };
  const allTags = map.tags || [];
  let tags = onlyUserTags
    ? allTags.filter((t) => tagNeedsCloudPush(t, map.id))
    : allTags;
  if (onlyUserTags) {
    tags = [...tags].sort(
      (a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
    );
  }
  if (!tags.length) return 0;

  if (!onlyUserTags) {
    const { doc, setDoc } = await loadFirestoreMod();
    const meta = stripUndefined({
      id: map.id,
      name: map.name || map.id,
      image: map.image || "",
      width: Number(map.width) || 0,
      height: Number(map.height) || 0,
      area: map.area || "",
      notes: map.notes || "",
      seedRev: Number(map.seedRev) || 0,
      updatedAt: Number(map.updatedAt) || Date.now(),
      tagCount: allTags.length,
      userTagCount: allTags.filter((t) => tagHasLocalEdits(t)).length,
    });
    await withTimeout(
      setDoc(doc(firestore, "tagImpianto_maps", map.id), meta, { merge: true }),
      10000,
      `meta ${map.id}`
    );
  }

  const { wrote } = await commitTagQueue(
    tags.map((tag) => ({ map, tag })),
    report
  );
  return wrote;
}

/**
 * Baseline una tantum (v3):
 * - storico senza sync recente → già a posto (NON in coda)
 * - modifiche recenti non inviate → restano in coda pending
 * Dopo il flag, solo Salva/sposta aggiunge alla coda.
 */
async function migrateExistingEditsAsSynced() {
  try {
    if (localStorage.getItem(PENDING_FLAG) === "1") return 0;
  } catch {
    return 0;
  }

  let oldSynced = {};
  try {
    const raw = localStorage.getItem("ti-tag-synced-v1");
    oldSynced = raw ? JSON.parse(raw) : {};
    if (!oldSynced || typeof oldSynced !== "object") oldSynced = {};
  } catch {
    oldSynced = {};
  }

  const pend = {};
  const now = Date.now();
  const RECENT_MS = 3 * 24 * 60 * 60 * 1000; // 3 giorni
  const all = await idbGetAll();
  let baselined = 0;
  let kept = 0;

  for (const map of all) {
    if (!map?.id || String(map.id).startsWith("__")) continue;
    let touched = false;
    for (const t of map.tags || []) {
      if (!tagHasLocalEdits(t) || !t.id) continue;
      const key = pendingKey(map.id, t.id);
      const updated = Number(t.updatedAt) || 0;
      const synced = Number(t.cloudSyncedAt) || 0;
      const regAt = Number(oldSynced[key] || 0);
      const effectiveSynced = Math.max(synced, regAt);

      // Sporco vero: modificato dopo un sync, oppure tocco recente mai syncato
      const dirtyAfterSync = effectiveSynced > 0 && updated > effectiveSynced;
      const recentNeverSynced =
        effectiveSynced <= 0 && updated > 0 && now - updated < RECENT_MS;

      if (dirtyAfterSync || recentNeverSynced) {
        pend[key] = updated || now;
        if (regAt > synced) t.cloudSyncedAt = regAt;
        kept += 1;
      } else {
        const at = Math.max(updated, effectiveSynced, now);
        t.updatedAt = updated || at;
        t.cloudSyncedAt = at;
        baselined += 1;
        touched = true;
      }
    }
    const wasPending = !!map.cloudPending;
    map.cloudPending = (map.tags || []).some(
      (t) => t?.id && !!pend[pendingKey(map.id, t.id)]
    );
    if (touched || wasPending || map.cloudPending) {
      await idbPut(map);
    }
  }

  writePendingMap(pend);
  try {
    localStorage.removeItem("ti-tag-synced-v1");
    localStorage.removeItem("ti-sync-dirty-v2");
    localStorage.setItem(PENDING_FLAG, "1");
  } catch {
    /* ignore */
  }
  return kept;
}

/**
 * Carica dal cloud e unisce con IndexedDB.
 * @param {{ preferCloud?: boolean, onlyChanged?: boolean, onProgress?: Function }} [opts]
 *   preferCloud=true → scarico completo (PC “Scarica cloud”).
 *   onlyChanged=true → scarica i tag solo se la mappa cloud è più recente (Sync tablet).
 */
export async function pullMapsFromCloud(opts = {}) {
  if (!cloudReady) return [];
  const preferCloud = !!opts.preferCloud;
  const onlyChanged = !!opts.onlyChanged && !preferCloud;
  const report = (msg) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* ignore */
    }
  };
  let lastPullAt = 0;
  try {
    lastPullAt = Number(localStorage.getItem("ti-cloud-pull-at") || 0) || 0;
  } catch {
    lastPullAt = 0;
  }

  const { collection, getDocs } = await loadFirestoreMod();
  report("Elenco mappe cloud...");
  const snap = await withTimeout(
    getDocs(collection(firestore, "tagImpianto_maps")),
    20000,
    "elenco mappe"
  );
  const localAll = await idbGetAll();
  const localById = new Map(localAll.map((m) => [m.id, m]));
  const maps = [];
  const docs = snap.docs;
  let fetchedTags = 0;
  let skipped = 0;

  for (let di = 0; di < docs.length; di++) {
    const d = docs[di];
    const meta = d.data() || {};
    const local = localById.get(d.id);
    const cloudAt = Number(meta.updatedAt) || 0;
    const localAt = Number(local?.updatedAt) || 0;

    // Sync tablet: salta mappe non più nuove del ultimo pull (tiene i dati locali)
    const unchanged =
      onlyChanged &&
      local &&
      Array.isArray(local.tags) &&
      local.tags.length > 0 &&
      cloudAt > 0 &&
      cloudAt <= lastPullAt &&
      cloudAt <= localAt + 1000;

    if (unchanged) {
      skipped += 1;
      maps.push(local);
      if (di === 0 || (di + 1) % 10 === 0 || di === docs.length - 1) {
        report(`Cloud · ${di + 1}/${docs.length} (salto ${skipped} già ok)`);
      }
      continue;
    }

    report(`Scarico ${meta.name || d.id} · ${di + 1}/${docs.length}`);
    let cloudTags = [];
    try {
      const tagsSnap = await withTimeout(
        getDocs(collection(firestore, "tagImpianto_maps", d.id, "tags")),
        15000,
        `tags ${d.id}`
      );
      cloudTags = tagsSnap.docs.map((t) => t.data());
      fetchedTags += 1;
    } catch (err) {
      console.warn("pull tags skip", d.id, err);
      report(`Salto ${meta.name || d.id} (lento)…`);
      if (local) maps.push(local);
      await new Promise((r) => setTimeout(r, 0));
      continue;
    }

    const byId = new Map();
    if (!preferCloud) {
      for (const t of local?.tags || []) {
        if (t?.id) byId.set(String(t.id).toUpperCase(), t);
      }
    }
    for (const t of cloudTags) {
      if (!t?.id) continue;
      const key = String(t.id).toUpperCase();
      if (preferCloud) {
        byId.set(key, { ...t });
      } else {
        byId.set(key, mergeTagCloudLocal(byId.get(key), t));
      }
    }

    const map = {
      ...(local || {}),
      ...meta,
      id: d.id,
      tags: [...byId.values()],
      updatedAt: preferCloud
        ? Math.max(cloudAt, Date.now())
        : Math.max(cloudAt, localAt, Date.now()),
      image: local?.image || meta.image,
      width: local?.width || meta.width,
      height: local?.height || meta.height,
      seedRev: Math.max(Number(local?.seedRev) || 0, Number(meta.seedRev) || 0),
      cropLeft: local?.cropLeft ?? meta.cropLeft,
      cropTop: local?.cropTop ?? meta.cropTop,
      area: local?.area || meta.area || "",
      name: local?.name || meta.name || d.id,
      cloudPending: preferCloud ? false : local?.cloudPending,
    };
    await idbPut(map);
    maps.push(map);
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!preferCloud) {
    try {
      localStorage.setItem("ti-cloud-pull-at", String(Date.now()));
    } catch {
      /* ignore */
    }
  }
  report(
    preferCloud
      ? `Cloud scaricato · ${maps.length} mappe`
      : `Cloud · ${fetchedTags} aggiornate · ${skipped} già ok`
  );
  return maps;
}

/** Carica TUTTE le mappe locali sul cloud (es. dal tablet più aggiornato). */
export async function pushAllMapsToCloud() {
  if (!cloudReady) throw new Error("Cloud non pronto");
  const all = (await idbGetAll()).filter((m) => m?.id && !String(m.id).startsWith("__"));
  let ok = 0;
  const errors = [];
  for (const map of all) {
    try {
      await pushMapToCloud(map);
      ok += 1;
    } catch (err) {
      errors.push(`${map.id}: ${err?.message || err}`);
      console.warn("pushMapToCloud", map.id, err);
    }
  }
  if (!ok && errors.length) {
    throw new Error(errors[0]);
  }
  if (errors.length) {
    console.warn("Push cloud parziale:", errors.slice(0, 5).join(" · "));
  }
  return ok;
}

/**
 * Sync tablet = solo novità, parallelo (veloce). Niente PNG / pull / IDB a ogni tag.
 * @param {{ onProgress?: (msg: string) => void }} [opts]
 */
export async function syncAllWithCloud(opts = {}) {
  if (!cloudReady) throw new Error("Cloud non pronto");
  const report = (msg) => {
    try {
      opts.onProgress?.(msg);
    } catch {
      /* ignore */
    }
  };

  report("Cerco coda Sync…");
  const kept = await migrateExistingEditsAsSynced();
  if (kept > 0) {
    report(`Ripreso ${kept} modifiche recenti non ancora inviate…`);
  }

  const all = (await idbGetAll()).filter(
    (m) => m?.id && !String(m.id).startsWith("__")
  );
  // Coda = solo pending espliciti (mai tutto lo storico)
  const pend = readPendingMap();
  const queue = [];
  for (const map of all) {
    for (const tag of map.tags || []) {
      if (!tag?.id) continue;
      if (!pend[pendingKey(map.id, tag.id)]) continue;
      if (!tagHasLocalEdits(tag)) {
        delete pend[pendingKey(map.id, tag.id)];
        continue;
      }
      queue.push({ map, tag });
    }
  }
  writePendingMap(pend);
  queue.sort(
    (a, b) => (Number(b.tag.updatedAt) || 0) - (Number(a.tag.updatedAt) || 0)
  );

  if (!queue.length) {
    for (const map of all) {
      if (map.cloudPending) {
        map.cloudPending = false;
        await idbPut(map);
      }
    }
    report("Sync ok · coda vuota");
    return { mapsPushed: 0, tagsPushed: 0, errors: [] };
  }

  report(`In coda ${queue.length} · parto (i già ok non si rimandano)…`);
  const { wrote: tagsPushed, errors } = await commitTagQueue(queue, report);

  const still = countPendingCloud();
  const mapsPushed = new Set(
    queue
      .filter((q) => !tagNeedsCloudPush(q.tag, q.map.id))
      .map((q) => q.map.id)
  ).size;
  const errHint = errors.length ? ` · ${errors.length} errori` : "";
  const leftHint = still ? ` · restano ${still} in coda` : "";
  // Mai throw: anche 33/34 ok è Sync riuscita; i falliti restano in coda
  report(
    tagsPushed
      ? `Sync ok · ${tagsPushed} inviate${errHint}${leftHint}`
      : still
        ? `Sync: 0 inviate${errHint}${leftHint}`
        : `Sync ok · coda vuota${errHint}`
  );
  return { mapsPushed, tagsPushed, errors, pendingLeft: still };
}

/** Dopo init cloud: porta subito online note/riposizionamenti locali. */
export async function pushLocalChangesToCloud() {
  if (!cloudReady) return 0;
  const all = await idbGetAll();
  let n = 0;
  for (const map of all) {
    const pending = map.cloudPending;
    const hasPush = (map.tags || []).some((t) => tagNeedsCloudPush(t, map.id));
    if (!pending && !hasPush) continue;
    await pushMapToCloud(map, { onlyUserTags: true });
    map.cloudPending = false;
    await idbPut(map);
    n += 1;
  }
  return n;
}

export async function uploadMapImage(mapId, file) {
  if (!cloudReady || !storage) throw new Error("Cloud non pronto");
  const { ref, uploadBytes, getDownloadURL } = await import(
    "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js"
  );
  const path = `tagImpianto/maps/${mapId}/${file.name || "map.png"}`;
  const r = ref(storage, path);
  await uploadBytes(r, file);
  return getDownloadURL(r);
}
