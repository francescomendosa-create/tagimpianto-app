import { resolveLocalImageUrl } from "./image-cache.js?v=1.8.40";

const MAX_MEM_IMAGES = 10;

export class MapViewer {
  constructor({ viewport, world, imageEl, overlayEl }) {
    this.viewport = viewport;
    this.world = world;
    this.imageEl = imageEl;
    this.overlayEl = overlayEl;

    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.map = null;
    this.highlightId = null;
    this.annotate = false;
    /** Modalità "Aggiungi": un dito disegna il riquadro, due dita zoom */
    this.addMode = false;
    this._viewInitialized = false;
    /** URL logica remota (non blob:) */
    this._lastRemote = "";
    /** @type {Map<string, string>} remote -> display url */
    this._resolved = new Map();
    this._loadToken = 0;

    this._pointers = new Map();
    this._pinch = null;
    this._panning = false;
    this._dragTag = null;
    /** @type {{x0:number,y0:number,x1:number,y1:number}|null} coords immagine px */
    this._addDrag = null;
    /** Ultimo riquadro normalizzato disegnato */
    this._addRectNorm = null;

    this.onAnnotatePlace = null;
    this.onTagMoved = null;
    /** Tap/click su un tag esistente -> ricerca */
    this.onTagDoubleSelect = null;
    /** @type {null|((rect:{x:number,y:number,w:number,h:number})=>void)} */
    this.onAddRect = null;

    this._bind();
  }

