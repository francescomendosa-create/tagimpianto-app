/* Shell leggera: HTML/JS/CSS sempre da rete se online. Niente precache che blocca gli aggiornamenti. */
const CACHE = "tag-impianto-shell-v76";
const MAP_CACHE = "tag-impianto-maps-v76";

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  // Non precache-are lâ€™app: altrimenti resti bloccato su JS/HTML vecchi
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  const keep = new Set([CACHE, MAP_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isMapAsset(url) {
  return url.pathname.includes("/assets/maps/") && /\.(png|jpe?g|webp)$/i.test(url.pathname);
}

function isVersionOrShell(url) {
  const p = url.pathname;
  return (
    /\/version\.(js|json)$/i.test(p) ||
    /\/index\.html$/i.test(p) ||
    /\/aggiorna\.html$/i.test(p) ||
    /\/sw\.js$/i.test(p) ||
    p.endsWith("/")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // version / index: SOLO rete, mai cache (aggiornamenti immediati)
  if (isVersionOrShell(url)) {
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(() => caches.match(req))
    );
    return;
  }

  // Mappe sullo stesso origin (se presenti): rete poi cache
  if (isMapAsset(url)) {
    event.respondWith(
      caches.open(MAP_CACHE).then(async (cache) => {
        try {
          const res = await fetch(req, { cache: "no-store" });
          if (res && res.ok) {
            try {
              await cache.put(req, res.clone());
            } catch (_) {
              /* quota */
            }
            return res;
          }
        } catch (_) {
          /* offline */
        }
        const hit = await cache.match(req);
        if (hit) return hit;
        const bare = new Request(url.pathname + url.hash, { method: "GET" });
        return (await cache.match(bare)) || Response.error();
      })
    );
    return;
  }

  // JS/CSS/data: rete fresca, fallback cache offline
  const isApp =
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".json") ||
    url.pathname.endsWith(".webmanifest");

  event.respondWith(
    fetch(req, isApp ? { cache: "no-store" } : undefined)
      .then((res) => {
        if (res && res.ok && isApp) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
