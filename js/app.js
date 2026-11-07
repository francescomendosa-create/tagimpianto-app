import {
  initCloud,
  isCloudReady,
  loadSeedIfEmpty,
  forceReloadSeeds,
  resetMapsFromSeed,
  listMaps,
  getMap,
  saveMap,
  searchAllTags,
  syncAllWithCloud,
} from "./db.js?v=1.8.40";
import { isFirebaseConfigured } from "./firebase-config.js?v=1.8.40";
import { MapViewer } from "./viewer.js?v=1.8.40";
import { runMapOcr, mergeOcrIntoMap, ocrImageRegion } from "./ocr.js?v=1.8.40";
import { renderPlantNav, setPlantNavActive, pageForMapId } from "./plant-nav.js?v=1.8.40";
import { APP_VERSION, APP_BUILD } from "./version.js?v=1.8.40";
import {
  warmAllMapImages,
  countLocalImages,
  clearAllLocalImages,
} from "./image-cache.js?v=1.8.40";

const $ = (sel) => document.querySelector(sel);

const els = {
  mapSelect: $("#mapSelect"),
  mapTitle: $("#mapTitle"),
  plantNav: $("#plantNav"),
  updateBanner: $("#updateBanner"),
  updateBannerText: $("#updateBannerText"),
  btnUpdateNow: $("#btnUpdateNow"),
  searchInput: $("#searchInput"),
  searchKind: $("#searchKind"),
  clearBtn: $("#clearBtn"),
  suggestions: $("#suggestions"),
  status: $("#status"),
  btnAnnotate: $("#btnAnnotate"),
  btnRecalibrate: $("#btnRecalibrate"),
  btnAddTag: $("#btnAddTag"),
  btnOcr: $("#btnOcr"),
  btnRefresh: $("#btnRefresh"),
  btnSync: $("#btnSync"),
  btnNotes: $("#btnNotes"),
  drawer: $("#drawer"),
  noteTitle: $("#noteTitle"),
  noteBody: $("#noteBody"),
  noteKind: $("#noteKind"),
  noteSave: $("#noteSave"),
  noteDelete: $("#noteDelete"),
  noteClose: $("#noteClose"),
  toast: $("#toast"),
  cloudBadge: $("#cloudBadge"),
  appVersion: $("#appVersion"),
};

let maps = [];
let currentMap = null;
let activeTagId = null;
let annotateMode = false;
let addTagMode = false;
let recalibrateMode = false;
let addTagBusy = false;
let sugIndex = -1;
let toastTimer = 0;

const viewer = new MapViewer({
  viewport: $("#viewport"),
  world: $("#world"),
  imageEl: $("#mapImage"),
  overlayEl: $("#overlay"),
});

function turnOffAddModes() {
  addTagMode = false;
  recalibrateMode = false;
  viewer.setAddMode(false);
  els.btnAddTag?.classList.remove("active");
  els.btnRecalibrate?.classList.remove("active");
}

// Riposiziona: niente nuovi tag al tap - solo trascinamento del tag evidenziato
viewer.onAnnotatePlace = null;

/** Click/tap sul tag: barra ricerca = sigla [tipo] (+ nota) [pagina], senza suggerimenti. */
viewer.onTagDoubleSelect = (tag) => {
  if (!tag || !currentMap) return;
  const sigla = String(tag.label || tag.id || "").trim();
  if (!sigla) return;
  const text = formatTagSearchText(tag, currentMap.id, currentMap.name);
  const note = String(tag.note || "").trim();
  const kind = kindLabelForTag(tag);
  const page = pageLabelForMap(currentMap.id, currentMap.name);
  closeSuggestions();
  els.searchInput.value = text;
  els.clearBtn.classList.add("visible");
  activeTagId = tag.id;
  viewer.highlight(tag.id);
  const bits = [`<strong>${escapeHtml(sigla)}</strong>`];
  if (kind) bits.push(escapeHtml(`[${kind}]`));
  if (note) bits.push(escapeHtml(note));
  if (page) bits.push(escapeHtml(`[${page}]`));
  setStatus(bits.join(" · "));
};

viewer.onTagMoved = async (tagId) => {
  activeTagId = tagId;
  const tag = currentMap?.tags?.find((t) => t.id === tagId);
  if (tag) {
    tag.source = "manual";
    tag.locked = true;
    tag.updatedAt = Date.now();
  }
  const { cloudSynced } = await persistCurrent();
  toast(
    cloudSynced
      ? "Posizione salvata (locale + cloud)"
      : isCloudReady()
        ? "Posizione locale - cloud fallito, riprova Sync"
        : "Posizione salvata solo su questo dispositivo"
  );
};

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
}

function setStatus(html) {
  els.status.innerHTML = html;
}

