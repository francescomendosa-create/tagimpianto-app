/**
 * OCR misto: Tesseract propone i tag, poi si correggono a mano (Annota).
 */

const TAG_RE =
  /\b(?:(?:TK|FCV|LCV|XV|P|PG|VP|MX|FIT|AIT|TIT|LT|TT|K|A)[-_]?)?\d{2,6}[A-Z0-9_-]*[A-Z]?\b|\b(?:66-ST\d+[A-Z]?|TT\d+_B|VP\d+_B|PG\d+_B)\b/gi;

const NOISE = new Set([
  "SERVIZIO",
  "SODA",
  "ACIDO",
  "SOLF",
  "COAGULANTE",
  "COAGULAZIONE",
  "CHIARIFICATO",
  "CHIARIFICATORE",
  "FANGHI",
  "SATURATORE",
  "POLIELETTROLITA",
  "SEDI",
  "FLOTTATORE",
  "HOLD",
  "TOTALIZZATORI",
  "INTERCONNECTING",
  "GESTIONE",
  "VASCHE",
  "ASSETTO",
]);

let workerPromise = null;

function guessKind(id) {
  const u = id.toUpperCase();
  if (/^(P|PG|VP)\d/.test(u) || /^(PG|VP)\d+_B/.test(u)) return "pompa";
  if (/^(XV|FCV|LCV)/.test(u)) return "valvola";
  if (/^TK/.test(u)) return "serbatoio";
  if (/^(A-|66-)/.test(u) || /^A\d/.test(u)) return "apparecchio";
  if (/^FIL/.test(u)) return "filtro";
  if (/^(FIT|AIT|TIT|LT|TT|\d{3}(FIT|AIT|LT|TIT))/.test(u) || /TT\d+_B/.test(u))
    return "strumento";
  if (/^MX/.test(u)) return "mixer";
  if (/^K\d/.test(u)) return "compressor";
  return "altro";
}

function normalizeTagId(raw) {
  let s = String(raw || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[|Il]/g, (ch, i) => {
      // OCR spesso confonde I/l/| nei tag — lascia cifre intatte
      if (/\d/.test(ch)) return ch;
      return ch === "|" ? "I" : ch;
    });
  s = s.replace(/[^A-Z0-9_-]/g, "");
  if (s.length < 4 || s.length > 22) return null;
  if (!/\d/.test(s)) return null;
  if (NOISE.has(s)) return null;
  // Scarta percentuali / valori numerici puri
  if (/^\d+[.,]?\d*$/.test(s)) return null;
  return s;
}

function extractTagCandidates(text) {
  const found = new Set();
  const t = String(text || "").toUpperCase();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(t))) {
    const id = normalizeTagId(m[0]);
    if (id) found.add(id);
  }
  // pezzi spezzati tipo "P 11100 A"
  const spaced = t.match(/\b[A-Z]{1,4}\s*\d{3,6}\s*[A-Z]?\b/g) || [];
  for (const piece of spaced) {
    const id = normalizeTagId(piece.replace(/\s+/g, ""));
    if (id) found.add(id);
  }
  return [...found];
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = (
        await import("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/+esm")
      ).default;
      const worker = await Tesseract.createWorker("eng", 1, {
        logger: (m) => {
          if (onProgress && m.status === "recognizing text" && m.progress != null) {
            onProgress(m.progress);
          }
        },
      });
      await worker.setParameters({
        tessedit_char_whitelist:
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.:%",
        preserve_interword_spaces: "1",
      });
      return worker;
    })();
  }
  return workerPromise;
}

function padBox(bbox, imgW, imgH, pad = 4) {
  const x0 = Math.max(0, bbox.x0 - pad);
  const y0 = Math.max(0, bbox.y0 - pad);
  const x1 = Math.min(imgW, bbox.x1 + pad);
  const y1 = Math.min(imgH, bbox.y1 + pad);
  return {
    x: x0 / imgW,
    y: y0 / imgH,
    w: Math.max(0.02, (x1 - x0) / imgW),
    h: Math.max(0.03, (y1 - y0) / imgH),
  };
}

/**
 * @param {HTMLImageElement|HTMLCanvasElement|string} imageSource
 * @param {{ onProgress?: (p:number)=>void }} [opts]
 * @returns {Promise<Array<{id:string,label:string,kind:string,x:number,y:number,w:number,h:number,confidence:number,source:string}>>}
 */