  _bind() {
    const vp = this.viewport;
    vp.addEventListener("pointerdown", (e) => this._onPointerDown(e));
    vp.addEventListener("pointermove", (e) => this._onPointerMove(e));
    vp.addEventListener("pointerup", (e) => this._onPointerUp(e));
    vp.addEventListener("pointercancel", (e) => this._onPointerUp(e));
    vp.addEventListener("dblclick", (e) => {
      e.preventDefault();
      this._emitTagDoubleSelect(e.clientX, e.clientY);
    });
    vp.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = vp.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        this.zoomAt(cx, cy, factor);
      },
      { passive: false }
    );
  }

  _emitTagDoubleSelect(clientX, clientY) {
    if (!this.onTagDoubleSelect) return;
    const now = Date.now();
    if (this._lastEmitSelect && now - this._lastEmitSelect < 450) return;
    const tag = this.findTagAtClient(clientX, clientY);
    if (!tag) return;
    this._lastEmitSelect = now;
    this.onTagDoubleSelect(tag);
  }

  /** Tag sotto le coordinate schermo (hit-test su tutti i tag della mappa). */
  findTagAtClient(clientX, clientY) {
    if (!this.map || !this.imageEl?.width) return null;
    const rect = this.viewport.getBoundingClientRect();
    const vx = clientX - rect.left;
    const vy = clientY - rect.top;
    const iw = this.imageEl.width;
    const ih = this.imageEl.height;
    const nx = (vx - this.tx) / this.scale / iw;
    const ny = (vy - this.ty) / this.scale / ih;
    const tags = this.map.tags || [];
    let best = null;
    let bestArea = Infinity;
    for (const t of tags) {
      const x = Number(t.x) || 0;
      const y = Number(t.y) || 0;
      const w = Math.max(Number(t.w) || 0.02, 0.01);
      const h = Math.max(Number(t.h) || 0.02, 0.01);
      // margine touch ~8px in coordinate normalizzate
      const padX = 8 / this.scale / iw;
      const padY = 8 / this.scale / ih;
      if (
        nx >= x - padX &&
        nx <= x + w + padX &&
        ny >= y - padY &&
        ny <= y + h + padY
      ) {
        const area = w * h;
        if (area < bestArea) {
          best = t;
          bestArea = area;
        }
      }
    }
    return best;
  }

  setAnnotate(on) {
    this.annotate = !!on;
    if (this.annotate) this.setAddMode(false);
    this.viewport.classList.toggle("annotate", this.annotate);
    this.renderOverlay();
  }

  setAddMode(on) {
    this.addMode = !!on;
    if (this.addMode) {
      this.annotate = false;
      this.viewport.classList.remove("annotate");
    }
    this.viewport.classList.toggle("add-mode", this.addMode);
    this._addDrag = null;
    if (!this.addMode) this._addRectNorm = null;
    this.renderOverlay();
  }

  /** Client -> pixel immagine */
  _clientToImagePx(clientX, clientY) {
    const vp = this._viewportPoint(clientX, clientY);
    const iw = this.imageEl.naturalWidth || this.imageEl.width || 1;
    const ih = this.imageEl.naturalHeight || this.imageEl.height || 1;
    const x = (vp.x - this.tx) / this.scale;
    const y = (vp.y - this.ty) / this.scale;
    return {
      x: Math.min(iw, Math.max(0, x)),
      y: Math.min(ih, Math.max(0, y)),
      iw,
      ih,
    };
  }

  _normFromDrag(drag) {
    const iw = this.imageEl.naturalWidth || this.imageEl.width || 1;
    const ih = this.imageEl.naturalHeight || this.imageEl.height || 1;
    const left = Math.min(drag.x0, drag.x1);
    const top = Math.min(drag.y0, drag.y1);
    const right = Math.max(drag.x0, drag.x1);
    const bottom = Math.max(drag.y0, drag.y1);
    return {
      x: left / iw,
      y: top / ih,
      w: Math.max(0.008, (right - left) / iw),
      h: Math.max(0.01, (bottom - top) / ih),
    };
  }

  _paintSelectionBox(norm, pending = false) {
    if (!norm) return;
    const iw = this.imageEl.naturalWidth || this.imageEl.width || 1;
    const ih = this.imageEl.naturalHeight || this.imageEl.height || 1;
    const el = document.createElement("div");
    el.className = pending ? "sel-box pending" : "sel-box";
    el.style.left = `${norm.x * iw}px`;
    el.style.top = `${norm.y * ih}px`;
    el.style.width = `${norm.w * iw}px`;
    el.style.height = `${norm.h * ih}px`;
    this.overlayEl.appendChild(el);
  }

  /** Precache in IndexedDB + memoria (non blocca UI). */
  preload(src) {
    if (!src) return;
    resolveLocalImageUrl(src)
      .then((url) => {
        this._resolved.set(src, url);
        const img = new Image();
        img.decoding = "async";
        img.src = url;
      })
      .catch(() => {});
  }

  async _displayUrl(remote) {
    if (this._resolved.has(remote)) return this._resolved.get(remote);
    let url;
    try {
      url = await resolveLocalImageUrl(remote);
    } catch (err) {
      // retry path pulito
      const bare = String(remote || "").split("?")[0];
      url = await resolveLocalImageUrl(`${bare}?retry=${Date.now()}`);
    }
    this._resolved.set(remote, url);
    // Limita mappa risoluzioni tenute in memoria (i blob restano in IDB)
    while (this._resolved.size > MAX_MEM_IMAGES) {
      const first = this._resolved.keys().next().value;
      this._resolved.delete(first);
    }
    return url;
  }

  async _setImageSrc(display) {
    await new Promise((resolve, reject) => {
      const done = () => resolve();
      this.imageEl.onload = done;
      this.imageEl.onerror = () => reject(new Error("Immagine mappa non caricata"));
      if (this.imageEl.src === display && this.imageEl.complete && this.imageEl.naturalWidth) {
        done();
        return;
      }
      this.imageEl.src = display;
    });
    try {
      if (this.imageEl.decode) await this.imageEl.decode();
    } catch (_) {
      /* ignore */
    }
  }

  async loadMap(map, { keepView = false } = {}) {
    this.map = map;
    const remote = map.image;
    const token = ++this._loadToken;
    const sameImage = remote === this._lastRemote && this.imageEl.naturalWidth;

    if (!sameImage) {
      let display = await this._displayUrl(remote);
      if (token !== this._loadToken) return;
      try {
        await this._setImageSrc(display);
      } catch (_) {
        // blob revocato / cache rotta -> riscarica
        this._resolved.delete(remote);
        const bare = String(remote || "").split("?")[0];
        display = await resolveLocalImageUrl(`${bare}?fresh=${Date.now()}`);
        if (token !== this._loadToken) return;
        this._resolved.set(remote, display);
        await this._setImageSrc(display);
      }
      if (token !== this._loadToken) return;
      this._lastRemote = remote;
    }

    const w = this.imageEl.naturalWidth || map.width;
    const h = this.imageEl.naturalHeight || map.height;
    this.imageEl.width = w;
    this.imageEl.height = h;
    this.overlayEl.style.width = `${w}px`;
    this.overlayEl.style.height = `${h}px`;
    // Cambio mappa: parte sempre dall'angolo alto-sinistra. keepView solo sulla stessa foto.
    if (keepView && sameImage) {
      this.applyTransform();
    } else {
      this.fit();
      this._viewInitialized = true;
    }
    this.renderOverlay();
    this._forcePaint();
  }

  /** Forza ridisegno layer su mobile (il riquadro nero sparisce solo dopo un pan). */
  _forcePaint() {
    const w = this.world;
    if (!w) return;
    // micro-nudge + reflow
    const tx = this.tx;
    const ty = this.ty;
    const s = this.scale;
    w.style.transform = `translate3d(${tx}px, ${ty + 0.01}px, 0) scale(${s})`;
    void w.offsetHeight;
    requestAnimationFrame(() => {
      this.applyTransform();
    });
  }

  /**
   * Posizione iniziale uguale per tutte le mappe:
   * - pagina intera visibile (contain)
   * - attaccata a sinistra (barra menu)
   * - centrata in verticale
   * Pan/zoom dopo restano liberi.
   */
  fit() {
    if (!this.imageEl.naturalWidth && !this.imageEl.width) return;
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    const iw = this.imageEl.width || this.imageEl.naturalWidth;
    const ih = this.imageEl.height || this.imageEl.naturalHeight;
    if (!iw || !ih || !vw || !vh) return;
    const padL = 2; // attaccata alla colonna sinistra
    const padR = 6;
    const padY = 8;
    // Stessa regola per tutte: entra tutta in viewport, zoom leggermente più piccolo
    const fitScale = Math.min((vw - padL - padR) / iw, (vh - padY * 2) / ih);
    this.scale = Math.min(fitScale * 0.98, 4);
    this.tx = padL;
    this.ty = (vh - ih * this.scale) / 2;
    this.applyTransform();
  }

  applyTransform() {
    this.world.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
  }

  /** Zoom ancorato al punto (cx,cy) in coordinate viewport: quel pixel resta fermo. */
  zoomAt(cx, cy, factor) {
    const before = this.scale;
    const next = Math.min(8, Math.max(0.2, before * factor));
    if (next === before) return;
    const wx = (cx - this.tx) / before;
    const wy = (cy - this.ty) / before;
    this.scale = next;
    this.tx = cx - wx * next;
    this.ty = cy - wy * next;
    this.applyTransform();
  }

  _viewportPoint(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  _beginPinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (dist < 1) return;
    const mid = this._viewportPoint(
      (pts[0].x + pts[1].x) / 2,
      (pts[0].y + pts[1].y) / 2
    );
    // Punto mondo sotto il centro dita: resta inchiodato al pinch per tutta la gesture
    this._pinch = {
      startDist: dist,
      startScale: this.scale,
      wx: (mid.x - this.tx) / this.scale,
      wy: (mid.y - this.ty) / this.scale,
    };
    this._panning = false;
    this.viewport.classList.remove("panning");
    this._panStart = null;
  }

  _applyPinch() {
    if (!this._pinch || this._pointers.size < 2) return;
    const pts = [...this._pointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    if (dist < 1) return;
    const mid = this._viewportPoint(
      (pts[0].x + pts[1].x) / 2,
      (pts[0].y + pts[1].y) / 2
    );
    const next = Math.min(
      8,
      Math.max(0.2, this._pinch.startScale * (dist / this._pinch.startDist))
    );
    this.scale = next;
    this.tx = mid.x - this._pinch.wx * next;
    this.ty = mid.y - this._pinch.wy * next;
    this.applyTransform();
    this._moved = true;
  }

  highlight(tagId) {
    this.highlightId = tagId || null;
    this.renderOverlay();
  }

  renderOverlay() {
    const overlay = this.overlayEl;
    overlay.innerHTML = "";

    if (this._addDrag) {
      this._paintSelectionBox(this._normFromDrag(this._addDrag), false);
    } else if (this._addRectNorm) {
      this._paintSelectionBox(this._addRectNorm, true);
    }

    if (!this.map || !this.highlightId) return;
    const want = String(this.highlightId);
    const tag = (this.map.tags || []).find(
      (t) => String(t.id) === want || String(t.id).toUpperCase() === want.toUpperCase()
    );
    if (!tag) return;
    const iw =
      this.imageEl.naturalWidth ||
      this.imageEl.width ||
      this.map.width ||
      1;
    const ih =
      this.imageEl.naturalHeight ||
      this.imageEl.height ||
      this.map.height ||
      1;
    // riquadro sempre visibile (anche se il tag era finito troppo piccolo dopo un crop)
    const minPx = 28;
    let left = (Number(tag.x) || 0) * iw;
    let top = (Number(tag.y) || 0) * ih;
    let width = Math.max((Number(tag.w) || 0.04) * iw, minPx);
    let height = Math.max((Number(tag.h) || 0.04) * ih, minPx);
    if (left + width > iw) left = Math.max(0, iw - width);
    if (top + height > ih) top = Math.max(0, ih - height);
    const el = document.createElement("div");
    el.className = "tag-box hit";
    if (this.annotate) el.classList.add("edit");
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.dataset.tagId = tag.id;
    const lab = document.createElement("div");
    lab.className = "label";
    lab.textContent = tag.label || tag.id;
    el.appendChild(lab);
    if (this.annotate) {
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        this._dragTag = {
          id: tag.id,
          startX: e.clientX,
          startY: e.clientY,
          ox: tag.x,
          oy: tag.y,
        };
      });
    }
    overlay.appendChild(el);
  }

  _onPointerDown(e) {
    this.viewport.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
      // Pinch: annulla disegno selezione
      this._addDrag = null;
      this._panning = false;
      this.viewport.classList.remove("panning");
      this._panStart = null;
      this._beginPinch();
      this.renderOverlay();
    } else if (this._pointers.size === 1 && !this._dragTag) {
      if (this.addMode) {
        const p = this._clientToImagePx(e.clientX, e.clientY);
        this._addDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        this._addRectNorm = null;
        this._moved = false;
        this.renderOverlay();
      } else {
        this._panning = true;
        this.viewport.classList.add("panning");
        this._panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        this._moved = false;
      }
    }
  }

  _onPointerMove(e) {
    if (this._dragTag && this.map) {
      const dx = (e.clientX - this._dragTag.startX) / this.scale / this.imageEl.width;
      const dy = (e.clientY - this._dragTag.startY) / this.scale / this.imageEl.height;
      const tag = this.map.tags.find((t) => t.id === this._dragTag.id);
      if (tag) {
        tag.x = Math.min(1 - tag.w, Math.max(0, this._dragTag.ox + dx));
        tag.y = Math.min(1 - tag.h, Math.max(0, this._dragTag.oy + dy));
        this.renderOverlay();
      }
      return;
    }

    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 2 && this._pinch) {
      this._applyPinch();
      return;
    }

    if (this.addMode && this._addDrag && this._pointers.size === 1) {
      const p = this._clientToImagePx(e.clientX, e.clientY);
      this._addDrag.x1 = p.x;
      this._addDrag.y1 = p.y;
      if (
        Math.abs(this._addDrag.x1 - this._addDrag.x0) +
          Math.abs(this._addDrag.y1 - this._addDrag.y0) >
        6
      ) {
        this._moved = true;
      }
      this.renderOverlay();
      return;
    }

    if (this._panning && this._panStart) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) this._moved = true;
      this.tx = this._panStart.tx + dx;
      this.ty = this._panStart.ty + dy;
      this.applyTransform();
    }
  }

  _onPointerUp(e) {
    const wasDrag = this._dragTag;
    const moved = this._moved;
    const finishingAdd =
      this.addMode && this._addDrag && this._pointers.size === 1;

    if (wasDrag) {
      this._dragTag = null;
      if (this.onTagMoved) this.onTagMoved(wasDrag.id);
    }

    this._pointers.delete(e.pointerId);

    if (finishingAdd && this._addDrag) {
      const norm = this._normFromDrag(this._addDrag);
      const iw = this.imageEl.naturalWidth || this.imageEl.width || 1;
      const ih = this.imageEl.naturalHeight || this.imageEl.height || 1;
      const pxW = norm.w * iw;
      const pxH = norm.h * ih;
      this._addDrag = null;
      if (pxW >= 12 && pxH >= 12) {
        this._addRectNorm = norm;
        this.renderOverlay();
        if (this.onAddRect) this.onAddRect(norm);
      } else {
        this.renderOverlay();
      }
    }

    // Fine pinch -> se resta un dito...
    if (this._pointers.size < 2) {
      this._pinch = null;
      if (this._pointers.size === 1 && !this._dragTag) {
        const remaining = [...this._pointers.values()][0];
        if (this.addMode) {
          const p = this._clientToImagePx(remaining.x, remaining.y);
          this._addDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
          this._panning = false;
          this.viewport.classList.remove("panning");
          this._panStart = null;
        } else {
          this._panning = true;
          this.viewport.classList.add("panning");
          this._panStart = {
            x: remaining.x,
            y: remaining.y,
            tx: this.tx,
            ty: this.ty,
          };
        }
      }
    }

    if (this._pointers.size === 0) {
      // Un tap/click sul tag (non pan, non Aggiungi) -> ricerca
      if (!this.addMode && !wasDrag && !moved && this.onTagDoubleSelect) {
        if (this.findTagAtClient(e.clientX, e.clientY)) {
          this._emitTagDoubleSelect(e.clientX, e.clientY);
        }
      }

      this._panning = false;
      this.viewport.classList.remove("panning");
      this._panStart = null;
      this._moved = false;
      this._addDrag = null;
    }
  }
}
