// Fumetteca – raccoglie ogni giorno le uscite dai siti ufficiali degli editori e scrive uscite.json
// (letto da index.html: è sullo stesso sito GitHub Pages, quindi il browser non lo blocca).
// Editori: Star Comics, Panini (Planet Manga), J-POP. Nessuna libreria esterna (Node 18+).
import fs from 'node:fs';
const OUT = process.env.OUT || 'uscite.json';
const T = { star: process.env.STAR_BASE || 'https://www.starcomics.com', panini: process.env.PANINI_BASE || 'https://www.panini.it', jpop: process.env.JPOP_BASE || 'https://j-pop.it' };
const REAL = { star: 'https://www.starcomics.com', panini: 'https://www.panini.it', jpop: 'https://j-pop.it' };
const ONLY = (process.env.ONLY || 'star,panini,jpop').split(',');
const PAUSE = +(process.env.PAUSE ?? 400), STAR_WEEKS_BACK = +(process.env.STAR_WEEKS_BACK || 520), DETAILS = +(process.env.DETAILS || 200);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEAD = { 'user-agent': 'Mozilla/5.0 (compatible; Fumetteca personal release checker; +https://github.com)', 'accept-language': 'it-IT,it;q=0.9' };
async function get(u, json) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(u, { headers: HEAD }); if (r.ok) return json ? await r.json() : await r.text(); if (r.status === 404) return null; } catch (e) {}
    await sleep(1500 * (t + 1));
  }
  return null;
}
const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const MESI = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };
const p2 = x => String(x).padStart(2, '0');
function anyDate(t) {
  let m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/); if (m) return `${m[3]}-${p2(m[2])}-${p2(m[1])}`;
  m = t.match(/\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})\b/i); if (m) return `${m[3]}-${p2(MESI[m[2].toLowerCase()])}-${p2(m[1])}`;
  m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/); return m ? m[0] : '';
}
const ok13 = i => { if (!/^97[89]\d{10}$/.test(i)) return false; let t = 0; for (let k = 0; k < 12; k++) t += +i[k] * (k % 2 ? 3 : 1); return (10 - t % 10) % 10 === +i[12]; };
const to13 = a => { const s = '978' + a.slice(0, 9); let t = 0; for (let k = 0; k < 12; k++) t += +s[k] * (k % 2 ? 3 : 1); return s + (10 - t % 10) % 10; };
const isbnIn = t => (String(t).match(/97[89][\d-]{10,16}/g) || []).map(x => x.replace(/-/g, '')).find(ok13) || '';
const meta = (html, prop) => { const m = html.match(new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]*content=(["\'])(.*?)\\1', 'i')) || html.match(new RegExp('<meta[^>]+content=(["\'])(.*?)\\1[^>]*property=["\']' + prop + '["\']', 'i')); return m ? m[2] : ''; };
const ogImage = (html, base) => { const u = meta(html, 'og:image'); return u ? new URL(u.replace(/&amp;/g, '&'), base).href : ''; };
const pagesIn = t => +((t.match(/pagine\D{0,3}(\d{2,4})\b/i) || t.match(/\b(\d{2,4})\s*pagine/i) || [])[1] || 0);
const numIn = t => { const m = t.match(/\b(?:n\.?|vol\.?|volume|#)\s*(\d{1,4})\b/i) || t.match(/[\s-](\d{1,4})\s*$/); return m ? +m[1] : null; };
const esc = s => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const old = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const items = new Map((old.items || []).map(x => [x.url, x]));
const stats = old.stats || {}, state = old.state || {};
const now = new Date(), today = now.toISOString().slice(0, 10);
const put = (pub, e) => { const o = items.get(e.url) || {}; items.set(e.url, { ...o, ...e, pub }); };
const stale = x => !x.detailAt || ((!x.isbn || !x.date || x.date > today) && (Date.parse(today) - Date.parse(x.detailAt)) > 6 * 864e5);

// ---------- STAR COMICS: pagine settimanali /uscite/AAAA-MM-GG + scheda del volume ----------
async function star() {
  const done = new Set(state.starWeeks || []); let fetched = 0, failed = 0;
  const d0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()), lastTue = d0 - ((new Date(d0).getUTCDay() + 5) % 7) * 864e5;
  for (let w = -STAR_WEEKS_BACK; w <= 12; w++) {
    const d = new Date(lastTue + w * 7 * 864e5).toISOString().slice(0, 10);
    if (done.has(d) && w < -6) continue;
    const h = await get(`${T.star}/uscite/${d}`); if (h == null) { failed++; continue; }
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
      put('star', { url: REAL.star + x.p, title, number: nm ? +nm[1] : null, date: anyDate(text) || d });
    }
    if (d < today) done.add(d); fetched++; await sleep(PAUSE);
  }
  state.starWeeks = [...done].sort();
  let det = 0;
  for (const x of [...items.values()].filter(x => x.pub === 'star' && stale(x)).sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
    if (det >= DETAILS) break; const h = await get(x.url.replace(REAL.star, T.star)); det++;
    if (h) { const t = strip(h); x.isbn = isbnIn(t) || x.isbn || ''; x.cover = ogImage(h, REAL.star) || x.cover || ''; x.pages = pagesIn(t) || x.pages || 0; }
    x.detailAt = today; await sleep(PAUSE);
  }
  if (!fetched && failed) throw Error('starcomics.com non raggiungibile');
  return `${fetched} settimane lette, ${det} schede`;
}

// ---------- PANINI (Planet Manga): mappa del sito dei manga + pagina prodotto ----------
async function panini() {
  const sm = await get(`${T.panini}/media/shp_ita_it/manga-sitemap.xml`);
  if (!sm) throw Error('mappa del sito Panini non raggiungibile');
  let n = 0;
  for (const m of sm.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?/g)) {
    const url = m[1].trim().replace(T.panini, REAL.panini), slug = (url.match(/\/shp_ita_it\/([a-z0-9-]+)\.html$/) || [])[1]; if (!slug) continue;
    const parts = slug.split('-'); if (parts.length < 4 || !/^it\d+$/.test(parts.at(-1))) continue;
    const num = /^\d{1,4}$/.test(parts.at(-3)) ? +parts.at(-3) : null; if (num == null) continue;
    const o = items.get(url) || {};
    put('panini', { url, title: o.title || parts.slice(0, -3).join(' ') + ' ' + num, slugTitle: parts.slice(0, -3).join(' '), number: num, lastmod: (m[2] || '').slice(0, 10) });
    n++;
  }
  let det = 0;
  for (const x of [...items.values()].filter(x => x.pub === 'panini' && stale(x)).sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''))) {
    if (det >= DETAILS) break; const h = await get(x.url.replace(REAL.panini, T.panini)); det++;
    if (h) {
      const t = strip(h), lab = t.match(/(?:data di uscita|in uscita il|uscita)\D{0,25}(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\s+[a-z]+\s+\d{4}|20\d{2}-\d{2}-\d{2})/i);
      const og = meta(h, 'og:title'), h1 = (h.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
      x.title = strip(og || h1 || '') .replace(/\s*-\s*Panini Comics\s*$/i, '') || x.title;
      x.date = (lab ? anyDate(lab[1]) : '') || x.date || '';
      x.isbn = isbnIn(t) || x.isbn || ''; x.cover = ogImage(h, REAL.panini) || x.cover || ''; x.pages = pagesIn(t) || x.pages || 0;
      x.imprint = /planet manga/i.test(t) ? 'Planet Manga' : (x.imprint || '');
    }
    x.detailAt = today; await sleep(PAUSE);
  }
  return `${n} volumi nella mappa, ${det} schede lette`;
}

