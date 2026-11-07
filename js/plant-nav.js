/**
 * Menu laterale stile DCS: aree in alto + elenco pagine.
 * La colonna sinistra delle foto è ritagliata; qui è digitale.
 */

export const PLANT_AREAS = [
  {
    id: "wwt",
    label: "WWT",
    pages: [
      { id: "chimico-fisico", label: "Chimico fisico", mapId: "chimico-fisico" },
      { id: "biologico-mbbr-123", label: "Biologico MBBR 1 2 3", mapId: "biologico-mbbr-123" },
      { id: "ultrafiltrazione-mbr-ad", label: "Ultrafiltrazione MBR A-D", mapId: "ultrafiltrazione-mbr-ad" },
      { id: "ultrafiltrazione-mbr-eh", label: "Ultrafiltrazione MBR E-H", mapId: "ultrafiltrazione-mbr-eh" },
      { id: "filtrazione-carboni", label: "Filtrazione a carboni", mapId: "filtrazione-carboni" },
      { id: "ultrafiltrazione-a", label: "Ultrafiltrazione A", mapId: "ultrafiltrazione-a" },
      { id: "ultrafiltrazione-b", label: "Ultrafiltrazione B", mapId: "ultrafiltrazione-b" },
      { id: "ultrafiltrazione-c", label: "Ultrafiltrazione C", mapId: "ultrafiltrazione-c" },
      { id: "ultrafiltrazione", label: "Ultrafiltrazione D", mapId: "ultrafiltrazione" },
      { id: "osmosi-1a", label: "Osmosi 1° passo A", mapId: "osmosi-1a" },
      { id: "osmosi-1b", label: "Osmosi 1° passo B", mapId: "osmosi-1b" },
      { id: "osmosi-1c", label: "Osmosi 1° passo C", mapId: "osmosi-1c" },
      { id: "osmosi-2a", label: "Osmosi 2° passo A", mapId: "osmosi-2a" },
      { id: "osmosi-2b", label: "Osmosi 2° passo B", mapId: "osmosi-2b" },
      { id: "osmosi-2c", label: "Osmosi 2° passo C", mapId: "osmosi-2c" },
      { id: "misure-motori", label: "Misure motori", mapId: null },
      { id: "sediflottazione-a", label: "Sediflottazione A", mapId: "sediflottazione-a" },
      { id: "sediflottatore-b", label: "Sediflottazione B", mapId: "sediflottatore-b" },
      { id: "trattamento-fanghi", label: "Trattamento fanghi", mapId: "trattamento-fanghi" },
      { id: "allarmi-wwt", label: "Allarmi WWT", mapId: null },
    ],
  },
  {
    id: "sf3",
    label: "SF3",
    pages: [
      { id: "actiflo", label: "Actiflo", mapId: "actiflo" },
      { id: "reattivi-actiflo", label: "Reattivi", mapId: "reattivi-actiflo" },
      { id: "uscita-actiflo", label: "Uscita Actiflo", mapId: "uscita-actiflo" },
      { id: "impostazioni-actiflo", label: "Impostazioni", mapId: null },
    ],
  },
  {
    id: "holdup",
    label: "HOLD-UP",
    pages: [
      { id: "holdup-area-nord", label: "Area Nord A-10605", mapId: "holdup-area-nord" },
      { id: "holdup-pgs-ovest", label: "PGS Ovest", mapId: "holdup-pgs-ovest" },
      { id: "holdup-tk8092", label: "TK8092/3", mapId: null },
      { id: "holdup-area-sud", label: "Area Sud", mapId: null },
      { id: "holdup-reparto", label: "Hold-up di reparto", mapId: null },
      { id: "holdup-diagnostica", label: "Diagnostica", mapId: null },
    ],
  },
  {
    id: "interconnecting",
    label: "Interconn.",
    pages: [
      { id: "interconnecting", label: "Interconnecting", mapId: "interconnecting" },
      { id: "acque-acide-hf", label: "Acque acide HF", mapId: null },
      { id: "acque-acide-oxo", label: "Acque acide OXO", mapId: null },
      { id: "trattamento-eff", label: "Trattamento EFF", mapId: null },
      { id: "blow-down-sud", label: "Blow down Sud", mapId: null },
    ],
  },
  {
    id: "vasche-api",
    label: "Vasche API",
    pages: [
      { id: "servizi-lurgi", label: "Servizi Lurgi API", mapId: null },
      { id: "accumulo-vasche", label: "Accumulo vasche API", mapId: null },
      { id: "vasche-api-s851", label: "S-851", mapId: "vasche-api-s851" },
    ],
  },
  {
    id: "assetto",
    label: "Assetto",
    pages: [
      { id: "assetto-200", label: "Assetto a 200 m³/h", mapId: "assetto-200" },
    ],
  },
];