/** Confronta semver semplici a.b.c */
function versionNewer(remote, local) {
  const parse = (v) =>
    String(v || "")
      .replace(/^v/i, "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((n) => Number(n) || 0);
  const a = parse(remote);
  const b = parse(local);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

let liveVersionCache = null;

/** Legge la versione pubblicata sul sito (bypass cache). Non tocca Firebase. */
async function fetchLiveAppVersion() {
  // 1) version.json (piccolo, deploy rapido)  2) fallback version.js
  try {
    const res = await fetch(`./version.json?_=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const j = await res.json();
      if (j?.version) {
        liveVersionCache = String(j.version);
        return liveVersionCache;
      }
    }
  } catch (_) {
    /* fallback sotto */
  }
  const res = await fetch(`./js/version.js?_=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(text);
  if (!m) throw new Error("version.js senza APP_VERSION");
  liveVersionCache = m[1];
  return m[1];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showUpdateBanner(liveVer) {
  if (!els.updateBanner) return;
  if (els.updateBannerText) {
    els.updateBannerText.textContent = `Nuova versione online: v${liveVer} (tu hai v${APP_VERSION})`;
  }
  els.updateBanner.hidden = false;
  document.body.classList.add("has-update-banner");
  els.btnRefresh?.classList.add("has-update");
}

function hideUpdateBanner() {
  if (!els.updateBanner) return;
  els.updateBanner.hidden = true;
  document.body.classList.remove("has-update-banner");
  els.btnRefresh?.classList.remove("has-update");
}

/**
 * Aggiorna l'app installata SENZA reinstallare:
 * pulisce SW/cache, aspetta che Pages pubblichi (se in ritardo), ricarica index pulito.
 */
async function applyAppUpdate({ wipeImages = false } = {}) {
  setStatus("Aggiornamento: pulizia cache...");
  toast("Aggiorno senza reinstallare...");
  try {
    // Solo catalogo seed al prossimo avvio - NON scaricare tutte le PNG
    localStorage.setItem("ti-force-seed", "1");
    localStorage.removeItem("ti-force-images");
  } catch (_) {
    /* ignore */
  }
  try {
    if (wipeImages) await clearAllLocalImages();
  } catch (_) {
    /* ignore */
  }

  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        try {
          reg.waiting?.postMessage({ type: "SKIP_WAITING" });
        } catch (_) {
          /* ignore */
        }
        await reg.unregister();
      }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn("Pulizia cache app:", err);
  }

  // Se online c'è già una versione più nuova -> ok.
  // Se Pages sta ancora pubblicando, aspetta fino a ~90s una più nuova della tua.
  setStatus("Controllo versione online...");
  let live = APP_VERSION;
  try {
    live = (await fetchLiveAppVersion()) || APP_VERSION;
  } catch (_) {
    /* ignore */
  }
  if (!versionNewer(live, APP_VERSION)) {
    for (let i = 0; i < 18; i++) {
      setStatus(`Attendo pubblicazione online... (${i + 1}/18)`);
      await sleep(5000);
      try {
        live = (await fetchLiveAppVersion()) || live;
        if (versionNewer(live, APP_VERSION)) break;
      } catch (_) {
        /* rete */
      }
    }
  }
  liveVersionCache = live || liveVersionCache || APP_VERSION;
  setStatus(`Carico v${liveVersionCache}...`);

  // Sempre index.html pulito (non restare su URL/cache strani della PWA)
  const base = new URL("./index.html", location.href);
  base.searchParams.set("_ts", String(Date.now()));
  base.searchParams.set("_ver", String(liveVersionCache));
  location.replace(base.pathname + base.search);
}

async function checkForAppUpdate({ silent = true } = {}) {
  if (!navigator.onLine) return null;
  try {
    const live = await fetchLiveAppVersion();
    if (versionNewer(live, APP_VERSION)) {
      showUpdateBanner(live);
      if (!silent) toast(`Disponibile v${live}`);
      // Prova anche a far scaricare il nuovo SW in background
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch (_) {
        /* ignore */
      }
      return live;
    }
    hideUpdateBanner();
    return null;
  } catch (err) {
    if (!silent) console.warn("check update", err);
    return null;
  }
}

function fillMapSelect() {
  els.mapSelect.innerHTML = "";
  for (const m of maps) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    els.mapSelect.appendChild(opt);
  }
  if (currentMap) els.mapSelect.value = currentMap.id;
}

function syncPlantChrome(map) {
  fillMapSelect();
  setPlantNavActive(els.plantNav, map?.id || null);
  if (els.mapTitle) {
    els.mapTitle.innerHTML = map
      ? `<strong>${escapeHtml(map.name)}</strong>`
      : "";
  }
}

async function selectMap(id, { keepHighlight = false, keepView = false } = {}) {
  const map = await getMap(id);
  if (!map) {
    toast("Mappa non disponibile");
    return;
  }
  const same = currentMap && currentMap.id === map.id;
  currentMap = map;
  // UI subito (titolo/menu), poi immagine
  syncPlantChrome(map);
  setStatus(`Mappa: <strong>${escapeHtml(map.name)}</strong> · ${(map.tags || []).length} tag`);
  if (!keepHighlight) {
    activeTagId = null;
    viewer.highlight(null);
  }
  try {
    // Cambio schermata: sempre riallinea in alto (niente "salto" tra foto)
    const stay = keepView && same;
    await viewer.loadMap(map, { keepView: stay });
  } catch (err) {
    setStatus(`Errore immagine: ${escapeHtml(err.message || err)}`);
    return;
  }
  if (keepHighlight && activeTagId) {
    viewer.map = currentMap;
    viewer.highlight(activeTagId);
  }
  // Precarica le mappe vicine nel menu
  preloadNearby(id);
}

function preloadNearby(mapId) {
  const ids = maps.map((m) => m.id);
  const i = ids.indexOf(mapId);
  const neighbors = [ids[i - 1], ids[i + 1], ids[i + 2]].filter(Boolean);
  for (const nid of neighbors) {
    const m = maps.find((x) => x.id === nid);
    if (m?.image) viewer.preload(m.image);
  }
}

function setMapsLocalBadge(n) {
  if (!els.cloudBadge) return;
  const cloud = isCloudReady() ? `<span class="ok">Cloud</span> · ` : "";
  els.cloudBadge.innerHTML =
    `${cloud}<span class="ok" title="PNG salvate su questo dispositivo">Locale ${n}</span>`;
  els.cloudBadge.title = `Mappe PNG salvate sul dispositivo: ${n}`;
}

async function syncImagesLocal({ force = false } = {}) {
  // Solo su richiesta esplicita: niente download di massa automatico
  const total = maps.filter((m) => m?.image).length;
  if (!force) {
    try {
      setMapsLocalBadge(await countLocalImages());
    } catch (_) {
      /* ignore */
    }
    return { done: 0, total };
  }
  setStatus(`Aggiorno le mappe sul dispositivo... 0/${total}`);
  await warmAllMapImages(
    maps,
    (done, tot, name) => {
      setStatus(
        `Aggiorno le mappe... <strong>${done}/${tot}</strong>` +
          (name ? ` · ${escapeHtml(name)}` : "")
      );
    },
    { force: true }
  );
  // Pulisci anche cache SW delle mappe vecchie
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.includes("maps")).map((k) => caches.delete(k))
      );
    }
  } catch (_) {
    /* ignore */
  }
  const n = await countLocalImages().catch(() => total);
  setMapsLocalBadge(n);
  if (currentMap) {
    setStatus(
      `Mappa: <strong>${escapeHtml(currentMap.name)}</strong> · ${(currentMap.tags || []).length} tag`
    );
  } else {
    setStatus("Mappe pronte in locale");
  }
}

