// Fumetteca – service worker: tiene sul telefono l'app, gli elenchi delle uscite e le copertine,
// così l'app si apre e funziona anche senza rete (fiere, metropolitana…). Con la rete si aggiorna da sola.
const V = 'fumetteca-v1';
const APP = V + '-app', DATA = V + '-data', IMG = 'fumetteca-img';   // le copertine restano anche quando cambia versione
const MAX_IMG = 1500;
const SHELL = ['./', './index.html', './config.js', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js',
  'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700;800&display=swap'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(APP).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('fumetteca-') && ![APP, DATA, IMG].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const timeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
const bare = u => { const x = new URL(u); return x.origin + x.pathname; };

// app (pagina, config.js, icone): subito dalla memoria, intanto scarico la versione nuova per la prossima apertura
async function appFile(req) {
  const c = await caches.open(APP), key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : bare(req.url);
  const hit = await c.match(key) || (req.mode === 'navigate' ? await c.match(new URL('./index.html', self.registration.scope).href) : null), old = hit && hit.clone();
  const net = fetch(req.mode === 'navigate' ? new Request(req.url, { cache: 'no-cache' }) : new Request(req, { cache: 'no-cache' }))
    .then(async r => {
      if (r.ok && !r.redirected) {
        const changed = old && req.mode === 'navigate' && (await r.clone().text()) !== (await old.text());
        await c.put(key, r.clone());
        if (changed) for (const cl of await self.clients.matchAll({ type: 'window' })) cl.postMessage({ type: 'update' });   // c'è una versione nuova dell'app
      }
      return r; });
  if (hit) { net.catch(() => {}); return hit; }
  return net.catch(() => new Response('Fumetteca non è ancora disponibile senza rete: aprila una volta con la connessione.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}
// elenchi delle uscite: dalla rete se risponde entro 5 secondi, altrimenti la copia salvata (e la rete aggiorna la copia)
async function dataFile(req) {
  const c = await caches.open(DATA), key = bare(req.url), hit = await c.match(key);
  const net = fetch(req).then(r => { if (r.ok) c.put(key, r.clone()); return r; });
  if (!hit) return net;
  try { const r = await timeout(net, 5000); return r.ok ? r : hit; } catch (e) { net.catch(() => {}); return hit; }
}
// librerie e font: una volta scaricati non cambiano
async function staticFile(req) {
  const c = await caches.open(APP), hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const r = await fetch(req); if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r;
}
// copertine: prima la copia salvata; le nuove le salvo (al massimo MAX_IMG, tolgo le più vecchie)
let trimming = false;
async function trim(c) {
  if (trimming) return; trimming = true;
  try { const ks = await c.keys(); for (let i = 0; i < ks.length - MAX_IMG; i++) await c.delete(ks[i]); } finally { trimming = false; }
}
async function image(req) {
  const c = await caches.open(IMG), key = req.url, hit = await c.match(key);
  // le immagini lette "in chiaro" (per il colore delle coste) non possono usare una copia opaca
  if (hit && (req.mode !== 'cors' || hit.type !== 'opaque')) return hit;
  try {
    const r = await fetch(req);
    if (r.ok || r.type === 'opaque') { c.put(key, r.clone()).then(() => trim(c)).catch(() => {}); }
    return r;
  } catch (e) { if (hit && req.mode !== 'cors') return hit; throw e; }
}

self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin === location.origin) {
    if (/\/uscite(?:\.json|-starcomics\.json|\/[^/]+\.json)$/.test(u.pathname)) return e.respondWith(dataFile(r));
    if (r.mode === 'navigate' || /\/(?:index\.html|config\.js|manifest\.json|icon-\d+\.png)?$/.test(u.pathname)) return e.respondWith(appFile(r));
    return;
  }
  if (/(?:^|\.)(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|use\.typekit\.net|p\.typekit\.net)$/.test(u.host)) return e.respondWith(staticFile(r));
  if (r.destination === 'image') return e.respondWith(image(r));
});

// dalla pagina: "prepara per l'uso offline" → scarico e salvo un elenco di copertine
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'prefetch' && Array.isArray(d.urls)) e.waitUntil((async () => {
    const c = await caches.open(IMG); let done = 0, ok = 0, i = 0;
    const one = async () => { while (i < d.urls.length) { const u = d.urls[i++];
      try { if (!(await c.match(u))) { const r = await timeout(fetch(u, { mode: 'no-cors' }), 15000); if (r.ok || r.type === 'opaque') { await c.put(u, r); ok++; } } else ok++; } catch (x) {}
      if (++done % 10 === 0 || done === d.urls.length) e.source && e.source.postMessage({ type: 'prefetch', done, ok, total: d.urls.length }); } };
    await Promise.all(Array.from({ length: 6 }, one)); trim(c);
  })());
});
