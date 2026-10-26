// Fumetteca – raccoglie ogni giorno uscite e cataloghi dai siti ufficiali degli editori.
// Scrive uscite.json (indice: editori, stato, prefissi ISBN) + uscite/<editore>.json (i volumi di ogni editore),
// letti da index.html sullo stesso sito GitHub Pages: il telefono scarica solo gli editori che servono.
// Nessuna libreria esterna (Node 18+). Ogni editore è indipendente: se un sito non risponde, gli altri vanno avanti.
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
// alcuni negozi (es. Magic Press) mandano intestazioni molto grandi: Node le rifiuta (UND_ERR_HEADERS_OVERFLOW)
// se non è avviato con un limite più alto, quindi mi rilancio da solo con --max-http-header-size
if (http.maxHeaderSize < 262144 && !process.env.FUMETTECA_RELAUNCH) {
  const r = spawnSync(process.execPath, ['--max-http-header-size=262144', ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, FUMETTECA_RELAUNCH: '1' } });
  process.exit(r.status ?? 1);
}
const OUT = process.env.OUT || 'uscite.json', DIR = process.env.OUTDIR || 'uscite';
const PAUSE = +(process.env.PAUSE ?? 400), STAR_WEEKS_BACK = +(process.env.STAR_WEEKS_BACK || 520);
const DETAILS = +(process.env.DETAILS || 3000), SMALL_DETAILS = +(process.env.SMALL_DETAILS || 1000);
const CONC = +(process.env.CONC || 4), BUDGET = +(process.env.BUDGET_MIN || 60) * 6e4, T0 = Date.now();
const late = () => Date.now() - T0 > BUDGET;

// ---------- editori: piattaforma del negozio + dove si trova il catalogo ----------
// shopify: /products.json · woo: WooCommerce (Store API; se è chiusa legge le pagine del negozio) · html: pagine del negozio
const SRC = [
  { k: 'star', name: 'Star Comics', site: 'https://www.starcomics.com', run: star },
  { k: 'panini', name: 'Panini Comics', site: 'https://www.panini.it', run: panini },
  { k: 'jpop', name: 'J-POP Manga', site: 'https://j-pop.it', type: 'shopify', pre: ['in-preordine'] },
  { k: 'bd', name: 'Edizioni BD', site: 'https://www.edizionibd.it', type: 'shopify', pre: ['in-preordine', 'preordini'] },
  { k: 'goen', name: 'Goen (RW Edizioni)', site: 'https://rw-edizioni.myshopify.com', type: 'shopify' },
  { k: 'musubi', name: 'Musubi Edizioni', site: 'https://musubiedizioni.it', type: 'shopify' },
  { k: 'hollow', name: 'Hollow Press', site: 'https://hollow-press.net', type: 'shopify' },
  { k: 'magic', name: 'Magic Press', site: 'https://b2c.magicpressedizioni.it', type: 'html', list: ['/43-manga?page={n}', '/12-801-yaoi?page={n}', '/13-mx?page={n}', '/55-edizioni-limitate?page={n}'], preList: ['/module/preorder/allpreorderdetails'], prod: /^\/(?:[a-z0-9-]+\/)?\d+-[a-z0-9-]+\.html$/, maxPages: 150 },
  { k: 'nipponshock', name: 'Nippon Shock Edizioni', site: 'https://www.nipponshock.com', type: 'html', list: ['/shop/manga'], prod: /^\/shop\/[a-z0-9-]+$/ },
  { k: 'dokusho', name: 'Dokusho Edizioni', site: 'https://dokusho.it', type: 'woo', list: ['/index.php/shop/page/{n}/'], prod: /\/prodotto\/[^/]+\/?$/ },
  { k: 'dynit', name: 'Dynit', site: 'https://www.dynit.it', type: 'woo', cat: /manga/i, list: ['/prodotti/manga/page/{n}/'], prod: /\/prodott[oi]\/[^/]+\/?$/ },
  { k: 'hikari', name: 'Hikari Edizioni', site: 'https://hikariedizioni.it', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/prodotto\/[^/]+\/?$/ },
  { k: 'e001', name: '001 Edizioni', site: 'https://www.001edizioni.com', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/(?:prodotto|product)\/[^/]+\/?$/ },
  { k: 'ishi', name: 'Ishi Publishing', site: 'https://ishipublishing.it', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/(?:prodotto|product)\/[^/]+\/?$/ },
  { k: 'bonelli', name: 'Sergio Bonelli Editore', site: 'https://www.sergiobonelli.it', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/(?:prodotto|product)\/[^/]+\/?$/, maxPages: 200 },
  { k: 'cosmo', name: 'Editoriale Cosmo', site: 'https://www.editorialecosmo.it', type: 'woo', list: ['/negozio/page/{n}/'], prod: /\/product\/[^/]+\/?$/, maxPages: 200 },
  { k: 'npe', name: 'Edizioni NPE', site: 'https://edizioninpe.it', type: 'woo', list: ['/store/page/{n}/'], prod: /\/product\/[^/]+\/?$/ },
  { k: 'tunue', name: 'Tunué', site: 'https://www.tunue.com', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/product\/[^/]+\/?$/ },
  { k: 'coconino', name: 'Coconino Press', site: 'https://www.coconinopress.it', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/prodotto\/[^/]+\/?$/ },
  { k: 'bao', name: 'BAO Publishing', site: 'https://baopublishing.it', type: 'woo', list: ['/shop/page/{n}/'], prod: /\/(?:prodotti|prodotto|product|fumetto)\/[^/]+\/?$/ },
];
// per le prove: BASE_<EDITORE>=http://127.0.0.1:porta (vale anche il vecchio STAR_BASE, PANINI_BASE, JPOP_BASE)
const baseOf = s => process.env['BASE_' + s.k.toUpperCase()] || process.env[s.k.toUpperCase() + '_BASE'] || s.site;
const ONLY = (process.env.ONLY || SRC.map(s => s.k).join(',')).split(',');

