'use strict';
// API clients for qBittorrent, Prowlarr, AudioBookShelf, and Audible (metadata),
// plus LAN auto-discovery of services.

const DEFAULT_TIMEOUT = 12000;

async function jfetch(url, opts = {}, timeout = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Connection timed out — is the URL reachable from the Librarian container?');
    throw new Error('Could not connect (' + (e.cause?.code || e.message) + ')');
  } finally {
    clearTimeout(t);
  }
}

const clean = u => (u || '').trim().replace(/\/+$/, '');

/* ---------------- qBittorrent ---------------- */

const qbitSids = new Map(); // url -> full session cookie ("SID=..." or "QBT_SID_xxx=...")

async function qbitLogin(cfg) {
  const res = await jfetch(clean(cfg.url) + '/api/v2/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: cfg.username || '', password: cfg.password || '' })
  });
  const text = (await res.text()).trim();
  if (res.status === 403 || /banned/i.test(text)) {
    throw new Error('qBittorrent has temporarily banned this IP after too many failed logins (default ban is 1 hour). Restart the qBittorrent container to clear the ban, then test again. In qBittorrent: Options → Web UI → "Ban client after consecutive failures" controls this.');
  }
  if (res.status === 401 || /unauthorized/i.test(text)) {
    throw new Error('qBittorrent refused the request before checking the password (HTTP 401). This is usually "Enable Host header validation" in qBittorrent Options → Web UI → Security — untick it (or add this server\'s IP to the whitelist), save, and test again.');
  }
  if (text === 'Fails.') {
    throw new Error('qBittorrent says the username or password is wrong ("Fails."). Watch for a trailing space when pasting, and note the WebUI password may differ from what you expect — reset it in qBittorrent Options → Web UI → Authentication if unsure.');
  }
  // Success: legacy API answers 200 "Ok."; qBittorrent 5.x answers 204 with an empty body.
  if (!(res.status === 204 || (res.ok && (text === 'Ok.' || text === '')))) {
    throw new Error('qBittorrent login failed (HTTP ' + res.status + '): ' + (text ? text.slice(0, 200) : 'empty response'));
  }
  // Session cookie: "SID" on older builds, "QBT_SID_<port>" on newer ones.
  const cookie = res.headers.get('set-cookie') || '';
  const m = cookie.match(/(QBT_SID[^=\s;,]*|SID)=([^;]+)/);
  if (!m) throw new Error('qBittorrent accepted the login but did not return a session cookie — check "CSRF protection" settings in qBittorrent Options → Web UI → Security.');
  const session = m[1] + '=' + m[2];
  qbitSids.set(cfg.url, session);
  return session;
}

async function qbitReq(cfg, apiPath, opts = {}, retry = true) {
  let sid = qbitSids.get(cfg.url);
  if (!sid) sid = await qbitLogin(cfg);
  const res = await jfetch(clean(cfg.url) + apiPath, {
    ...opts,
    headers: { ...(opts.headers || {}), Cookie: sid }
  });
  if (res.status === 403 && retry) {
    qbitSids.delete(cfg.url);
    return qbitReq(cfg, apiPath, opts, false);
  }
  return res;
}

async function qbitTest(cfg) {
  await qbitLogin(cfg);
  const res = await qbitReq(cfg, '/api/v2/app/version');
  const v = res.ok ? (await res.text()).trim() : '';
  return { ok: true, detail: 'Connected — qBittorrent ' + v };
}

async function qbitEnsureCategory(cfg) {
  try {
    await qbitReq(cfg, '/api/v2/torrents/createCategory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ category: cfg.category || 'librarian', savePath: '' })
    });
  } catch { /* category may already exist — fine */ }
}

