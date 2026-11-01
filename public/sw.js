/* =============================================================================
   Tomei — service worker.
   ARQUIVO-MODELO: o `npm run build` gera public/sw.js a partir deste (preenche
   a versão e a lista de arquivos do cache). Não edite public/sw.js direto.

   Faz três coisas:
     1. Guarda o app inteiro no cache → abre e funciona SEM internet.
     2. Recebe os lembretes (Web Push) e mostra a notificação.
     3. Ao tocar na notificação, abre o app já pedindo para registrar a dose.
   ========================================================================== */
const BUILD = "0f42c86dc7";
const CACHE = `tomei-${BUILD}`;
const PRECACHE = [
  "./",
  "./config.js",
  "./css/app.css",
  "./icons/apple-touch-icon.png",
  "./icons/badge-72.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg",
  "./index.html",
  "./js/app.js",
  "./js/build-info.js",
  "./js/db.js",
  "./js/logic.js",
  "./js/model.js",
  "./js/push.js",
  "./js/remote.js",
  "./js/store.js",
  "./js/sync.js",
  "./js/util.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  // Não chama skipWaiting sozinho: o app avisa "há uma versão nova" e o usuário escolhe quando atualizar.
  // cache: "reload" ignora o cache HTTP do navegador. Hospedagens como o GitHub Pages mandam
  // "max-age=600": sem isto, uma versão nova poderia guardar por até 10 min cópias VELHAS dos
  // arquivos (e o app ficaria preso nelas, porque o nome do cache já seria o da versão nova).
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("tomei-") && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase e afins passam direto, sem cache
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // qualquer navegação (inclusive ?take=...) abre o index.html guardado
    if (req.mode === "navigate") return (await cache.match("./index.html")) ?? fetch(req);
    return (await cache.match(req, { ignoreSearch: true })) ?? fetch(req);
  })());
});

// ---------- lembretes ----------
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Tomei", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Tomei", {
    body: data.body || "",
    tag: data.tag || undefined,       // mesma tag = substitui a notificação anterior
    renotify: !!data.tag,             // e avisa de novo (som/vibração)
    icon: "icons/icon-192.png",
    badge: "icons/badge-72.png",
    vibrate: [140, 80, 140],
    data: { url: data.url || "./", medIds: data.medIds || [] },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: "navigate", url: target }); // app já aberto: só avisa
        return;
      }
    }
    await self.clients.openWindow(target); // app fechado: abre já com ?take=<remédio>
  })());
});