// ---------- strumenti ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEAD = { 'user-agent': 'Mozilla/5.0 (compatible; Fumetteca personal release checker; +https://github.com)', 'accept-language': 'it-IT,it;q=0.9' };
const lastErr = new Map(), host = u => { try { return new URL(u).host; } catch (e) { return ''; } };
// robots.txt: rispetto le regole per tutti i programmi (User-agent: *) o per "fumetteca"; le pagine vietate non le leggo
const robotsC = new Map(), blocked = new Map();
function parseRobots(txt) {
  const groups = []; let cur = null, inRules = false;
  for (const line of String(txt || '').split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2];
    if (k === 'user-agent') { if (!cur || inRules) { cur = { agents: [], rules: [] }; groups.push(cur); inRules = false; } cur.agents.push(v.toLowerCase()); }
    else if ((k === 'allow' || k === 'disallow') && cur) { inRules = true; if (v) cur.rules.push({ allow: k === 'allow', len: v.length, re: new RegExp('^' + v.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')) }); }
  }
  const mine = groups.filter(g => g.agents.some(a => a.includes('fumetteca')));
  return (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}
async function allowed(u) {
  const U = new URL(u); if (U.pathname === '/robots.txt') return true;
  if (!robotsC.has(U.origin)) robotsC.set(U.origin, fetch(U.origin + '/robots.txt', { headers: HEAD, signal: AbortSignal.timeout(20000) }).then(r => r.ok ? r.text() : '').catch(() => '').then(parseRobots));
  const rules = await robotsC.get(U.origin), path = U.pathname + U.search; let best = null;
  for (const r of rules) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
  return !best || best.allow;
}
async function get(u, json, method) {
  if (!(await allowed(u))) { blocked.set(host(u), (blocked.get(host(u)) || 0) + 1); lastErr.set(host(u), 'vietato da robots.txt'); return null; }
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(u, { method: method || 'GET', headers: json ? { ...HEAD, accept: 'application/json' } : HEAD, signal: AbortSignal.timeout(30000) });
      if (method === 'HEAD') return r.ok && /^image\//.test(r.headers.get('content-type') || '') ? 'ok' : r.status === 405 ? 'no-head' : null;
      if (r.ok) { const x = await r.text(); if (!json) return x; try { return JSON.parse(x); } catch (e) { return null; } }
      lastErr.set(host(u), 'HTTP ' + r.status);
      if ([401, 403, 404, 410].includes(r.status)) return null;
    } catch (e) { lastErr.set(host(u), (e.cause && e.cause.code) || e.name || 'errore di rete'); }
    await sleep(1500 * (t + 1));
  }
  return null;
}
const why = B => lastErr.get(host(B)) ? ` (${lastErr.get(host(B))})` : '';
const robo = B => blocked.get(host(B)) ? `, ${blocked.get(host(B))} pagine saltate perché vietate da robots.txt` : '';
const ENT = { nbsp: ' ', amp: '&', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '–', mdash: '—', hellip: '…', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', deg: '°', ordm: 'º' };
const ent = s => String(s || '').replace(/&#x([0-9a-f]+);/gi, (m, c) => String.fromCodePoint(parseInt(c, 16))).replace(/&#(\d+);/g, (m, c) => String.fromCodePoint(+c)).replace(/&([a-z]+);/gi, (m, c) => ENT[c.toLowerCase()] ?? m);
const strip = h => ent(String(h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const MESI = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };
const p2 = x => String(x).padStart(2, '0');
function anyDate(t) {
  let m = t.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/); if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
  m = t.match(/\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i); if (m) return `${m[3]}-${p2(MESI[m[2].toLowerCase()])}-${p2(m[1])}`;
  m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/); return m ? m[0] : '';
}
// una data vale solo se è preceduta da un'etichetta di uscita (le pagine sono piene di altre date)
const DLAB = /(?:data di uscita|data d'uscita|data uscita|in uscita (?:il|dal)|uscita prevista|disponibile dal|data di pubblicazione|release date|uscita)\s*:?\s*\D{0,20}?(\d{1,2}[\/.]\d{1,2}[\/.]\d{4}|\d{1,2}\s+[a-z]+\s+\d{4}|20\d{2}-\d{2}-\d{2})/i;
const labDate = t => { const m = String(t).match(DLAB); return m ? anyDate(m[1]) : ''; };
const PRE = /pre-?ordin|prenota|in arrivo|prossimamente|prossime uscite|coming soon|pre-?order|disponibile a breve/i;
const ok13 = i => { if (!/^97[89]\d{10}$/.test(i)) return false; let t = 0; for (let k = 0; k < 12; k++) t += +i[k] * (k % 2 ? 3 : 1); return (10 - t % 10) % 10 === +i[12]; };
const to13 = a => { const s = '978' + a.slice(0, 9); let t = 0; for (let k = 0; k < 12; k++) t += +s[k] * (k % 2 ? 3 : 1); return s + (10 - t % 10) % 10; };
const isbnIn = t => (String(t).match(/97[89][\d-]{10,16}/g) || []).map(x => x.replace(/-/g, '')).find(ok13) || '';
const cleanIsbn = s => { s = String(s || '').replace(/[^0-9X]/gi, ''); return ok13(s) ? s : /^(?:88|12)\d{7}[\dX]$/i.test(s) ? to13(s) : ''; };
const meta = (html, prop) => { const m = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=(["\'])(.*?)\\1', 'i')) || html.match(new RegExp('<meta[^>]+content=(["\'])(.*?)\\1[^>]*(?:property|name)=["\']' + prop + '["\']', 'i')); return m ? m[2] : ''; };
const ogImage = (html, base) => { const u = meta(html, 'og:image'); return u ? new URL(ent(u), base).href : ''; };
const pagesIn = t => +((t.match(/pagine\D{0,3}(\d{2,4})\b/i) || t.match(/\b(\d{2,4})\s*pagine/i) || [])[1] || 0);
const esc = s => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
// numero e serie dal titolo: "Slime, Vol. 10 – Limited", "JYOSHIKOHEI #2 (di 7)", "COLORLESS (1)", "Al mio caro M 1 (di 3)", "ALPHA 17 – LIBERTY SHIP", "Tex n° 780"
function volOf(title) {
  const t = String(title || '').replace(/\s+/g, ' ').trim(); let m;
  if ((m = t.match(/\b(?:vol(?:ume)?|n[°º]?|num|numero)\s*\.?\s*#?\s*0*(\d{1,4})(?![.,]\d)\b/i)) ||
      (m = t.match(/#\s*0*(\d{1,4})(?![.,]\d)\b/)) ||
      (m = t.match(/\(\s*0*(\d{1,4})\s*(?:di\s*\d+\s*)?\)/i)) ||
      (m = [...t.matchAll(/\s0*(\d{1,3})(?=\s*(?:\(di\s*\d+\)|[–—:+]|-\s|$))/g)].pop())) {
    const number = +m[1], serie = t.slice(0, m.index).replace(/[\s,.:;–—\-(#]+$/, '').trim();
    return serie && number >= 1 ? { number, serie } : null;
  }
  return null;
}
// immagine grande al posto della miniatura (WordPress -300x300, PrestaShop home_default, Shopify _200x)
const big = u => String(u || '').replace(/-\d{2,4}x\d{2,4}(?=\.(?:jpe?g|png|webp)\b)/i, '').replace(/-(?:home|small|medium|cart)_default(?=\/)/, '-large_default').replace(/_(?:\d+x\d*|small|medium|compact)(?=\.(?:jpe?g|png|webp))/i, '');

// ---------- archivio: vecchio uscite.json (v1, tutto in un file) oppure indice v2 + un file per editore ----------
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const items = new Map();
for (const x of old.items || []) items.set(x.url, { pub: 'star', ...x });
for (const s of SRC) {
  const f = `${DIR}/${s.k}.json`; if (!fs.existsSync(f)) continue;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); for (const x of j.items || []) items.set(x.url, { ...x, pub: s.k });
    for (const [url, d] of j.checked || []) if (!items.has(url)) items.set(url, { url, pub: s.k, number: null, nonum: 1, detailAt: d }); } catch (e) {}
}
const stats = old.stats || {}, state = old.state || {};
const now = new Date(), today = now.toISOString().slice(0, 10);
const put = (pub, e) => { const o = items.get(e.url) || { seen: today }; items.set(e.url, { ...o, ...e, pub }); };
const age = d => (Date.parse(today) - Date.parse(d)) / 864e5;
// scheda da rileggere? mai letta; senza numero: ogni 60 giorni; con dati mancanti o uscita futura: ogni 6 giorni
const stale = x => !x.detailAt || (x.nonum ? age(x.detailAt) > 60 : (!x.cover || !x.isbn || (!x.date && !x.nd) || x.date > today) && age(x.detailAt) > 6);
const first = k => (a, b) => (!!a.cover - !!b.cover) || (b[k] || '').localeCompare(a[k] || '');
async function pool(list, max, fn) {
  let i = 0; const run = async () => { while (i < Math.min(list.length, max) && !late()) { const x = list[i++]; await fn(x); await sleep(PAUSE); } };
  await Promise.all(Array.from({ length: CONC }, run)); return i;
}

// ---------- STAR COMICS: pagine settimanali /uscite/AAAA-MM-GG + scheda del volume ----------
async function star(src) {
  const B = baseOf(src), R = src.site;
  const done = new Set(state.starWeeks || []); let fetched = 0, failed = 0;
  const d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()), lastTue = d0 - ((new Date(d0).getUTCDay() + 5) % 7) * 864e5;
  for (let w = -STAR_WEEKS_BACK; w <= 12; w++) {
    const d = new Date(lastTue + w * 7 * 864e5).toISOString().slice(0, 10);
    if (done.has(d) && w < -6) continue;
    const h = await get(`${B}/uscite/${d}`); if (h == null) { failed++; continue; }
    const re = /href=["'](?:https?:\/\/(?:www\.)?starcomics\.com)?(\/fumetto\/[a-z0-9-]+)\/?["']/gi, hits = []; let m;
    while ((m = re.exec(h))) hits.push({ p: m[1].toLowerCase(), i: m.index });
    const seen = new Set();
    for (let k = 0; k < hits.length; k++) {
      const x = hits[k]; if (seen.has(x.p)) continue; seen.add(x.p);
      let j = k + 1; while (j < hits.length && hits[j].p === x.p) j++;
      const seg = h.slice(x.i, j < hits.length ? hits[j].i : x.i + 4000);
      const titles = [...seg.matchAll(new RegExp('href=["\'][^"\']*' + esc(x.p) + '/?["\'][^>]*>([\\s\\S]*?)</a>', 'gi'))].map(y => strip(y[1])).filter(Boolean).sort((a, b) => b.length - a.length);
      const text = strip(seg), title = (titles.find(t => /\bn\.?\s*\d/i.test(t)) || titles[0] || text.slice(0, 120)).slice(0, 160);
      const nm = title.match(/\bn\.?\s*(\d{1,4})\b/i) || x.p.match(/-(\d{1,4})$/);
      put('star', { url: R + x.p, title, number: nm ? +nm[1] : null, date: anyDate(text) || d });
    }
    if (d < today) done.add(d); fetched++; await sleep(PAUSE);
  }
  state.starWeeks = [...done].sort();
  const todo = [...items.values()].filter(x => x.pub === 'star' && stale(x)).sort(first('date'));
  const det = await pool(todo, DETAILS, async x => {
    const h = await get(x.url.replace(R, B));
    if (h) { const t = strip(h); x.isbn = isbnIn(t) || x.isbn || ''; x.cover = ogImage(h, R) || x.cover || ''; x.pages = pagesIn(t) || x.pages || 0; }
    x.detailAt = today;
  });
  const left = [...items.values()].filter(x => x.pub === 'star' && !x.cover).length;
  if (!fetched && failed) throw Error('starcomics.com non raggiungibile' + why(B));
  return `${fetched} settimane lette, ${det} schede${robo(B)}` + (left ? `, ${left} ancora senza copertina` : ', tutte con copertina');
}

// ---------- PANINI: mappe del sito (manga + quelle dei fumetti dichiarate in robots.txt) + pagina prodotto ----------
async function panini(src) {
  const B = baseOf(src), R = src.site;
  const maps = new Set((process.env.PANINI_MAPS || 'manga-sitemap.xml').split(',').map(f => `/media/shp_ita_it/${f.trim()}`));
  const rob = await get(`${B}/robots.txt`);
  for (const m of String(rob || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
    const p = m[1].replace(/^https?:\/\/[^/]+/, '');
    if (/shp_ita_it/.test(p) && /(?:manga|comics?|fumetti|marvel|dc|disney)[-_]?sitemap/i.test(p)) maps.add(p);
  }
  let n = 0, read = 0;
  for (const mp of maps) {
    const sm = await get(B + mp); if (!sm) continue; read++;
    for (const b of sm.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const m = [, (b[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1], (b[1].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1]], img = (b[1].match(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/) || [])[1];
      if (!m[1]) continue;
      const url = m[1].trim().replace(/^https?:\/\/[^/]+/, R), slug = (url.match(/\/shp_ita_it\/([a-z0-9-]+)\.html$/) || [])[1]; if (!slug) continue;
      const parts = slug.split('-'); if (parts.length < 4 || !/^it\d+$/.test(parts.at(-1))) continue;
      const num = /^\d{1,4}$/.test(parts.at(-3)) ? +parts.at(-3) : null; if (num == null) continue;
      const o = items.get(url) || {};
      put('panini', { url, title: o.title || parts.slice(0, -3).join(' ') + ' ' + num, slugTitle: parts.slice(0, -3).join(' '), number: num, lastmod: (m[2] || '').slice(0, 10), code: parts.at(-2), ...(img && !o.cover ? { cover: ent(img).replace(/^https?:\/\/[^/]+/, R) } : {}) });
      n++;
    }
    await sleep(PAUSE);
  }
  if (!read) throw Error('mappa del sito Panini non raggiungibile' + why(B));
  const todo = [...items.values()].filter(x => x.pub === 'panini' && stale(x)).sort(first('lastmod'));
  const det = await pool(todo, DETAILS, async x => {
    const h = await get(x.url.replace(R, B));
    if (h) {
      const t = strip(h), lab = t.match(/(?:data di uscita|in uscita il|uscita)\D{0,25}(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s+[a-z]+\s+\d{4}|20\d{2}-\d{2}-\d{2})/i);
      const og = meta(h, 'og:title'), h1 = (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
      x.title = strip(og || h1 || '').replace(/\s*-\s*Panini Comics\s*$/i, '') || x.title;
      x.date = (lab ? anyDate(lab[1]) : '') || x.date || '';
      x.isbn = isbnIn(t) || x.isbn || ''; x.cover = ogImage(h, R) || x.cover || ''; x.pages = pagesIn(t) || x.pages || 0;
      x.imprint = /planet manga/i.test(t) ? 'Planet Manga' : (x.imprint || '');
    }
    x.detailAt = today;
  });
  // copertina dal codice prodotto: /media/catalog/product/M/P/MPLSH123_0.jpg (controllo che l'immagine esista, senza scaricarla)
  const nocov = [...items.values()].filter(x => x.pub === 'panini' && !x.cover && (x.code || (x.url.match(/-([a-z0-9]+)-it\d+\.html$/) || [])[1]) && (!x.imgAt || age(x.imgAt) > 14)).sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));
  let found = 0;
  const img = await pool(nocov, +(process.env.PANINI_IMG || 2500), async x => {
    const c = x.code || x.url.match(/-([a-z0-9]+)-it\d+\.html$/)[1], U = c.toUpperCase(), l = c.toLowerCase();
    for (const f of [`${U[0]}/${U[1]}/${U}_0.jpg`, `${l[0]}/${l[1]}/${l}_0.jpg`, `${U[0]}/${U[1]}/${U}_0_1.jpg`, `${l[0]}/${l[1]}/${l}_0_1.jpg`, `${l[0]}/${l[1]}/${l}_0_2.jpg`, `${U[0]}/${U[1]}/${U}_0_2.jpg`]) {
      const u = `/media/catalog/product/${f}`, r = await get(B + u, false, 'HEAD');
      if (r === 'ok') { x.cover = R + u; found++; break; }
      if (r === 'no-head') break;
    }
    x.imgAt = today;
  });
  const miss = [...items.values()].filter(x => x.pub === 'panini' && !x.cover).length;
  return `${n} volumi in ${read} ${read == 1 ? 'mappa' : 'mappe'}, ${det} schede lette${robo(B)}, ${found} copertine trovate dal codice (${img} provate), ${miss} ancora senza copertina`;
}

// ---------- SHOPIFY (J-POP, Edizioni BD, Goen, Musubi, Hollow Press…): /products.json ----------
async function shopify(src) {
  const B = baseOf(src), R = src.site, pre = new Set(); let n = 0;
  for (const c of src.pre || ['in-preordine', 'preordine', 'preordini', 'pre-order', 'preorder', 'prossime-uscite']) {
    for (let p = 1; p <= 10; p++) {
      const j = await get(`${B}/collections/${c}/products.json?limit=250&page=${p}`, true);
      if (!j || !j.products || !j.products.length) break; j.products.forEach(x => pre.add(x.handle)); await sleep(PAUSE);
    }
  }
  for (let p = 1; p <= (src.maxPages || 80) && !late(); p++) {
    const j = await get(`${B}/products.json?limit=250&page=${p}`, true);
    if (!j || !j.products) { if (p === 1) throw Error('catalogo non raggiungibile' + why(B)); break; }
    if (!j.products.length) break;
    for (const x of j.products) {
      // le parentesi senza numeri ("(BOX VOL. 1-3)", "(Regular)") non contano per il numero del volume
      const title = strip(x.title), v = volOf(title.replace(/\((?![\d\s]*(?:di\s*\d+\s*)?\))[^)]*\)/gi, ' ')); if (!v) continue;
      const tags = (Array.isArray(x.tags) ? x.tags : String(x.tags || '').split(',')).map(s => String(s).trim());
      const serie = tags.find(s => /^serie:/i.test(s));
      const vars = x.variants || [], body = String(x.body_html || ''), txt = strip(body);
      const asin = (body.match(/data-csa-c-asin=\\?["'](\d{9}[\dX])/) || [])[1];
      const isbn = vars.map(y => cleanIsbn(y.barcode) || cleanIsbn(y.sku)).find(Boolean) || (asin ? to13(asin) : '') || isbnIn(txt);
      const date = labDate(txt), ann = !date && (pre.has(x.handle) || tags.some(t => PRE.test(t)) || PRE.test(title));
      put(src.k, { url: `${R}/products/${x.handle}`, title, serie: serie ? serie.slice(6).trim() : v.serie, number: v.number, ann: ann ? 1 : 0,
        date: date || (ann ? '' : String(x.published_at || x.created_at || '').slice(0, 10)), isbn, cover: big((x.images && x.images[0] && x.images[0].src) || ''), pages: pagesIn(txt), detailAt: today });
      n++;
    }
    await sleep(PAUSE);
  }
  return `${n} volumi a catalogo` + (pre.size ? `, ${pre.size} in preordine` : '');
}

// ---------- WOOCOMMERCE: Store API pubblica (/wc/store/v1/products); se è chiusa, pagine del negozio ----------
async function woo(src) {
  const B = baseOf(src), R = src.site; let n = 0, api = 0;
  for (const root of ['/?rest_route=/wc/store/v1/products&', '/wp-json/wc/store/v1/products?']) {
    for (let p = 1; p <= (src.maxPages || 100) && !late(); p++) {
      const j = await get(`${B}${root}per_page=100&page=${p}&orderby=date&order=desc`, true);
      if (!Array.isArray(j)) break; api = 1; if (!j.length) break;
      for (const x of j) {
        const cats = [...(x.categories || []), ...(x.tags || [])].map(c => strip(c.name) + ' ' + c.slug).join(' ');
        if (src.cat && !src.cat.test(cats)) continue;
        const title = strip(x.name), v = volOf(title); if (!v) continue;
        const attrs = (x.attributes || []).map(a => a.name + ': ' + (a.terms || []).map(t => t.name).join(', ')).join(' · ');
        const txt = strip(attrs + ' · ' + (x.short_description || '') + ' · ' + (x.description || ''));
        const date = labDate(txt), st = [x.add_to_cart && x.add_to_cart.text, x.stock_availability && x.stock_availability.text, cats].join(' ');
        put(src.k, { url: String(x.permalink || '').replace(B, R), title, serie: v.serie, number: v.number, isbn: cleanIsbn(x.sku) || isbnIn(txt),
          cover: (x.images && x.images[0] && x.images[0].src) || '', date, ann: !date && (PRE.test(st) || PRE.test(title)) ? 1 : 0, pages: pagesIn(txt), nd: 1, detailAt: today });
        n++;
      }
      if (j.length < 100) break; await sleep(PAUSE);
    }
    if (api) break;
  }
  if (api) return `${n} volumi a catalogo`;
  return html(src);
}

// ---------- PAGINE DEL NEGOZIO: elenco prodotti pagina per pagina + scheda dei volumi nuovi ----------
function listProducts(h, src, B) {
  const re = /href=["']([^"'#]+)["']/gi, hits = [], org = new URL(B).origin; let m;
  while ((m = re.exec(h))) {
    let u; try { u = new URL(ent(m[1]), B + '/'); } catch (e) { continue; }
    if (u.origin !== org || !src.prod.test(u.pathname)) continue;
    hits.push({ u: u.origin + u.pathname, i: m.index });
  }
  const out = [], seen = new Set();
  for (let k = 0; k < hits.length; k++) {
    const x = hits[k]; if (seen.has(x.u)) continue; seen.add(x.u);
    let j = k + 1; while (j < hits.length && hits[j].u === x.u) j++;
    const seg = h.slice(h.lastIndexOf('<', x.i), j < hits.length ? hits[j].i : x.i + 2500);
    // titolo: prima i titoletti (h2/h3), poi il testo dei link, poi alt/title dell'immagine; senza prezzi e pulsanti
    const clean = t => strip(t).replace(/\s*(?:€\s*)?\d+[.,]\d{2}\s*€?.*$/, '').trim(), bad = t => !t || /^(?:aggiungi|leggi|acquista|scopri|dettagli|add to cart|compra|preordina|esaurito|novit)/i.test(t);
    const groups = [[...seg.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)], [...seg.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)], [...seg.matchAll(/\b(?:alt|title)=["']([^"']{3,})["']/gi)]]
      .map(g => g.map(y => clean(y[1])).filter(t => !bad(t)));
    const title = (groups.map(g => g.find(t => volOf(t))).find(Boolean) || groups.map(g => g[0]).find(Boolean) || '').slice(0, 200);
    const img = (seg.match(/<img\b[^>]*?\b(?:data-src|data-lazy-src|data-original|src)=["']([^"']+)["']/i) || [])[1];
    out.push({ url: x.u, title, cover: img && !/^data:/.test(img) ? big(new URL(ent(img), B + '/').href) : '', text: strip(seg).slice(0, 600) });
  }
  return out;
}
// "lumberjanes---volume-2" → "lumberjanes volume 2" (PrestaShop: tolgo id iniziale e ISBN finale)
const slugTitle = u => { const seg = decodeURIComponent(new URL(u).pathname.replace(/\/$/, '').split('/').pop()).replace(/\.html?$/, '').replace(/^\d+-/, '').replace(/-?97[89]\d{10}$/, ''); return seg.replace(/[-_]+/g, ' ').trim(); };
const slugVol = u => { const m = new URL(u).pathname.match(/(?:^|[-/])vol(?:ume)?-*0*(\d{1,4})(?=[-/.]|$)/i); return m ? +m[1] : null; };
// mappe del sito (Yoast, Rank Math, WordPress): tutti i prodotti, anche quelli che il negozio non mostra a pagine
async function productMaps(src, B, R) {
  const queue = ['/product-sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml'], done = new Set(); let read = 0, n = 0;
  const rob = await get(`${B}/robots.txt`);
  for (const m of String(rob || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.unshift(m[1].replace(/^https?:\/\/[^/]+/, ''));
  while (queue.length && done.size < 40 && !late()) {
    const p = queue.shift(); if (done.has(p)) continue; done.add(p);
    const x = await get(B + p); if (!x || !/<(?:urlset|sitemapindex)\b/i.test(x)) continue; read++;
    if (/<sitemapindex\b/i.test(x)) { for (const m of x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) { const q = ent(m[1]).replace(/^https?:\/\/[^/]+/, ''); if (/product|prodott/i.test(q)) queue.push(q); } continue; }
    for (const b of x.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      const loc = (b[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/) || [])[1]; if (!loc) continue;
      let u; try { u = new URL(ent(loc)); } catch (e) { continue; }
      if (!src.prod.test(u.pathname)) continue;
      const url = R + u.pathname, lastmod = ((b[1].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || '').slice(0, 10), o = items.get(url);
      if (o) { if (lastmod) o.lastmod = lastmod; continue; }
      const t = slugTitle(url), v = volOf(t) || (slugVol(url) ? { serie: t.replace(/\s*vol(?:ume)?\s*\d+.*$/i, ''), number: slugVol(url) } : null);
      put(src.k, { url, title: t, serie: v ? v.serie : '', number: v ? v.number : null, st: 1, lastmod, nd: 1, cover: '', isbn: isbnIn(url) }); n++;
    }
    await sleep(PAUSE);
  }
  return { read, n };
}
async function html(src) {
  const B = baseOf(src), R = src.site; let n = 0, pages = 0;
  for (const L of [...src.list.map(u => ({ u })), ...(src.preList || []).map(u => ({ u, ann: 1 }))]) {
    const seen = new Set();
    for (let p = 1; p <= (L.u.includes('{n}') ? (src.maxPages || 80) : 1) && !late(); p++) {
      const h = await get(B + L.u.replace('{n}', p)); if (!h) break; pages++;
      let fresh = 0;
      for (const f of listProducts(h, src, B)) {
        if (seen.has(f.url)) continue; seen.add(f.url); fresh++;
        const sv = slugVol(f.url), v = volOf(f.title) || (sv && f.title ? { serie: f.title, number: sv } : null); if (!v) continue;
        const url = f.url.replace(B, R), o = items.get(url) || {}, date = labDate(f.text);
        put(src.k, { url, title: f.title + (volOf(f.title) ? '' : ' Vol. ' + sv), serie: v.serie, number: v.number, st: 0, nonum: 0, cover: f.cover || o.cover || '', isbn: isbnIn(f.url) || isbnIn(f.text) || o.isbn || '',
          date: date || o.date || '', ann: L.ann || (!date && !o.date && PRE.test(f.text)) ? 1 : 0, nd: 1 });
        n++;
      }
      if (!fresh) break; await sleep(PAUSE);
    }
  }
  const mp = src.type === 'woo' || src.maps ? await productMaps(src, B, R) : { read: 0, n: 0 };
  if (!pages && !mp.read) throw Error('negozio non raggiungibile' + why(B));
  const todo = [...items.values()].filter(x => x.pub === src.k && stale(x))
    .sort((a, b) => (!!a.detailAt - !!b.detailAt) || ((b.number != null) - (a.number != null)) || (b.lastmod || b.seen || '').localeCompare(a.lastmod || a.seen || ''));
  const det = await pool(todo, SMALL_DETAILS, async x => {
    const h = await get(x.url.replace(R, B));
    if (h) {
      const t = strip(h);
      if (x.st) { // titolo vero al posto di quello ricavato dall'indirizzo
        const tt = strip(meta(h, 'og:title') || (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '').replace(/\s+[-–|]\s+[^-–|]*$/, '').trim();
        const v = tt && (volOf(tt) || (slugVol(x.url) ? { serie: tt, number: slugVol(x.url) } : null));
        if (tt) { x.title = tt; x.serie = v ? v.serie : ''; x.number = v ? v.number : null; x.nonum = v ? 0 : 1; x.st = 0; }
      }
      x.isbn = x.isbn || isbnIn(t); x.cover = x.cover || ogImage(h, R); x.pages = x.pages || pagesIn(t); x.date = labDate(t) || x.date || ''; if (x.date) x.ann = 0;
    }
    if (x.number == null) x.nonum = 1;
    x.detailAt = today;
  });
  const tot = [...items.values()].filter(x => x.pub === src.k && x.number != null).length;
  return `${tot} volumi a catalogo (${pages} pagine del negozio${mp.read ? `, ${mp.n} nuovi dalla mappa del sito` : ''}), ${det} schede lette${robo(B)}`;
}

// ---------- via: tutti gli editori in parallelo (ognuno con le sue pause, siti diversi) ----------
await Promise.all(SRC.filter(s => ONLY.includes(s.k)).map(async s => {
  const prev = stats[s.k] || {};
  try { const msg = await (s.run || { shopify, woo, html }[s.type])(s); stats[s.k] = { ok: true, msg, at: new Date().toISOString() }; stats[s.k].lastOk = stats[s.k].at; console.log(`${s.name}: ${msg}`); }
  catch (e) { stats[s.k] = { ok: false, msg: e.message, at: new Date().toISOString(), lastOk: prev.lastOk }; console.log(`${s.name}: ERRORE ${e.message}`); }
}));

fs.mkdirSync(DIR, { recursive: true });
const pubs = {}; let tot = 0;
for (const s of SRC) {
  const list = [...items.values()].filter(x => x.pub === s.k && x.number != null).sort((a, b) => (b.date || b.seen || '').localeCompare(a.date || a.seen || ''))
    .map(({ pub, ...x }) => x);
  const checked = [...items.values()].filter(x => x.pub === s.k && x.number == null && x.detailAt).map(x => [x.url, x.detailAt]);
  if (!list.length) { if (stats[s.k]) stats[s.k].count = 0; if (checked.length) fs.writeFileSync(`${DIR}/${s.k}.json`, JSON.stringify({ pub: s.k, name: s.name, items: [], checked }) + '\n'); continue; }
  const pf = {}; for (const x of list) if (x.isbn) pf[x.isbn.slice(0, 8)] = (pf[x.isbn.slice(0, 8)] || 0) + 1;
  fs.writeFileSync(`${DIR}/${s.k}.json`, JSON.stringify({ pub: s.k, name: s.name, updated: new Date().toISOString(), items: list, checked }) + '\n');
  pubs[s.k] = { name: s.name, site: s.site, file: `${DIR}/${s.k}.json`, count: list.length, pfx: Object.entries(pf).sort((a, b) => b[1] - a[1]).slice(0, 40).map(e => e[0]) };
  if (stats[s.k]) stats[s.k].count = list.length;
  tot += list.length;
}
fs.writeFileSync(OUT, JSON.stringify({ version: 2, updated: new Date().toISOString(), stats, state, pubs }) + '\n');
console.log(`Totale voci: ${tot} (${Object.keys(pubs).length} editori con volumi)`);
if (Object.values(stats).every(s => !s.ok)) process.exit(1);