// Fetch a .torrent from the indexer ourselves (following redirects, which may land on a
// magnet link) so qBittorrent never has to reach the indexer — the reliable *arr approach.
async function fetchTorrent(url) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    if (cur.startsWith('magnet:')) return { magnet: cur };
    const res = await jfetch(cur, { redirect: 'manual', headers: { 'User-Agent': 'Librarian/1.0' } }, 30000);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('The indexer redirected with no destination');
      cur = loc.startsWith('magnet:') ? loc : new URL(loc, cur).href;
      continue;
    }
    if (!res.ok) throw new Error('Couldn\'t download the torrent from the indexer (HTTP ' + res.status + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf[0] !== 0x64) { // bencoded torrents start with 'd'
      throw new Error('The indexer returned something that isn\'t a torrent file (an error page or login wall, most likely)');
    }
    return { file: buf };
  }
  throw new Error('Too many redirects while fetching the torrent from the indexer');
}

async function qbitAdd(cfg, { url, tag }) {
  const payload = url.startsWith('magnet:') ? { magnet: url } : await fetchTorrent(url);
  let res;
  if (payload.magnet) {
    res = await qbitReq(cfg, '/api/v2/torrents/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ urls: payload.magnet, category: cfg.category || 'librarian', tags: tag })
    });
  } else {
    const fd = new FormData();
    fd.append('torrents', new Blob([payload.file], { type: 'application/x-bittorrent' }), 'librarian.torrent');
    fd.append('category', cfg.category || 'librarian');
    fd.append('tags', tag);
    res = await qbitReq(cfg, '/api/v2/torrents/add', { method: 'POST', body: fd });
  }
  const text = (await res.text()).trim();
  if (!res.ok || text === 'Fails.') throw new Error('qBittorrent rejected the torrent' + (text && text !== 'Ok.' ? ': ' + text.slice(0, 200) : ''));
}

// After adding, confirm the torrent actually shows up in qBittorrent's list.
async function qbitWaitForTag(cfg, tag, tries = 5, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    let list;
    try { list = await qbitList(cfg); } catch { continue; }
    const t = list.find(t => (t.tags || '').split(',').map(x => x.trim()).includes(tag));
    if (t) return t;
  }
  return null;
}

async function qbitList(cfg) {
  const res = await qbitReq(cfg, '/api/v2/torrents/info?category=' + encodeURIComponent(cfg.category || 'librarian'));
  if (!res.ok) throw new Error('qBittorrent list failed (' + res.status + ')');
  return res.json();
}

async function qbitDelete(cfg, hash, deleteFiles) {
  await qbitReq(cfg, '/api/v2/torrents/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ hashes: hash, deleteFiles: String(!!deleteFiles) })
  });
}

/* ---------------- Prowlarr ---------------- */

async function prowlarrTest(cfg) {
  const res = await jfetch(clean(cfg.url) + '/api/v1/indexer', { headers: { 'X-Api-Key': cfg.apiKey || '' } });
  if (res.status === 401) throw new Error('Prowlarr rejected the API key');
  if (!res.ok) throw new Error('Prowlarr error (HTTP ' + res.status + ')');
  const indexers = await res.json();
  const enabled = indexers.filter(i => i.enable).length;
  if (!enabled) return { ok: true, detail: 'Connected, but no enabled indexers — add indexers in Prowlarr first' };
  return { ok: true, detail: `Connected — ${enabled} enabled indexer${enabled === 1 ? '' : 's'}` };
}

// mediaType 'audio' → audiobook categories (3030/3000); 'ebook' → book categories (7020/7000).
// Distinct categories mean an audiobook search never returns ebook releases and vice versa.
async function prowlarrSearch(cfg, query, mediaType = 'audio') {
  const cats = mediaType === 'ebook' ? '&categories=7020&categories=7000' : '&categories=3030&categories=3000';
  const url = clean(cfg.url) + '/api/v1/search?query=' + encodeURIComponent(query)
    + cats + '&type=search&limit=100';
  const res = await jfetch(url, { headers: { 'X-Api-Key': cfg.apiKey || '' } }, 60000);
  if (res.status === 401) throw new Error('Prowlarr rejected the API key');
  if (!res.ok) throw new Error('Prowlarr search failed (HTTP ' + res.status + ')');
  const items = await res.json();
  return (Array.isArray(items) ? items : [])
    .filter(r => (r.protocol || '').toLowerCase() === 'torrent')
    .map(r => ({
      guid: r.guid,
      title: r.title,
      size: r.size || 0,
      seeders: r.seeders ?? 0,
      leechers: r.leechers ?? 0,
      indexer: r.indexer || '',
      publishDate: r.publishDate || null,
      link: r.magnetUrl || r.downloadUrl || r.guid
    }))
    .filter(r => r.link)
    .sort((a, b) => b.seeders - a.seeders);
}