async function refreshMaps() {
  maps = await listMaps();
  syncPlantChrome(currentMap);
  if (!currentMap) {
    const prefer =
      maps.find((m) => m.id === "ultrafiltrazione-mbr-ad") ||
      maps.find((m) => m.id === "biologico-mbbr-123") ||
      maps[0];
    if (prefer) await selectMap(prefer.id);
  } else {
    const fresh = maps.find((m) => m.id === currentMap.id);
    if (fresh) {
      currentMap = fresh;
      syncPlantChrome(currentMap);
    }
  }
}

async function persistCurrent() {
  if (!currentMap) return { cloudSynced: false, cloudError: null };
  const result = await saveMap(currentMap);
  currentMap = result.map;
  maps = await listMaps();
  return result;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Lista suggerimenti: tap = vai subito al tag; scroll = solo chiudi tastiera. */
let sugHits = [];
let sugPointer = null;
let sugTouchHandled = false;

function closeSuggestions() {
  els.suggestions.classList.remove("open");
  els.suggestions.innerHTML = "";
  sugIndex = -1;
  sugHits = [];
  sugPointer = null;
  sugTouchHandled = false;
}

function dismissSearchKeyboard() {
  try {
    els.searchInput.blur();
  } catch (_) {
    /* ignore */
  }
}

function currentSearchKind() {
  const v = String(els.searchKind?.value || "tutti").trim().toLowerCase();
  return v || "tutti";
}

/** Nome pagina menu (es. Osmosi 1° passo A), non l’id tecnico della mappa. */
function pageLabelForMap(mapId, fallbackName = "") {
  const page = pageForMapId(mapId);
  return String(page?.label || fallbackName || mapId || "").trim();
}

/** Tipo apparecchiatura (pompa, valvola, …) per i suggerimenti. */
function kindLabelForTag(tag) {
  return String(tag?.kind || "").trim().toLowerCase();
}

/** Testo barra ricerca: sigla [tipo] - nota [pagina] */
function formatTagSearchText(tag, mapId, mapName) {
  const sigla = String(tag?.label || tag?.id || "").trim();
  if (!sigla) return "";
  const kind = kindLabelForTag(tag);
  const kindPart = kind ? ` [${kind}]` : "";
  const note = String(tag?.note || "").trim();
  const page = pageLabelForMap(mapId, mapName);
  const pagePart = page ? ` [${page}]` : "";
  return note ? `${sigla}${kindPart} - ${note}${pagePart}` : `${sigla}${kindPart}${pagePart}`;
}

async function runSearch(query, { autoPick = false } = {}) {
  const kind = currentSearchKind();
  const hits = await searchAllTags(query, { kind });
  if (!hits.length) {
    closeSuggestions();
    if (query.trim() || kind !== "tutti") {
      const kindHint = kind !== "tutti" ? ` (tipo ${escapeHtml(kind)})` : "";
      setStatus(
        query.trim()
          ? `Nessuna sigla vicina a "${escapeHtml(query)}"${kindHint} - prova un altro tipo o senza trattini`
          : `Nessun tag di tipo "${escapeHtml(kind)}"`
      );
    }
    return hits;
  }

  const exactN = hits.filter((h) => h.match?.tier === "exact").length;
  const nearN = hits.length - exactN;

  els.suggestions.innerHTML = hits
    .slice(0, 40)
    .map((h, i) => {
      const tier = h.match?.tier || "exact";
      const reason = h.match?.reason || "";
      const badge = tier === "near" ? "Vicino" : "Match";
      const noteText = String(h.tag.note || "").trim();
      const kind = kindLabelForTag(h.tag);
      const kindBrackets = kind ? `[${kind}]` : "";
      const pageLabel = pageLabelForMap(h.mapId, h.mapName);
      const pageBrackets = pageLabel ? `[${pageLabel}]` : "";
      // Descrizione: nota (se c’è) + [pagina]; il [tipo] sta subito dopo la sigla nel titolo
      const detailLine = noteText
        ? `${escapeHtml(noteText)}${pageBrackets ? ` <span class="sug-page">${escapeHtml(pageBrackets)}</span>` : ""}`
        : pageBrackets
          ? `<span class="sug-page">${escapeHtml(pageBrackets)}</span>`
          : "";
      const noteHtml = detailLine ? `<div class="sug-note">${detailLine}</div>` : "";
      return `
      <div class="sug-item sug-${tier}${i === 0 ? " active" : ""}" data-i="${i}" data-map="${escapeHtml(h.mapId)}" data-tag="${escapeHtml(h.tag.id)}">
        <div>
          <div class="sug-title">
            <span>${escapeHtml(h.tag.label || h.tag.id)}${kindBrackets ? ` <span class="sug-kind">${escapeHtml(kindBrackets)}</span>` : ""}</span>
            <span class="sug-badge ${tier}">${badge}</span>
          </div>
          ${noteHtml}
          <div class="sug-reason">${escapeHtml(reason)}</div>
        </div>
      </div>`;
    })
    .join("");
  els.suggestions.classList.add("open");
  sugIndex = 0;
  sugHits = hits.slice(0, 40);
  sugTouchHandled = false;

  if (exactN && nearN) {
    setStatus(
      `<strong>${exactN}</strong> corrispondenze · <strong>${nearN}</strong> proposte vicine - scegli dalla lista`
    );
  } else if (!exactN && nearN) {
    setStatus(
      `Nessun match esatto - <strong>${nearN}</strong> sigle vicine, scegli quella giusta`
    );
  } else {
    setStatus(`<strong>${exactN}</strong> risultati - seleziona o Invio`);
  }

  // Auto-pick solo se un unico match esatto (non sulle sole proposte "vicine")
  if (autoPick && exactN === 1 && hits[0].match?.tier === "exact") {
    await pickHit(hits[0]);
  }
  return hits;
}

async function pickHit(hit) {
  closeSuggestions();
  const sigla = String(hit.tag.label || hit.tag.id || "").trim();
  const note = String(hit.tag.note || "").trim();
  const kind = kindLabelForTag(hit.tag);
  const page = pageLabelForMap(hit.mapId, hit.mapName);
  els.searchInput.value = formatTagSearchText(hit.tag, hit.mapId, hit.mapName);
  els.clearBtn.classList.add("visible");
  activeTagId = hit.tag.id;
  if (!currentMap || currentMap.id !== hit.mapId) {
    // nuova mappa: un solo fit iniziale; sulla stessa mappa non si tocca lo zoom
    await selectMap(hit.mapId, { keepHighlight: true });
  } else {
    currentMap = await getMap(hit.mapId);
    viewer.map = currentMap;
  }
  viewer.map = currentMap;
  viewer.highlight(hit.tag.id);
  const bits = [`Evidenziato <strong>${escapeHtml(sigla)}</strong>`];
  if (kind) bits.push(escapeHtml(`[${kind}]`));
  if (page) bits.push(`in ${escapeHtml(page)}`);
  if (note) bits.push(`nota: ${escapeHtml(note)}`);
  if (hit.match?.reason) bits.push(escapeHtml(hit.match.reason));
  setStatus(bits.join(" · "));
}

function openNoteDrawer(tag) {
  els.drawer.classList.add("open");
  els.noteTitle.value = tag.label || tag.id || "";
  els.noteBody.value = tag.note || "";
  els.noteKind.value = tag.kind || "altro";
  els.drawer.dataset.tagId = tag.id || "";
  els.drawer.dataset.isNew = tag.isNew ? "1" : "0";
  els.drawer.dataset.recalibrate = tag.recalibrate ? "1" : "0";
  els.drawer.dataset.x = String(tag.x);
  els.drawer.dataset.y = String(tag.y);
  els.drawer.dataset.w = String(tag.w);
  els.drawer.dataset.h = String(tag.h);
  els.noteDelete.style.display = tag.isNew ? "none" : "inline-block";
}

function closeDrawer() {
  els.drawer.classList.remove("open");
  if (viewer?._addRectNorm) {
    viewer._addRectNorm = null;
    viewer.renderOverlay();
  }
}

els.noteClose.addEventListener("click", closeDrawer);

els.noteSave.addEventListener("click", async () => {
  if (!currentMap) return;
  const label = els.noteTitle.value.trim();
  if (!label) {
    toast("Inserisci la sigla / tag");
    return;
  }
  const id =
    els.drawer.dataset.tagId ||
    label.replace(/\s+/g, "-").toUpperCase();
  const isNew = els.drawer.dataset.isNew === "1";
  let tag = (currentMap.tags || []).find((t) => t.id === id);
  if (!tag) {
    tag = {
      id,
      x: Number(els.drawer.dataset.x) || 0.4,
      y: Number(els.drawer.dataset.y) || 0.4,
      w: Number(els.drawer.dataset.w) || 0.04,
      h: Number(els.drawer.dataset.h) || 0.06,
    };
    currentMap.tags = currentMap.tags || [];
    if (isNew || !(currentMap.tags || []).some((t) => t.id === id)) {
      currentMap.tags.push(tag);
    }
  }
  tag.id = id;
  tag.label = label;
  tag.kind = els.noteKind.value;
  tag.note = els.noteBody.value.trim();
  tag.source = "manual";
  tag.locked = true;
  tag.updatedAt = Date.now();
  const applyGeom =
    isNew || els.drawer.dataset.recalibrate === "1";
  // Aggiungi / Ricalibra: geometria dal riquadro disegnato
  if (applyGeom) {
    tag.x = Number(els.drawer.dataset.x) || tag.x;
    tag.y = Number(els.drawer.dataset.y) || tag.y;
    tag.w = Number(els.drawer.dataset.w) || tag.w;
    tag.h = Number(els.drawer.dataset.h) || tag.h;
  }
  const { cloudSynced } = await persistCurrent();
  activeTagId = id;
  viewer.map = currentMap;
  viewer.highlight(id);
  closeDrawer();
  turnOffAddModes();
  if (cloudSynced) {
    toast(isNew ? "Tag + nota online" : "Nota salvata online");
  } else if (isCloudReady()) {
    toast("Salvata in locale - cloud fallito, premi Sync");
  } else {
    toast(isNew ? "Tag salvato solo qui" : "Nota salvata solo qui");
  }
  setStatus(
    `Mappa: <strong>${escapeHtml(currentMap.name)}</strong> · ${currentMap.tags.length} tag`
  );
});

els.noteDelete.addEventListener("click", async () => {
  if (!currentMap) return;
  const id = els.drawer.dataset.tagId;
  currentMap.tags = (currentMap.tags || []).filter((t) => t.id !== id);
  const { cloudSynced } = await persistCurrent();
  if (activeTagId === id) activeTagId = null;
  viewer.map = currentMap;
  viewer.highlight(null);
  viewer.renderOverlay();
  closeDrawer();
  toast(cloudSynced ? "Tag eliminato (anche online)" : "Tag eliminato in locale");
});

els.mapSelect.addEventListener("change", () => selectMap(els.mapSelect.value));

els.searchInput.addEventListener("input", async () => {
  const q = els.searchInput.value;
  els.clearBtn.classList.toggle("visible", !!q);
  if (!q.trim() && currentSearchKind() === "tutti") {
    closeSuggestions();
    viewer.highlight(null);
    return;
  }
  await runSearch(q);
});

/** Snapshot tipo al tocco: se riscelgo lo stesso con lista aperta → chiudi popup. */
let searchKindSnapshot = "tutti";
els.searchKind?.addEventListener("pointerdown", () => {
  searchKindSnapshot = currentSearchKind();
});
els.searchKind?.addEventListener("change", async () => {
  const q = String(els.searchInput.value || "");
  const kind = currentSearchKind();
  const sugOpen = els.suggestions.classList.contains("open");
  // Stesso tipo di nuovo (lista già aperta) → solo chiudi, niente messaggio sotto
  if (kind === searchKindSnapshot && sugOpen) {
    closeSuggestions();
    return;
  }
  if (!q.trim() && kind === "tutti") {
    closeSuggestions();
    viewer.highlight(null);
    return;
  }
  await runSearch(q);
});
// Stesso valore: molti browser non emettono "change" → chiudi al blur
els.searchKind?.addEventListener("blur", () => {
  if (
    !String(els.searchInput.value || "").trim() &&
    currentSearchKind() === searchKindSnapshot &&
    els.suggestions.classList.contains("open")
  ) {
    closeSuggestions();
  }
});

// Suggerimenti: tap -> vai subito al tag; scroll -> chiudi solo la tastiera
els.suggestions.addEventListener("pointerdown", (e) => {
  const item = e.target.closest?.(".sug-item");
  sugTouchHandled = false;
  sugPointer = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    index: item ? Number(item.dataset.i) : -1,
  };
});