export async function runMapOcr(imageSource, opts = {}) {
  const worker = await getWorker(opts.onProgress);

  // Upscale 2× aiuta i box piccoli delle HMI
  const canvas = document.createElement("canvas");
  const img =
    typeof imageSource === "string"
      ? await loadImage(imageSource)
      : imageSource;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = iw < 1600 ? 2 : 1.5;
  canvas.width = Math.round(iw * scale);
  canvas.height = Math.round(ih * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const { data } = await worker.recognize(canvas);
  const words = data.words || [];
  const byId = new Map();

  for (const word of words) {
    const conf = Number(word.confidence) || 0;
    if (conf < 45) continue;
    const candidates = extractTagCandidates(word.text);
    if (!candidates.length) continue;
    const box = padBox(
      {
        x0: word.bbox.x0 / scale,
        y0: word.bbox.y0 / scale,
        x1: word.bbox.x1 / scale,
        y1: word.bbox.y1 / scale,
      },
      iw,
      ih
    );
    for (const id of candidates) {
      const prev = byId.get(id);
      if (!prev || conf > prev.confidence) {
        byId.set(id, {
          id,
          label: id,
          kind: guessKind(id),
          ...box,
          confidence: conf,
          source: "ocr",
        });
      }
    }
  }

  // Fallback: righe intere se poche word-hit
  if (byId.size < 5 && data.lines) {
    for (const line of data.lines) {
      const conf = Number(line.confidence) || 0;
      if (conf < 40) continue;
      for (const id of extractTagCandidates(line.text)) {
        if (byId.has(id)) continue;
        const box = padBox(
          {
            x0: line.bbox.x0 / scale,
            y0: line.bbox.y0 / scale,
            x1: line.bbox.x1 / scale,
            y1: line.bbox.y1 / scale,
          },
          iw,
          ih
        );
        // linee lunghe → box troppo largo: restringi al centro
        if (box.w > 0.18) {
          box.x += (box.w - 0.08) / 2;
          box.w = 0.08;
        }
        byId.set(id, {
          id,
          label: id,
          kind: guessKind(id),
          ...box,
          confidence: conf,
          source: "ocr",
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Immagine OCR non caricata"));
    im.src = src;
  });
}

/**
 * Unisce OCR con tag esistenti.
 * - manual / locked: non sposta
 * - seed/ocr/assente: aggiorna posizione se OCR ha lo stesso id
 * - nuovi id OCR: aggiunti
 */
export function mergeOcrIntoMap(map, ocrTags) {
  const tags = [...(map.tags || [])];
  const index = new Map(tags.map((t, i) => [String(t.id).toUpperCase(), i]));
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const o of ocrTags) {
    const key = o.id.toUpperCase();
    const i = index.get(key);
    if (i == null) {
      tags.push({ ...o });
      index.set(key, tags.length - 1);
      added++;
      continue;
    }
    const cur = tags[i];
    const locked = cur.locked || cur.source === "manual";
    if (locked) {
      skipped++;
      continue;
    }
    tags[i] = {
      ...cur,
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      kind: cur.kind || o.kind,
      label: cur.label || o.label,
      confidence: o.confidence,
      source: cur.source === "seed" ? "ocr" : cur.source || "ocr",
    };
    updated++;
  }

  return { tags, added, updated, skipped };
}

/**
 * OCR su una regione normalizzata (0–1) dell’immagine — per “Aggiungi tag”.
 * @returns {Promise<{text:string,candidates:string[],best:string|null,kind:string,confidence:number}>}
 */
export async function ocrImageRegion(imageSource, region, opts = {}) {
  const worker = await getWorker(opts.onProgress);
  const img =
    typeof imageSource === "string"
      ? await loadImage(imageSource)
      : imageSource;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) throw new Error("Immagine non pronta");

  const pad = 0.004;
  const x0 = Math.max(0, Math.floor((Number(region.x) - pad) * iw));
  const y0 = Math.max(0, Math.floor((Number(region.y) - pad) * ih));
  const x1 = Math.min(iw, Math.ceil((Number(region.x) + Number(region.w) + pad) * iw));
  const y1 = Math.min(ih, Math.ceil((Number(region.y) + Number(region.h) + pad) * ih));
  const rw = Math.max(8, x1 - x0);
  const rh = Math.max(8, y1 - y0);

  const scale = Math.min(4, Math.max(2.5, 420 / Math.max(rw, rh)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(rw * scale);
  canvas.height = Math.round(rh * scale);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#d8dde3";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, x0, y0, rw, rh, 0, 0, canvas.width, canvas.height);

  const { data } = await worker.recognize(canvas);
  const text = String(data?.text || "").trim();
  const byId = new Map();

  for (const word of data?.words || []) {
    const conf = Number(word.confidence) || 0;
    if (conf < 35) continue;
    for (const id of extractTagCandidates(word.text)) {
      const prev = byId.get(id);
      if (!prev || conf > prev.conf) byId.set(id, { id, conf });
    }
  }
  for (const id of extractTagCandidates(text)) {
    if (!byId.has(id)) byId.set(id, { id, conf: 50 });
  }

  const ranked = [...byId.values()].sort((a, b) => b.conf - a.conf);
  const best = ranked[0]?.id || null;
  return {
    text,
    candidates: ranked.map((r) => r.id),
    best,
    kind: best ? guessKind(best) : "altro",
    confidence: ranked[0]?.conf || 0,
  };
}

export async function terminateOcr() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch (_) {
    /* ignore */
  }
  workerPromise = null;
}