/* ---------------- AudioBookShelf ---------------- */

async function absReq(cfg, apiPath, opts = {}) {
  return jfetch(clean(cfg.url) + apiPath, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (cfg.apiKey || '') }
  });
}

async function absLibraries(cfg) {
  const res = await absReq(cfg, '/api/libraries');
  if (res.status === 401) throw new Error('AudioBookShelf rejected the API token');
  if (!res.ok) throw new Error('AudioBookShelf error (HTTP ' + res.status + ')');
  const j = await res.json();
  return (j.libraries || []).map(l => ({ id: l.id, name: l.name, mediaType: l.mediaType }));
}

async function absTest(cfg) {
  const libs = await absLibraries(cfg);
  const books = libs.filter(l => l.mediaType === 'book').length;
  return { ok: true, detail: `Connected — ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'} (${books} book type)` };
}

async function absScan(cfg, libraryId) {
  const res = await absReq(cfg, '/api/libraries/' + encodeURIComponent(libraryId) + '/scan', { method: 'POST' });
  if (!res.ok) throw new Error('AudioBookShelf library scan failed (HTTP ' + res.status + ')');
}

// Full list of titles/authors in the ABS library — used for "already in library" badges.
async function absLibraryItems(cfg, libraryId) {
  const res = await absReq(cfg, '/api/libraries/' + encodeURIComponent(libraryId) + '/items?limit=0');
  if (!res.ok) throw new Error('AudioBookShelf items fetch failed (HTTP ' + res.status + ')');
  const j = await res.json();
  return (j.results || [])
    .map(it => ({ title: it.media?.metadata?.title || '', author: it.media?.metadata?.authorName || '' }))
    .filter(x => x.title);
}

/* ---------------- notifications (ntfy / Discord webhook / Gotify) ---------------- */

async function notifySend(cfg, title, message) {
  const url = (cfg?.url || '').trim();
  if (!url) throw new Error('No notification URL configured');
  let res;
  if (url.includes('discord.com/api/webhooks')) {
    res = await jfetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '**' + title + '**\n' + message })
    }, 8000);
  } else if (url.includes('gotify')) {
    res = await jfetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, priority: 5 })
    }, 8000);
  } else {
    // ntfy-style: plain text body, Title header
    res = await jfetch(url, { method: 'POST', headers: { Title: title }, body: message }, 8000);
  }
  if (!res.ok) throw new Error('Notification endpoint answered HTTP ' + res.status);
}
const notify = (cfg, title, message) => notifySend(cfg, title, message).catch(() => { });

/* ---------------- release auto-pick scoring ---------------- */

function scoreRelease(r, mediaType = 'audio') {
  let s = 0;
  const t = r.title || '';
  if (mediaType === 'ebook') {
    if (/\bepub\b/i.test(t)) s += 3;      // Kindle-compatible and universal
    else if (/\bazw3?\b/i.test(t)) s += 1.5;
    else if (/\bmobi\b/i.test(t)) s += 1;
    else if (/\bpdf\b/i.test(t)) s += 0.5;
    const mb = (r.size || 0) / 1e6;
    if (mb >= 0.1 && mb <= 200) s += 1;   // sane ebook size
  } else {
    if (/\bm4b\b/i.test(t)) s += 3;       // chapterized single-file — ideal
    else if (/\bm4a\b/i.test(t)) s += 2;
    else if (/\bmp3\b/i.test(t)) s += 1;
    const gb = (r.size || 0) / 1e9;
    if (gb >= 0.05 && gb <= 4) s += 1;    // sane audiobook size
  }
  s += Math.min(r.seeders || 0, 20) / 10; // up to +2 for healthy swarms
  return s;
}