els.suggestions.addEventListener(
  "pointermove",
  (e) => {
    if (!sugPointer || e.pointerId !== sugPointer.id) return;
    if (Math.hypot(e.clientX - sugPointer.x, e.clientY - sugPointer.y) > 10) {
      if (!sugPointer.moved) {
        sugPointer.moved = true;
        dismissSearchKeyboard(); // scroll -> tastiera via, resto a guardare la lista
      }
    }
  },
  { passive: true }
);

els.suggestions.addEventListener(
  "scroll",
  () => {
    dismissSearchKeyboard();
    if (sugPointer) sugPointer.moved = true;
  },
  { passive: true }
);

function endSugPointer(e) {
  if (!sugPointer || e.pointerId !== sugPointer.id) return;
  const { moved, index } = sugPointer;
  sugPointer = null;
  if (moved) {
    // Stava scorrendo: niente selezione
    return;
  }
  const hit = index >= 0 ? sugHits[index] : null;
  if (!hit) return;
  dismissSearchKeyboard();
  sugTouchHandled = true;
  sugIndex = index;
  els.suggestions.querySelectorAll(".sug-item").forEach((el, i) => {
    el.classList.toggle("active", i === index);
  });
  pickHit(hit); // tap -> entra subito (niente secondo colpo)
}

