import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js?v=1.8.40";

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
    const [{ initializeApp, getApps, getApp }, { getFirestore }, { getStorage }] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js"),
    ]);
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    firestore = getFirestore(app);
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
            const { deleteLocalImage } = await import("./image-cache.js?v=1.8.40");
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
          const { deleteLocalImage } = await import("./image-cache.js?v=1.8.40");
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
    // Geometria e note utente vincono sempre
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
    });
  }
  for (const [key, loc] of localById) {
    if (!seen.has(key)) merged.push({ ...loc });
  }
  return merged;
}

export async function saveMap(map, { sync = true } = {}) {
  map.updatedAt = Date.now();
  await idbPut(map);
  let cloudSynced = false;
  let cloudError = null;
  if (sync && cloudReady) {
    try {
      await pushMapToCloud(map);
      cloudSynced = true;
      map.cloudPending = false;
      await idbPut(map);
    } catch (err) {
      cloudError = String(err?.message || err);
      console.warn("Sync cloud fallita:", err);
      map.cloudPending = true;
      await idbPut(map);
    }
  } else if (sync && !cloudReady) {
    map.cloudPending = true;
    await idbPut(map);
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
  keys.add(base);
  keys.add(stemSearchKey(base));
  for (const syn of QUERY_SYNONYMS[base] || []) {
    keys.add(normalizeSearchKey(syn));
    keys.add(stemSearchKey(syn));
  }
  // parole separate: "filtri carboni" -> FILTRI, CARBONI, ...
  for (const part of String(qRaw).split(/[\s,;./\\|+\---]+/)) {
    const p = normalizeSearchKey(part);
    if (p.length < 3) continue;
    keys.add(p);
    keys.add(stemSearchKey(p));
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
  keys.add(normalizeSearchKey(id));
  keys.add(normalizeSearchKey(label));
  const codePart = label.split(/\s+/)[0] || "";
  if (codePart) keys.add(normalizeSearchKey(codePart));
  // Nota: tutta la dicitura + singole parole (â‰¥3) per ritrovare dalla descrizione
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

/**
 * Ricerca semantica leggera: radici IT, sinonimi, tipo tag, proposte vicine.
 * @returns {Promise<Array<{mapId,mapName,tag,match:{score,tier,reason}}>>}
 */
/**
 * @param {string} query
 * @param {{ kind?: string|null }} [opts] kind = valore Tipo (pompa, valvola, ...) oppure "tutti"/vuoto
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
        const keys = tagSearchKeys(tag);
        const match = bestScoreForTag(queryKeys, keys);
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
    }
    return String(a.tag.id).localeCompare(String(b.tag.id), "it");
  });

  if (hasQuery) {
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

async function pushMapToCloud(map) {
  const { doc, setDoc, collection, writeBatch } = await import(
    "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
  );
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
    tagCount: (map.tags || []).length,
  });
  await setDoc(doc(firestore, "tagImpianto_maps", map.id), meta, { merge: true });

  const tags = map.tags || [];
  const CHUNK = 400;
  for (let i = 0; i < tags.length; i += CHUNK) {
    const batch = writeBatch(firestore);
    const slice = tags.slice(i, i + CHUNK);
    let n = 0;
    for (const tag of slice) {
      // Firestore: id senza "/" e non vuoto
      const id = String(tag.id || "")
        .trim()
        .replace(/\//g, "_")
        .slice(0, 700);
      if (!id) continue;
      const ref = doc(collection(firestore, "tagImpianto_maps", map.id, "tags"), id);
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
      // null su confidence: meglio omettere
      if (payload.confidence == null) delete payload.confidence;
      batch.set(ref, payload, { merge: true });
      n += 1;
    }
    if (!n) continue;
    try {
      await batch.commit();
    } catch (err) {
      throw new Error(`${map.id} tags[${i}...]: ${err?.message || err}`);
    }
  }
}

/** Carica dal cloud e unisce con IndexedDB (updatedAt più recente vince). */
export async function pullMapsFromCloud() {
  if (!cloudReady) return [];
  const { collection, getDocs } = await import(
    "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
  );
  const snap = await getDocs(collection(firestore, "tagImpianto_maps"));
  const localAll = await idbGetAll();
  const localById = new Map(localAll.map((m) => [m.id, m]));
  const maps = [];

  for (const d of snap.docs) {
    const meta = d.data();
    const tagsSnap = await getDocs(collection(firestore, "tagImpianto_maps", d.id, "tags"));
    const cloudTags = tagsSnap.docs.map((t) => t.data());
    const local = localById.get(d.id);
    const byId = new Map();
    for (const t of local?.tags || []) {
      if (t?.id) byId.set(String(t.id).toUpperCase(), t);
    }
    for (const t of cloudTags) {
      if (!t?.id) continue;
      const key = String(t.id).toUpperCase();
      byId.set(key, mergeTagCloudLocal(byId.get(key), t));
    }
    const cloudAt = Number(meta.updatedAt) || 0;
    const localAt = Number(local?.updatedAt) || 0;
    // Meta cloud = note/stato; geometria/PNG restano dal dispositivo (seed sito),
    // altrimenti un Firestore vecchio sovrascrive width/height e "rompe" i tag.
    const map = {
      ...(local || {}),
      ...meta,
      id: d.id,
      tags: [...byId.values()],
      updatedAt: Math.max(cloudAt, localAt, Date.now()),
      image: local?.image || meta.image,
      width: local?.width || meta.width,
      height: local?.height || meta.height,
      seedRev: Math.max(Number(local?.seedRev) || 0, Number(meta.seedRev) || 0),
      cropLeft: local?.cropLeft ?? meta.cropLeft,
      cropTop: local?.cropTop ?? meta.cropTop,
      area: local?.area || meta.area || "",
      name: local?.name || meta.name || d.id,
    };
    await idbPut(map);
    maps.push(map);
  }
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

/** Pull + push: allinea note/posizioni tra dispositivi (merge per updatedAt). */
export async function syncAllWithCloud() {
  if (!cloudReady) throw new Error("Cloud non pronto");
  try {
    await pullMapsFromCloud();
  } catch (err) {
    throw new Error(`Pull cloud: ${err?.message || err}`);
  }
  let n = 0;
  try {
    n = await pushAllMapsToCloud();
  } catch (err) {
    throw new Error(`Push cloud: ${err?.message || err}`);
  }
  try {
    await pullMapsFromCloud();
  } catch (err) {
    throw new Error(`Pull finale: ${err?.message || err}`);
  }
  return n;
}

/** Dopo init cloud: porta subito online note/riposizionamenti locali. */
export async function pushLocalChangesToCloud() {
  if (!cloudReady) return 0;
  const all = await idbGetAll();
  let n = 0;
  for (const map of all) {
    const pending = map.cloudPending;
    const hasNotes = (map.tags || []).some((t) => String(t?.note || "").trim());
    const hasManual = (map.tags || []).some(tagHasUserData);
    if (!pending && !hasNotes && !hasManual) continue;
    await pushMapToCloud(map);
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