function pickBestRelease(list, mediaType = 'audio') {
  const seeded = (list || []).filter(r => (r.seeders || 0) > 0);
  if (!seeded.length) return null;
  return seeded.reduce((a, b) => (scoreRelease(b, mediaType) > scoreRelease(a, mediaType) ? b : a));
}

/* ---------------- Audible metadata ---------------- */

async function audibleCatalog(extra) {
  const url = 'https://api.audible.com/1.0/catalog/products?' + new URLSearchParams({
    num_results: '25',
    products_sort_by: 'Relevance',
    response_groups: 'media,contributors,series,rating,product_desc,product_attrs',
    image_sizes: '500',
    ...extra
  });
  const res = await jfetch(url, { headers: { 'User-Agent': 'Librarian/1.0' } }, 15000);
  if (!res.ok) throw new Error('Audible search failed (HTTP ' + res.status + ')');
  const j = await res.json();
  return (j.products || []).map(p => ({
    asin: p.asin,
    title: p.title,
    subtitle: p.subtitle || '',
    authors: (p.authors || []).map(a => a.name).filter(Boolean),
    narrators: (p.narrators || []).map(n => n.name).filter(Boolean),
    series: (p.series && p.series[0]) ? { title: p.series[0].title, sequence: p.series[0].sequence } : null,
    runtimeMin: p.runtime_length_min || 0,
    rating: p.rating?.overall_distribution?.display_average_rating || null,
    releaseDate: p.release_date || '',
    language: p.language || '',
    summary: String(p.publisher_summary || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    cover: p.product_images ? (p.product_images['500'] || Object.values(p.product_images)[0]) : null
  })).filter(b => b.title);
}

const audibleSearch = q => audibleCatalog({ keywords: q });

/* --- result ranking: reward title/author token matches so "Brother Ania Ahlborn"
       surfaces the right book instead of whatever Audible's keyword index coughs up --- */
const STOPWORDS = new Set(['by', 'the', 'a', 'an', 'of', 'and', 'book', 'audiobook']);
const tokenize = q => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t && !STOPWORDS.has(t));

function rankResults(q, lists) {
  const seen = new Map();
  for (const list of lists) for (const b of list) if (b.asin && !seen.has(b.asin)) seen.set(b.asin, b);
  const qt = tokenize(q);
  const score = b => {
    if (!qt.length) return 0;
    const hay = (b.title + ' ' + b.subtitle + ' ' + b.authors.join(' ') + ' ' + (b.series ? b.series.title : '')).toLowerCase();
    const authorHay = b.authors.join(' ').toLowerCase();
    let hits = 0, authorHits = 0;
    for (const t of qt) {
      if (hay.includes(t)) hits++;
      if (authorHay.includes(t)) authorHits++;
    }
    return hits / qt.length + authorHits * 0.3; // author matches weigh extra
  };
  return [...seen.values()]
    .map((b, i) => ({ b, i, s: score(b) }))
    .sort((x, y) => y.s - x.s || x.i - y.i)
    .map(x => x.b);
}