els.suggestions.addEventListener("pointerup", endSugPointer);
els.suggestions.addEventListener("pointercancel", () => {
  sugPointer = null;
});

// Desktop / click residuo: conferma subito; su touch evita doppio dopo pointerup
els.suggestions.addEventListener("click", (e) => {
  if (sugTouchHandled) {
    e.preventDefault();
    sugTouchHandled = false;
    return;
  }
  if (window.matchMedia("(pointer: coarse)").matches) {
    e.preventDefault();
    return;
  }
  const item = e.target.closest?.(".sug-item");
  if (!item) return;
  const hit = sugHits[Number(item.dataset.i)];
  if (hit) {
    dismissSearchKeyboard();
    pickHit(hit);
  }
});

els.searchInput.addEventListener("keydown", async (e) => {
  const items = [...els.suggestions.querySelectorAll(".sug-item")];
  if (e.key === "ArrowDown" && items.length) {
    e.preventDefault();
    sugIndex = Math.min(items.length - 1, sugIndex + 1);
    items.forEach((el, i) => el.classList.toggle("active", i === sugIndex));
    items[sugIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp" && items.length) {
    e.preventDefault();
    sugIndex = Math.max(0, sugIndex - 1);
    items.forEach((el, i) => el.classList.toggle("active", i === sugIndex));
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hits = await searchAllTags(els.searchInput.value, { kind: currentSearchKind() });
    if (!hits.length) {
      toast("Nessun risultato");
      return;
    }
    const pick = sugIndex >= 0 && hits[sugIndex] ? hits[sugIndex] : hits[0];
    await pickHit(pick);
  } else if (e.key === "Escape") {
    closeSuggestions();
  }
});

els.clearBtn.addEventListener("click", () => {
  els.searchInput.value = "";
  els.clearBtn.classList.remove("visible");
  if (currentSearchKind() !== "tutti") {
    runSearch("");
  } else {
    closeSuggestions();
    viewer.highlight(null);
  }
  els.searchInput.focus();
});

els.btnRefresh?.addEventListener("click", async () => {
  els.btnRefresh.disabled = true;
  try {
    // Non cancella le PNG locali: l'app installata resta, si aggiorna solo il codice
    await applyAppUpdate({ wipeImages: false });
  } finally {
    els.btnRefresh.disabled = false;
  }
});
els.btnUpdateNow?.addEventListener("click", () => applyAppUpdate({ wipeImages: false }));

els.btnAnnotate.addEventListener("click", () => {
  if (!annotateMode && !activeTagId) {
    toast("Prima cerca ed evidenzia una sigla");
    return;
  }
  turnOffAddModes();
  annotateMode = !annotateMode;
  viewer.setAnnotate(annotateMode);
  els.btnAnnotate.classList.toggle("active", annotateMode);
  if (annotateMode) {
    viewer.highlight(activeTagId);
    toast("Trascina solo il riquadro evidenziato");
  } else {
    toast("Riposiziona off");
  }
});

els.btnRecalibrate?.addEventListener("click", () => {
  if (!currentMap) {
    toast("Apri una mappa prima");
    return;
  }
  if (!recalibrateMode && !activeTagId) {
    toast("Prima cerca ed evidenzia la sigla da ricalibrare");
    return;
  }
  if (recalibrateMode) {
    turnOffAddModes();
    setStatus(
      `Mappa: <strong>${escapeHtml(currentMap.name)}</strong> · ${(currentMap.tags || []).length} tag`
    );
    toast("Ricalibra disattivato");
    return;
  }
  if (annotateMode) {
    annotateMode = false;
    viewer.setAnnotate(false);
    els.btnAnnotate.classList.remove("active");
  }
  addTagMode = false;
  els.btnAddTag?.classList.remove("active");
  recalibrateMode = true;
  viewer.setAddMode(true);
  els.btnRecalibrate.classList.add("active");
  viewer.highlight(activeTagId);
  setStatus("Ricalibra: ridisegna il riquadro giallo sulla sigla (zoom a 2 dita)");
  toast("Ridisegna il quadrato del tag selezionato");
});

els.btnAddTag?.addEventListener("click", () => {
  if (!currentMap) {
    toast("Apri una mappa prima");
    return;
  }
  if (addTagMode) {
    turnOffAddModes();
    setStatus(
      `Mappa: <strong>${escapeHtml(currentMap.name)}</strong> · ${(currentMap.tags || []).length} tag`
    );
    toast("Aggiungi disattivato");
    return;
  }
  if (annotateMode) {
    annotateMode = false;
    viewer.setAnnotate(false);
    els.btnAnnotate.classList.remove("active");
  }
  recalibrateMode = false;
  els.btnRecalibrate?.classList.remove("active");
  addTagMode = true;
  viewer.setAddMode(true);
  els.btnAddTag.classList.add("active");
  setStatus("Aggiungi tag: zoom a 2 dita · un dito disegna il riquadro sulla sigla");
  toast("Disegna il riquadro sul tag mancante");
});

viewer.onAddRect = async (rect) => {
  if (!currentMap || addTagBusy) return;
  if (!addTagMode && !recalibrateMode) return;

  // Ricalibra: nuovo riquadro sul tag già selezionato → apri Note subito
  if (recalibrateMode) {
    const tag = (currentMap.tags || []).find((t) => t.id === activeTagId);
    if (!tag) {
      toast("Nessun tag selezionato da ricalibrare");
      turnOffAddModes();
      return;
    }
    tag.x = rect.x;
    tag.y = rect.y;
    tag.w = rect.w;
    tag.h = rect.h;
    tag.source = "manual";
    tag.locked = true;
    tag.updatedAt = Date.now();
    viewer.map = currentMap;
    viewer.highlight(tag.id);
    turnOffAddModes();
    openNoteDrawer({
      ...tag,
      isNew: false,
      recalibrate: true,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    });
    setStatus("Riquadro aggiornato - controlla e <strong>Salva</strong> per confermare");
    toast("Nuovo riquadro pronto - Salva nelle note");
    return;
  }

  const img = $("#mapImage");
  if (!img?.naturalWidth) {
    toast("Immagine non pronta");
    return;
  }
  addTagBusy = true;
  setStatus("OCR sulla selezione...");
  toast("Leggo la sigla...");
  let best = "";
  let kind = "altro";
  try {
    const result = await ocrImageRegion(img, rect, {
      onProgress: (p) => {
        if (p > 0.05) setStatus(`OCR selezione... <strong>${Math.round(p * 100)}%</strong>`);
      },
    });
    best = result.best || "";
    kind = result.kind || "altro";
    if (!best && result.text) {
      const m = String(result.text)
        .toUpperCase()
        .replace(/\s+/g, "")
        .match(/[A-Z0-9][A-Z0-9_-]{3,20}/);
      if (m) best = m[0];
    }
  } catch (err) {
    console.warn("OCR selezione", err);
    toast("OCR selezione fallita - inserisci la sigla a mano");
  } finally {
    addTagBusy = false;
  }

  openNoteDrawer({
    id: best || "",
    label: best || "",
    kind,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    isNew: true,
    note: "",
  });
  if (best) {
    setStatus(
      `Nuovo tag proposto: <strong>${escapeHtml(best)}</strong> - controlla e Salva`
    );
  } else {
    setStatus("Selezione ok - digita la sigla nel pannello e Salva");
  }
};

els.btnOcr.addEventListener("click", async () => {
  const img = $("#mapImage");
  if (!currentMap || !img?.naturalWidth) {
    toast("Carica una mappa prima");
    return;
  }
  els.btnOcr.disabled = true;
  els.btnOcr.classList.add("active");
  setStatus("OCR in corso... primo avvio può scaricare il motore (~minuto)");
  try {
    const found = await runMapOcr(img, {
      onProgress: (p) => {
        setStatus(`OCR... <strong>${Math.round(p * 100)}%</strong>`);
      },
    });
    const { tags, added, updated, skipped } = mergeOcrIntoMap(currentMap, found);
    currentMap.tags = tags;
    await persistCurrent();
    viewer.map = currentMap;
    viewer.renderOverlay();
    setStatus(
      `OCR: <strong>${found.length}</strong> letti · +${added} nuovi · ${updated} aggiornati · ${skipped} bloccati (manuali). Cerca una sigla per evidenziarla.`
    );
    toast("OCR finito - cerca una sigla per vederla");
  } catch (err) {
    console.warn(err);
    setStatus(`OCR fallita: ${escapeHtml(err.message || err)}`);
    toast("OCR fallita");
  } finally {
    els.btnOcr.disabled = false;
    els.btnOcr.classList.remove("active");
  }
});

els.btnNotes.addEventListener("click", () => {
  if (!activeTagId || !currentMap) {
    toast("Cerca o seleziona un tag prima");
    return;
  }
  const tag = currentMap.tags.find((t) => t.id === activeTagId);
  if (tag) openNoteDrawer({ ...tag, isNew: false });
});

els.btnSync.addEventListener("click", async () => {
  if (!isFirebaseConfigured()) {
    toast("Cloud non attivo: serve Firebase (vedi firebase-config)");
    return;
  }
  els.btnSync.disabled = true;
  setStatus("Connessione cloud...");
  try {
    const cloud = await initCloud();
    if (!cloud.ok || !isCloudReady()) {
      const why = cloud?.reason || "non raggiungibile";
      toast(`Cloud: ${why}`);
      setStatus(`Cloud errore: ${escapeHtml(why)}`);
      els.cloudBadge.innerHTML = `<span class="warn">Cloud errore</span>`;
      return;
    }
    // Solo note/posizioni su Firebase - niente download PNG
    setStatus("Sync note/posizioni su Firebase...");
    const n = await syncAllWithCloud();
    await refreshMaps();
    if (currentMap) {
      await selectMap(currentMap.id, { keepHighlight: true, keepView: true });
    }
    const imgs = await countLocalImages().catch(() => 0);
    setMapsLocalBadge(imgs);
    toast(`Sync cloud ok (${n} mappe)`);
    els.cloudBadge.innerHTML = `<span class="ok">Cloud sync</span>`;
    setStatus(
      currentMap
        ? `Sync ok · <strong>${escapeHtml(currentMap.name)}</strong> · ${(currentMap.tags || []).length} tag`
        : `Sync cloud ok (${n} mappe)`
    );
  } catch (err) {
    const msg = String(err?.message || err || "errore");
    console.warn("Sync fallita", err);
    toast(`Sync fallita: ${msg.slice(0, 140)}`);
    setStatus(`Sync fallita: <span class="warn">${escapeHtml(msg)}</span>`);
    els.cloudBadge.innerHTML = `<span class="warn">Sync errore</span>`;
  } finally {
    els.btnSync.disabled = false;
  }
});

document.addEventListener("click", (e) => {
  if (!els.suggestions.contains(e.target) && e.target !== els.searchInput) {
    closeSuggestions();
  }
});

// resize: non forzare fit - l'inquadratura resta quella dell'utente

async function boot() {
  if (els.appVersion) {
    els.appVersion.textContent = `v${APP_VERSION}`;
    els.appVersion.title = `Versione ${APP_VERSION} (${APP_BUILD})`;
  }
  setStatus("Avvio Tag Impianto...");
  renderPlantNav(els.plantNav, {
    onSelect: (page) => {
      // Non aprire la tastiera quando si cambia pagina dal menu
      try {
        els.searchInput.blur();
      } catch (_) {
        /* ignore */
      }
      closeSuggestions();
      if (page?.mapId) selectMap(page.mapId);
    },
  });

  const params = new URLSearchParams(location.search);
  const wantReset = params.has("reset") || params.get("ripristina") === "1";
  let forceSeed = false;
  let forceImages = false;
  try {
    forceSeed = localStorage.getItem("ti-force-seed") === "1";
    if (forceSeed) localStorage.removeItem("ti-force-seed");
    forceImages = localStorage.getItem("ti-force-images") === "1";
    if (forceImages) localStorage.removeItem("ti-force-images");
  } catch (_) {
    /* ignore */
  }

  if (wantReset) {
    setStatus("Ripristino mappe e tag dal sito...");
    await resetMapsFromSeed();
  } else if (forceSeed) {
    // Solo dopo pulsante Aggiorna: merge seed + poi le PNG si scaricano al bisogno
    setStatus("Aggiorno catalogo mappe dal sito...");
    await forceReloadSeeds();
  } else {
    // Offline-first: se le mappe ci sono già in locale, zero rete
    await loadSeedIfEmpty();
  }

  await refreshMaps();

  // Se dopo il load non c'è nulla, forza ripristino seed (cache/IndexedDB corrotti)
  if (!maps.length) {
    setStatus("Nessuna mappa in locale - ripristino...");
    await resetMapsFromSeed();
    await refreshMaps();
  }

  // Cloud: NESSUN pull/push all'avvio. Solo badge; Sync è manuale.
  if (isFirebaseConfigured()) {
    els.cloudBadge.innerHTML =
      `<span class="muted" title="Premi Sync per allineare note/posizioni">Cloud: Sync manuale</span>`;
  } else {
    els.cloudBadge.innerHTML =
      `<span class="muted" title="Riposizionamenti solo su questo dispositivo">Solo dispositivo</span>`;
  }

  // Service worker: aggiorna in background; se c'è waiting, banner senza reload forzato
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
      const offerSwUpdate = () => {
        if (reg.waiting && navigator.serviceWorker.controller) {
          showUpdateBanner(liveVersionCache || APP_VERSION);
        }
      };
      offerSwUpdate();
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed") offerSwUpdate();
        });
      });
      // Controlla subito un nuovo SW (Pages)
      reg.update().catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }

  // Offline-first: le PNG si scaricano solo quando apri una mappa (mai download di massa).
  if (currentMap) preloadNearby(currentMap.id);
  try {
    const n = await countLocalImages();
    setMapsLocalBadge(n);
    if (currentMap) {
      setStatus(
        `Mappa: <strong>${escapeHtml(currentMap.name)}</strong> · ${(currentMap.tags || []).length} tag`
      );
    } else {
      setStatus(forceSeed ? "Catalogo aggiornato" : "Pronto (offline)");
    }
  } catch (_) {
    setMapsLocalBadge(0);
  }
  // forceImages lasciato solo per debug legacy - non avviare warm di tutte le mappe
  void forceImages;

  // Controlla subito (e poi in background) se online c'è una versione più nuova
  checkForAppUpdate({ silent: true }).catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      checkForAppUpdate({ silent: true }).catch(() => {});
    }
  });
  window.addEventListener("online", () => {
    checkForAppUpdate({ silent: true }).catch(() => {});
  });
  setInterval(() => {
    checkForAppUpdate({ silent: true }).catch(() => {});
  }, 5 * 60 * 1000);

  // Mai autofocus ricerca su telefono/tablet (apre la tastiera a caso)
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  if (!coarse) {
    try {
      els.searchInput.focus({ preventScroll: true });
    } catch (_) {
      /* ignore */
    }
  }
}

// Tocco sul menu / mappa: chiudi tastiera. Solo tap sulla barra ricerca la apre.
els.plantNav?.addEventListener(
  "pointerdown",
  () => {
    try {
      els.searchInput.blur();
    } catch (_) {
      /* ignore */
    }
  },
  { passive: true }
);
els.viewport?.addEventListener(
  "pointerdown",
  () => {
    try {
      els.searchInput.blur();
    } catch (_) {
      /* ignore */
    }
  },
  { passive: true }
);

boot().catch((err) => {
  console.error(err);
  setStatus(`Errore avvio: ${escapeHtml(err.message || err)}`);
});