// ---------- J-POP (negozio Shopify): catalogo /products.json + preordini ----------
async function jpop() {
  const pre = new Set(); let n = 0;
  for (let p = 1; p <= 10; p++) {
    const j = await get(`${T.jpop}/collections/in-preordine/products.json?limit=250&page=${p}`, true);
    if (!j || !j.products || !j.products.length) break; j.products.forEach(x => pre.add(x.handle)); await sleep(PAUSE);
  }
  for (let p = 1; p <= 60; p++) {
    const j = await get(`${T.jpop}/products.json?limit=250&page=${p}`, true);
    if (!j || !j.products) { if (p === 1) throw Error('catalogo J-POP non raggiungibile'); break; }
    if (!j.products.length) break;
    for (const x of j.products) {
      const title = String(x.title || '').trim(), num = numIn(title.replace(/\(.*?\)/g, ' ')); if (num == null) continue;
      const tags = x.tags || [], serie = (Array.isArray(tags) ? tags : String(tags).split(',')).map(s => String(s).trim()).find(s => /^serie:/i.test(s));
      const asin = (String(x.body_html || '').match(/data-csa-c-asin=\\?["'](\d{9}[\dX])/) || [])[1];
      const ann = pre.has(x.handle) || (Array.isArray(tags) && tags.includes('preordine'));
      put('jpop', { url: `${REAL.jpop}/products/${x.handle}`, title, number: num, serie: serie ? serie.slice(6).trim() : '', ann: ann ? 1 : 0,
        date: ann ? '' : String(x.published_at || x.created_at || '').slice(0, 10), isbn: asin ? to13(asin) : '', cover: (x.images && x.images[0] && x.images[0].src) || '', detailAt: today });
      n++;
    }
    await sleep(PAUSE);
  }
  return `${n} volumi a catalogo, ${pre.size} in preordine`;
}

for (const [k, f] of [['star', star], ['panini', panini], ['jpop', jpop]]) {
  if (!ONLY.includes(k)) continue;
  try { const msg = await f(); stats[k] = { ok: true, msg, at: new Date().toISOString() }; console.log(k + ': ' + msg); }
  catch (e) { stats[k] = { ok: false, msg: e.message, at: new Date().toISOString() }; console.log(k + ': ERRORE ' + e.message); }
}
const list = [...items.values()].filter(x => x.number != null).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), stats, state, items: list }) + '\n');
console.log(`Totale voci: ${list.length}`);
if (Object.values(stats).every(s => !s.ok)) process.exit(1);