/** Compat: elenco piatto di tutte le pagine. */
export const PLANT_PAGES = PLANT_AREAS.flatMap((a) => a.pages);

export function pageForMapId(mapId) {
  return PLANT_PAGES.find((p) => p.mapId === mapId) || null;
}

export function areaForMapId(mapId) {
  for (const area of PLANT_AREAS) {
    if (area.pages.some((p) => p.mapId === mapId)) return area;
  }
  return PLANT_AREAS[0];
}

/**
 * @param {HTMLElement} root
 * @param {{ onSelect: (page) => void, activeMapId?: string|null }} handlers
 */
export function renderPlantNav(root, handlers) {
  const activeMapId = handlers.activeMapId || null;
  const activeArea =
    (activeMapId && areaForMapId(activeMapId)) || PLANT_AREAS[0];

  root.innerHTML = "";
  root.classList.add("plant-nav");

  const areasEl = document.createElement("div");
  areasEl.className = "plant-area-list";
  areasEl.setAttribute("role", "tablist");
  areasEl.setAttribute("aria-label", "Aree impianto");

  let currentAreaId = activeArea.id;

  const list = document.createElement("div");
  list.className = "plant-nav-list";
  list.setAttribute("role", "navigation");

  function paintPages(areaId) {
    currentAreaId = areaId;
    list.innerHTML = "";
    const area = PLANT_AREAS.find((a) => a.id === areaId) || PLANT_AREAS[0];
    areasEl.querySelectorAll(".plant-area-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.areaId === areaId);
    });

    for (const page of area.pages) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "plant-nav-item";
      btn.dataset.pageId = page.id;
      if (page.mapId) btn.dataset.mapId = page.mapId;
      btn.textContent = page.label;
      btn.title = page.mapId
        ? page.label
        : `${page.label} (mappa non ancora caricata)`;
      const isActive = !!(page.mapId && page.mapId === activeMapId);
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-current", isActive ? "page" : "false");
      if (!page.mapId) {
        btn.disabled = true;
        btn.classList.add("disabled");
      } else {
        btn.addEventListener("click", () => handlers.onSelect(page));
      }
      list.appendChild(btn);
    }
  }

  for (const area of PLANT_AREAS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "plant-area-btn";
    btn.dataset.areaId = area.id;
    btn.textContent = area.label;
    btn.addEventListener("click", () => paintPages(area.id));
    areasEl.appendChild(btn);
  }

  root.appendChild(areasEl);
  root.appendChild(list);
  paintPages(currentAreaId);

  root._setActiveMap = (mapId) => {
    const area = mapId ? areaForMapId(mapId) : PLANT_AREAS.find((a) => a.id === currentAreaId);
    handlers.activeMapId = mapId;
    paintPages(area?.id || currentAreaId);
    list.querySelectorAll(".plant-nav-item").forEach((el) => {
      const on = el.dataset.mapId && el.dataset.mapId === mapId;
      el.classList.toggle("active", !!on);
      el.setAttribute("aria-current", on ? "page" : "false");
    });
  };
}

export function setPlantNavActive(root, mapId) {
  if (!root) return;
  if (typeof root._setActiveMap === "function") {
    root._setActiveMap(mapId);
    return;
  }
  root.querySelectorAll(".plant-nav-item").forEach((el) => {
    const on = el.dataset.mapId && el.dataset.mapId === mapId;
    el.classList.toggle("active", !!on);
    el.setAttribute("aria-current", on ? "page" : "false");
  });
}