// Resolve an ISBN to "title author" via Google Books, so ISBN searches work
// even though Audible's catalog doesn't index print ISBNs.
async function isbnLookup(isbn) {
  const res = await jfetch('https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(isbn), {}, 12000);
  if (!res.ok) return null;
  const j = await res.json();
  const v = j.items?.[0]?.volumeInfo;
  if (!v || !v.title) return null;
  return [v.title, (v.authors || [])[0]].filter(Boolean).join(' ');
}

/* ---------------- eBook metadata: Google Books, OpenLibrary fallback ---------------- */

async function googleBooksQuery(q) {
  let query = q;
  const digits = q.replace(/[-\s]/g, '');
  const byAuthor = q.match(/^(.{2,}?)\s+by\s+(.{2,})$/i);
  if (/^(97[89])?\d{9}[\dXx]$/.test(digits)) query = 'isbn:' + digits;
  else if (byAuthor) query = `intitle:${byAuthor[1].trim()} inauthor:${byAuthor[2].trim()}`;
  const url = 'https://www.googleapis.com/books/v1/volumes?' + new URLSearchParams({
    q: query, maxResults: '25', printType: 'books'
  });
  const res = await jfetch(url, { headers: { 'User-Agent': 'Librarian/1.0' } }, 15000);
  if (!res.ok) {
    const e = new Error('Google Books search failed (HTTP ' + res.status + ')');
    e.rateLimited = res.status === 429 || res.status === 403;
    throw e;
  }
  const j = await res.json();
  return (j.items || []).map(i => {
    const v = i.volumeInfo || {};
    return {
      asin: i.id, // volume id — unique enough for dedupe
      mediaType: 'ebook',
      title: v.title || '',
      subtitle: v.subtitle || '',
      authors: v.authors || [],
      narrators: [],
      series: null,
      runtimeMin: 0,
      pages: v.pageCount || 0,
      rating: v.averageRating || null,
      releaseDate: v.publishedDate || '',
      language: v.language || '',
      summary: String(v.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      cover: (v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '').replace('http://', 'https://') || null
    };
  }).filter(b => b.title);
}

async function openLibraryQuery(q) {
  const url = 'https://openlibrary.org/search.json?' + new URLSearchParams({
    q, limit: '25', fields: 'key,title,subtitle,author_name,first_publish_year,cover_i,language,number_of_pages_median'
  });
  const res = await jfetch(url, { headers: { 'User-Agent': 'Librarian/1.0' } }, 15000);
  if (!res.ok) throw new Error('OpenLibrary search failed (HTTP ' + res.status + ')');
  const j = await res.json();
  return (j.docs || []).map(d => ({
    asin: d.key, // e.g. /works/OL123W
    mediaType: 'ebook',
    title: d.title || '',
    subtitle: d.subtitle || '',
    authors: d.author_name || [],
    narrators: [],
    series: null,
    runtimeMin: 0,
    pages: d.number_of_pages_median || 0,
    rating: null,
    releaseDate: d.first_publish_year ? String(d.first_publish_year) : '',
    language: (d.language || [])[0] || '',
    summary: '',
    cover: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : null
  })).filter(b => b.title);
}

// Cache identical ebook queries for 10 minutes — the live-search debounce can fire
// several requests per minute, and Google throttles anonymous callers per IP.
const ebookCache = new Map(); // q(lower) -> { at, results }
const EBOOK_CACHE_MS = 10 * 60 * 1000;

async function ebookSearch(q) {
  const key = q.toLowerCase().trim();
  const hit = ebookCache.get(key);
  if (hit && Date.now() - hit.at < EBOOK_CACHE_MS) return hit.results;
  let raw;
  try {
    raw = await googleBooksQuery(q);
  } catch (e) {
    // Rate-limited (or otherwise refused) by Google — OpenLibrary answers instead.
    try { raw = await openLibraryQuery(q); }
    catch { throw e.rateLimited ? new Error('Google Books is rate-limiting this server and OpenLibrary is unreachable — wait a minute and try again') : e; }
  }
  const results = rankResults(q, [raw]).slice(0, 24);
  if (ebookCache.size > 200) ebookCache.clear();
  ebookCache.set(key, { at: Date.now(), results });
  return results;
}

/* ---------------- Send-to-Kindle (email) ---------------- */

function smtpTransport(cfg) {
  const nodemailer = require('nodemailer');
  const port = parseInt(cfg.port || '587', 10);
  return nodemailer.createTransport({
    host: (cfg.host || '').trim(),
    port,
    secure: port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass || '' } : undefined
  });
}

async function smtpTest(cfg) {
  if (!cfg.host) throw new Error('Enter the SMTP server first');
  await smtpTransport(cfg).verify();
  return { ok: true, detail: 'Connected and authenticated to ' + cfg.host };
}

// Kindle only accepts EPUB and PDF by email (MOBI was retired by Amazon).
const KINDLE_OK = new Set(['.epub', '.pdf']);

async function sendToKindle(smtpCfg, kindleEmail, filePath, title) {
  const path = require('path');
  const fs = require('fs');
  const ext = path.extname(filePath).toLowerCase();
  if (!KINDLE_OK.has(ext)) {
    throw new Error('Kindle only accepts EPUB or PDF by email — this book is ' + (ext || 'unknown') + '. Grab an EPUB release instead.');
  }
  const size = fs.statSync(filePath).size;
  if (size > 50 * 1024 * 1024) throw new Error('File is over Amazon\'s 50 MB email limit');
  const from = smtpCfg.from || smtpCfg.user;
  await smtpTransport(smtpCfg).sendMail({
    from,
    to: kindleEmail,
    subject: title,
    text: 'Sent by Librarian',
    attachments: [{ filename: path.basename(filePath), path: filePath }]
  });
}

// Main search entry: handles ISBNs, runs a targeted title/author query when the user
// writes "Title by Author", merges with the keyword search, and re-ranks everything
// so the actual book beats loosely-related keyword noise.
async function searchBooks(q) {
  const digits = q.replace(/[-\s]/g, '');
  if (/^(97[89])?\d{9}[\dXx]$/.test(digits)) {
    const resolved = await isbnLookup(digits).catch(() => null);
    if (resolved) {
      const byIsbn = await audibleCatalog({ keywords: resolved });
      if (byIsbn.length) return rankResults(resolved, [byIsbn]).slice(0, 24);
    }
  }

  const jobs = [audibleCatalog({ keywords: q })];
  const byAuthor = q.match(/^(.{2,}?)\s+by\s+(.{2,})$/i);
  if (byAuthor) jobs.push(audibleCatalog({ title: byAuthor[1].trim(), author: byAuthor[2].trim() }));

  const settled = await Promise.allSettled(jobs);
  const lists = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  if (!lists.length) throw settled[0].reason;
  // targeted title/author results dedupe first so they win ties
  let results = rankResults(q, lists.length === 2 ? [lists[1], lists[0]] : lists);

  if (!results.length) {
    const relaxed = tokenize(q).join(' ');
    if (relaxed && relaxed !== q.toLowerCase()) {
      results = rankResults(relaxed, [await audibleCatalog({ keywords: relaxed })]);
    }
  }
  return results.slice(0, 24);
}

/* ---------------- Auto-discovery ---------------- */

const PROBES = [
  {
    service: 'qbit', label: 'qBittorrent', ports: [8080, 8112, 8081, 8090, 8085],
    check: async base => {
      const res = await jfetch(base + '/api/v2/app/webapiVersion', {}, 2500);
      return [200, 401, 403].includes(res.status);
    }
  },
  {
    service: 'prowlarr', label: 'Prowlarr', ports: [9696],
    check: async base => {
      const res = await jfetch(base + '/ping', {}, 2500);
      if (!res.ok) return false;
      try { const j = await res.json(); return String(j.status || '').toLowerCase() === 'ok'; }
      catch { return false; }
    }
  },
  {
    service: 'abs', label: 'AudioBookShelf', ports: [13378, 8000],
    check: async base => {
      const res = await jfetch(base + '/ping', {}, 2500);
      if (!res.ok) return false;
      try { const j = await res.json(); return j.success === true; }
      catch { return false; }
    }
  }
];

async function discover(host) {
  const found = {};
  await Promise.all(PROBES.map(async probe => {
    for (const port of probe.ports) {
      const base = `http://${host}:${port}`;
      try {
        if (await probe.check(base)) { found[probe.service] = { url: base, label: probe.label }; return; }
      } catch { /* not here — keep probing */ }
    }
  }));
  return found;
}

module.exports = {
  qbitTest, qbitAdd, qbitList, qbitDelete, qbitEnsureCategory, qbitWaitForTag,
  prowlarrTest, prowlarrSearch,
  absTest, absLibraries, absScan, absLibraryItems,
  notify, notifySend, scoreRelease, pickBestRelease,
  audibleSearch, searchBooks, ebookSearch,
  smtpTest, sendToKindle, discover
};
