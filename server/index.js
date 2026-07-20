'use strict';
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const store = require('./store');
const importer = require('./importer');
const I = require('./integrations');

const data = store.load();
authenticator.options = { window: 1 };

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.PORT || '8787', 10);
const SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days
const MASK = '__KEEP__';

/* ---------------- helpers ---------------- */

const rid = () => crypto.randomBytes(8).toString('hex');
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  res.status(e.status || 500).json({ error: e.message || 'Unexpected error' });
});

function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, role: u.role, autoPick: !!u.autoPick,
    kindleEmail: u.kindleEmail || '', autoSendKindle: !!u.autoSendKindle
  };
}

function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[token] = { userId: user.id, expires: Date.now() + SESSION_MS };
  store.save();
  res.setHeader('Set-Cookie',
    `lib_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_MS / 1000)}`);
  return publicUser(user);
}

function killUserSessions(userId) {
  for (const [t, s] of Object.entries(data.sessions)) {
    if (s.userId === userId) delete data.sessions[t];
  }
}

// Short-lived tokens between password step and MFA step
const pending = new Map(); // token -> { purpose, userId?, username?, passHash?, secret?, tries, expires }
function makePending(obj) {
  const token = crypto.randomBytes(24).toString('hex');
  pending.set(token, { ...obj, tries: 0, expires: Date.now() + 10 * 60 * 1000 });
  return token;
}
function takePending(token, purpose) {
  const p = pending.get(token);
  if (!p || p.expires < Date.now() || p.purpose !== purpose) throw httpErr(401, 'Session expired — start over');
  p.tries++;
  if (p.tries > 6) { pending.delete(token); throw httpErr(429, 'Too many wrong codes — sign in again'); }
  return p;
}

// Basic login rate limiting
const attempts = new Map(); // key -> { n, until }
function checkLock(key) {
  const a = attempts.get(key);
  if (a && a.until && a.until > Date.now()) throw httpErr(429, 'Too many attempts — try again in a minute');
}
function recordFail(key) {
  const a = attempts.get(key) || { n: 0 };
  a.n++;
  if (a.n >= 5) { a.until = Date.now() + 60 * 1000; a.n = 0; }
  attempts.set(key, a);
}

async function totpEnrollment(username) {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.keyuri(username, 'Librarian', secret);
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 240 });
  return { secret, otpauth, qr };
}

function validCreds(username, password) {
  if (!username || !/^[a-zA-Z0-9._-]{2,32}$/.test(username)) {
    throw httpErr(400, 'Username must be 2–32 characters (letters, numbers, . _ -)');
  }
  if (!password || password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
}

/* ---------------- auth middleware ---------------- */

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const token = cookies(req).lib_session;
  const s = token && data.sessions[token];
  if (s && s.expires > Date.now()) {
    const u = data.users.find(u => u.id === s.userId);
    if (u) { req.user = u; req.sessionToken = token; }
  }
  next();
});

const OPEN_PATHS = new Set(['/status', '/setup', '/setup/verify', '/login', '/login/mfa', '/login/enroll']);
app.use('/api', (req, res, next) => {
  if (req.user || OPEN_PATHS.has(req.path)) return next();
  res.status(401).json({ error: 'Not signed in' });
});

const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });

/* ---------------- status / setup / login ---------------- */

app.get('/api/status', (req, res) => {
  const s = data.settings;
  res.json({
    setup: data.users.length === 0,
    user: req.user ? publicUser(req.user) : null,
    configured: !!(s.qbit.url && s.prowlarr.url)
  });
});

app.post('/api/setup', wrap(async (req, res) => {
  if (data.users.length) throw httpErr(400, 'Setup is already complete');
  const { username, password } = req.body || {};
  validCreds(username, password);
  const enroll = await totpEnrollment(username);
  const token = makePending({
    purpose: 'setup', username, passHash: bcrypt.hashSync(password, 11), secret: enroll.secret
  });
  res.json({ token, qr: enroll.qr, secret: enroll.secret });
}));

app.post('/api/setup/verify', wrap(async (req, res) => {
  if (data.users.length) throw httpErr(400, 'Setup is already complete');
  const { token, code } = req.body || {};
  const p = takePending(token, 'setup');
  if (!authenticator.verify({ token: String(code || ''), secret: p.secret })) {
    throw httpErr(401, 'That code didn\'t match — try the current code from your authenticator app');
  }
  pending.delete(token);
  const user = {
    id: rid(), username: p.username, passHash: p.passHash,
    role: 'admin', totpSecret: p.secret, createdAt: Date.now()
  };
  data.users.push(user);
  res.json({ user: startSession(res, user) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const key = (req.ip || '') + '|' + String(username || '').toLowerCase();
  checkLock(key);
  const user = data.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ''), user.passHash)) {
    recordFail(key);
    throw httpErr(401, 'Wrong username or password');
  }
  attempts.delete(key);
  if (!user.totpSecret) {
    const enroll = await totpEnrollment(user.username);
    const token = makePending({ purpose: 'enroll', userId: user.id, secret: enroll.secret });
    return res.json({ enroll: true, token, qr: enroll.qr, secret: enroll.secret });
  }
  res.json({ mfa: true, token: makePending({ purpose: 'mfa', userId: user.id }) });
}));

app.post('/api/login/mfa', wrap(async (req, res) => {
  const { token, code } = req.body || {};
  const p = takePending(token, 'mfa');
  const user = data.users.find(u => u.id === p.userId);
  if (!user) throw httpErr(401, 'User no longer exists');
  if (!authenticator.verify({ token: String(code || ''), secret: user.totpSecret })) {
    throw httpErr(401, 'Wrong code — try again');
  }
  pending.delete(token);
  res.json({ user: startSession(res, user) });
}));

app.post('/api/login/enroll', wrap(async (req, res) => {
  const { token, code } = req.body || {};
  const p = takePending(token, 'enroll');
  const user = data.users.find(u => u.id === p.userId);
  if (!user) throw httpErr(401, 'User no longer exists');
  if (!authenticator.verify({ token: String(code || ''), secret: p.secret })) {
    throw httpErr(401, 'That code didn\'t match — try the current code from your authenticator app');
  }
  pending.delete(token);
  user.totpSecret = p.secret;
  res.json({ user: startSession(res, user) });
}));

app.post('/api/logout', (req, res) => {
  if (req.sessionToken) { delete data.sessions[req.sessionToken]; store.save(); }
  res.setHeader('Set-Cookie', 'lib_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

/* ---------------- users ---------------- */

app.get('/api/users', adminOnly, (req, res) => {
  res.json(data.users.map(u => ({
    ...publicUser(u), hasMfa: !!u.totpSecret, createdAt: u.createdAt
  })));
});

app.post('/api/users', adminOnly, wrap(async (req, res) => {
  const { username, password, role, autoPick } = req.body || {};
  validCreds(username, password);
  if (data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw httpErr(400, 'That username is taken');
  }
  const user = {
    id: rid(), username, passHash: bcrypt.hashSync(password, 11),
    role: role === 'admin' ? 'admin' : 'user', totpSecret: null,
    autoPick: !!autoPick, createdAt: Date.now()
  };
  data.users.push(user);
  store.save();
  res.json({ ...publicUser(user), hasMfa: false, createdAt: user.createdAt });
}));

app.post('/api/users/:id/autopick', adminOnly, wrap(async (req, res) => {
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) throw httpErr(404, 'User not found');
  user.autoPick = !!(req.body || {}).enabled;
  store.save();
  res.json({ ok: true, autoPick: user.autoPick });
}));

app.post('/api/me/autopick', wrap(async (req, res) => {
  req.user.autoPick = !!(req.body || {}).enabled;
  store.save();
  res.json({ ok: true, autoPick: req.user.autoPick });
}));

app.post('/api/me/kindle', wrap(async (req, res) => {
  const { kindleEmail, autoSendKindle } = req.body || {};
  const email = String(kindleEmail || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpErr(400, 'That doesn\'t look like an email address');
  req.user.kindleEmail = email;
  req.user.autoSendKindle = !!autoSendKindle && !!email;
  store.save();
  res.json({ ok: true, kindleEmail: req.user.kindleEmail, autoSendKindle: req.user.autoSendKindle });
}));

app.delete('/api/users/:id', adminOnly, wrap(async (req, res) => {
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) throw httpErr(404, 'User not found');
  if (user.id === req.user.id) throw httpErr(400, 'You can\'t delete your own account');
  data.users = data.users.filter(u => u.id !== user.id);
  killUserSessions(user.id);
  store.save();
  res.json({ ok: true });
}));

app.post('/api/users/:id/reset-mfa', adminOnly, wrap(async (req, res) => {
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) throw httpErr(404, 'User not found');
  user.totpSecret = null;
  killUserSessions(user.id);
  store.save();
  res.json({ ok: true });
}));

app.post('/api/users/:id/password', adminOnly, wrap(async (req, res) => {
  const user = data.users.find(u => u.id === req.params.id);
  if (!user) throw httpErr(404, 'User not found');
  const { password } = req.body || {};
  if (!password || password.length < 8) throw httpErr(400, 'Password must be at least 8 characters');
  user.passHash = bcrypt.hashSync(password, 11);
  if (user.id !== req.user.id) killUserSessions(user.id);
  store.save();
  res.json({ ok: true });
}));

app.post('/api/me/password', wrap(async (req, res) => {
  const { current, password } = req.body || {};
  if (!bcrypt.compareSync(String(current || ''), req.user.passHash)) {
    throw httpErr(401, 'Current password is wrong');
  }
  if (!password || password.length < 8) throw httpErr(400, 'New password must be at least 8 characters');
  req.user.passHash = bcrypt.hashSync(password, 11);
  store.save();
  res.json({ ok: true });
}));

/* ---------------- settings ---------------- */

function maskedSettings() {
  const s = JSON.parse(JSON.stringify(data.settings));
  if (s.qbit.password) s.qbit.password = MASK;
  if (s.prowlarr.apiKey) s.prowlarr.apiKey = MASK;
  if (s.abs.apiKey) s.abs.apiKey = MASK;
  if (s.smtp.pass) s.smtp.pass = MASK;
  return s;
}

// Resolve MASK sentinels back to stored secrets for a candidate config
function resolveSecrets(section, cfg) {
  const merged = Object.assign({}, data.settings[section], cfg || {});
  const stored = data.settings[section];
  for (const field of ['password', 'apiKey', 'pass']) {
    if (merged[field] === MASK) merged[field] = stored[field];
  }
  return merged;
}

app.get('/api/settings', adminOnly, (req, res) => res.json(maskedSettings()));

app.put('/api/settings', adminOnly, wrap(async (req, res) => {
  const body = req.body || {};
  for (const section of ['qbit', 'prowlarr', 'abs', 'paths', 'pathMap', 'notify', 'smtp']) {
    if (!body[section]) continue;
    const merged = resolveSecrets(section, body[section]);
    if (merged.url) merged.url = String(merged.url).trim().replace(/\/+$/, '');
    data.settings[section] = merged;
  }
  store.save();
  res.json(maskedSettings());
}));

app.post('/api/settings/test/:service', adminOnly, wrap(async (req, res) => {
  const svc = req.params.service;
  const cfg = resolveSecrets(svc, req.body);
  if (svc !== 'smtp' && !cfg.url) throw httpErr(400, 'Enter a URL first');
  let out;
  if (svc === 'qbit') out = await I.qbitTest(cfg);
  else if (svc === 'prowlarr') out = await I.prowlarrTest(cfg);
  else if (svc === 'abs') out = await I.absTest(cfg);
  else if (svc === 'notify') {
    await I.notifySend(cfg, 'Librarian', 'Test notification — your setup works!');
    out = { ok: true, detail: 'Notification sent — check your phone/channel' };
  }
  else if (svc === 'smtp') out = await I.smtpTest(cfg);
  else throw httpErr(400, 'Unknown service');
  res.json(out);
}));

app.post('/api/settings/discover', adminOnly, wrap(async (req, res) => {
  let host = String((req.body || {}).host || '').trim();
  if (!host) host = String(req.headers.host || '').split(':')[0];
  if (!/^[a-zA-Z0-9.\-_]+$/.test(host)) throw httpErr(400, 'That doesn\'t look like a hostname or IP');
  res.json(await I.discover(host));
}));

app.post('/api/abs/libraries', adminOnly, wrap(async (req, res) => {
  const cfg = resolveSecrets('abs', req.body);
  if (!cfg.url) throw httpErr(400, 'Enter the AudioBookShelf URL first');
  res.json(await I.absLibraries(cfg));
}));

app.get('/api/fs/browse', adminOnly, wrap(async (req, res) => {
  const p = path.resolve('/', String(req.query.path || '/'));
  let exists = false;
  try { exists = fs.statSync(p).isDirectory(); } catch { }
  let dirs = [];
  if (exists) {
    dirs = fs.readdirSync(p, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  let writable = false;
  try { fs.accessSync(p, fs.constants.W_OK); writable = true; } catch { }
  res.json({ path: p, parent: p === '/' ? null : path.dirname(p), exists, writable, dirs });
}));

/* ---------------- search & grab ---------------- */

// Cached index of the ABS library for "already in library" detection (refreshed every 5 min)
let libCache = { at: 0, items: [] };
const normTxt = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function libraryIndex() {
  const abs = data.settings.abs;
  if (!abs.url || !abs.apiKey || !abs.libraryId) return [];
  if (Date.now() - libCache.at < 5 * 60 * 1000) return libCache.items;
  try {
    const items = await I.absLibraryItems(abs, abs.libraryId);
    libCache = { at: Date.now(), items: items.map(x => ({ t: normTxt(x.title), a: normTxt(x.author) })) };
  } catch {
    libCache.at = Date.now(); // back off on failure, retry in 5 min
  }
  return libCache.items;
}

function isInLibrary(idx, title, authors) {
  const t = normTxt(title);
  if (!t) return false;
  const as = (authors || []).map(normTxt).filter(Boolean);
  return idx.some(x => {
    const titleMatch = x.t === t || (t.length > 6 && (x.t.startsWith(t) || t.startsWith(x.t)));
    if (!titleMatch) return false;
    if (!as.length || !x.a) return true;
    return as.some(a => x.a.includes(a) || a.includes(x.a));
  });
}

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  if (req.query.type === 'ebook') {
    // ebooks: Google Books (OpenLibrary fallback) — completely separate source from audiobooks
    return res.json(await I.ebookSearch(q));
  }
  const results = await I.searchBooks(q);
  for (const b of results) b.mediaType = 'audio';
  const idx = await libraryIndex();
  if (idx.length) for (const b of results) b.inLibrary = isInLibrary(idx, b.title, b.authors);
  res.json(results);
}));

app.get('/api/releases', wrap(async (req, res) => {
  const s = data.settings;
  if (!s.prowlarr.url) throw httpErr(400, 'Prowlarr isn\'t configured yet — an admin can set it up in Settings');
  const title = String(req.query.title || '').trim();
  const author = String(req.query.author || '').trim();
  if (!title) throw httpErr(400, 'Missing title');
  let results = await I.prowlarrSearch(s.prowlarr, [title, author].filter(Boolean).join(' '));
  if (!results.length && author) results = await I.prowlarrSearch(s.prowlarr, title);
  res.json(results.slice(0, 50));
}));

// Add a torrent for an item and transform it into the download flow. Shared by the
// manual picker and auto-pick. Throws (leaving the item untouched) on failure.
async function performGrab(item, release) {
  const s = data.settings;
  if (!s.qbit.url) throw new Error('qBittorrent isn\'t configured yet — an admin can set it up in Settings');
  if (!release?.link) throw new Error('That release has no usable download link');
  const tag = 'librarian-' + item.id;
  await I.qbitEnsureCategory(s.qbit);
  await I.qbitAdd(s.qbit, { url: release.link, tag });
  const t = await I.qbitWaitForTag(s.qbit, tag);
  if (!t) {
    throw new Error('qBittorrent accepted the torrent but it never appeared in its queue. It may have silently rejected it (duplicate torrent, or a problem processing the file) — check qBittorrent\'s Execution Log (Tools → Log).');
  }
  Object.assign(item, {
    tag, hash: t.hash, type: 'download', status: 'grabbed', addedAt: Date.now(), progress: 0,
    releaseTitle: release.title || '', indexer: release.indexer || '',
    size: release.size || 0, error: null
  });
  delete item.releases;
}

// Background indexer search. Outcomes: auto-grabbed (if the requester has auto-pick on),
// "ready" for manual selection, or "wanted" (no releases yet — re-checked automatically).
async function runReleaseSearch(id) {
  const item = data.queue.find(q => q.id === id);
  if (!item) return;
  try {
    const p = data.settings.prowlarr;
    const mt = item.mediaType || 'audio';
    let results = await I.prowlarrSearch(p, [item.title, item.author].filter(Boolean).join(' '), mt);
    if (!results.length && item.author) results = await I.prowlarrSearch(p, item.title, mt);
    item.lastChecked = Date.now();
    if (results.length) {
      item.releases = results.slice(0, 50);
      item.error = null;
      const requester = data.users.find(u => u.username === item.requestedBy);
      if (requester?.autoPick) {
        const best = I.pickBestRelease(item.releases, mt);
        if (best) {
          try {
            await performGrab(item, best);
            item.note = 'Auto-selected: ' + (best.title || '').slice(0, 90);
            store.save();
            return;
          } catch (e) {
            item.note = 'Auto-pick failed (' + e.message + ') — choose a release manually.';
          }
        }
      }
      item.status = 'ready';
      I.notify(data.settings.notify, 'Ready for selection', `"${item.title}" — ${item.releases.length} release${item.releases.length === 1 ? '' : 's'} found. Open Librarian to choose.`);
    } else {
      item.status = 'wanted';
      item.error = null;
      if (!item.wantedSince) item.wantedSince = Date.now();
    }
  } catch (e) {
    item.status = 'failed';
    item.error = e.message;
  }
  store.save();
}

// Re-check wanted items twice a day; grab or mark ready as soon as something appears.
async function recheckWanted() {
  for (const item of data.queue.filter(q => q.status === 'wanted')) {
    await runReleaseSearch(item.id);
    if (item.status === 'failed') { // background failure (e.g. Prowlarr down) — stay wanted
      item.status = 'wanted';
      item.error = null;
      store.save();
    }
  }
}

app.post('/api/search-releases', wrap(async (req, res) => {
  const s = data.settings;
  if (!s.prowlarr.url) throw httpErr(400, 'Prowlarr isn\'t configured yet — an admin can set it up in Settings');
  const { book, force } = req.body || {};
  if (!book?.title) throw httpErr(400, 'Missing book details');
  const mediaType = book.mediaType === 'ebook' ? 'ebook' : 'audio';
  const dupe = book.asin && data.queue.find(q =>
    q.asin === book.asin && (q.mediaType || 'audio') === mediaType && ['searching', 'ready', 'wanted'].includes(q.status));
  if (dupe) return res.json({ ok: true, id: dupe.id, existing: true });
  if (!force && mediaType === 'audio') {
    const idx = await libraryIndex();
    if (idx.length && isInLibrary(idx, book.title, book.authors)) {
      return res.status(409).json({ duplicate: true, error: `"${book.title}" looks like it's already in your AudioBookShelf library.` });
    }
  }
  const id = rid();
  data.queue.unshift({
    id, type: 'search', mediaType, status: 'searching', addedAt: Date.now(),
    asin: book.asin || null, title: book.title,
    author: (book.authors || [])[0] || '', authors: book.authors || [],
    cover: book.cover || null, requestedBy: req.user.username
  });
  if (data.queue.length > 200) data.queue.length = 200;
  store.save();
  runReleaseSearch(id).catch(() => { });
  res.json({ ok: true, id });
}));

app.post('/api/grab', wrap(async (req, res) => {
  const { book, release, itemId } = req.body || {};
  if (!book?.title || !release?.link) throw httpErr(400, 'Missing book or release details');
  const existing = itemId ? data.queue.find(q => q.id === itemId) : null;
  const item = existing || {
    id: rid(), asin: book.asin || null, title: book.title,
    mediaType: book.mediaType === 'ebook' ? 'ebook' : 'audio',
    author: (book.authors || [])[0] || '', cover: book.cover || null,
    requestedBy: req.user.username
  };
  try {
    await performGrab(item, release);
  } catch (e) {
    throw httpErr(502, e.message);
  }
  if (!existing) {
    data.queue.unshift(item);
    if (data.queue.length > 200) data.queue.length = 200;
  }
  store.save();
  res.json({ ok: true, id: item.id });
}));

/* ---------------- queue ---------------- */

app.get('/api/queue', (req, res) => {
  res.json({ items: data.queue, warning: importer.getWarning() });
});

app.delete('/api/queue/:id', wrap(async (req, res) => {
  const item = data.queue.find(q => q.id === req.params.id);
  if (!item) throw httpErr(404, 'Item not found');
  if (req.user.role !== 'admin') {
    throw httpErr(403, 'Only admins can remove Activity items');
  }
  const removeTorrent = req.query.removeTorrent === '1';
  const deleteFiles = req.query.deleteFiles === '1';
  if (removeTorrent && item.hash && data.settings.qbit.url) {
    try { await I.qbitDelete(data.settings.qbit, item.hash, deleteFiles); } catch { }
  }
  data.queue = data.queue.filter(q => q.id !== item.id);
  store.save();
  res.json({ ok: true });
}));

app.post('/api/queue/:id/send-kindle', wrap(async (req, res) => {
  const item = data.queue.find(q => q.id === req.params.id);
  if (!item) throw httpErr(404, 'Item not found');
  if (!item.ebookFile) throw httpErr(400, 'No ebook file recorded for this item');
  const fsx = require('fs');
  if (!fsx.existsSync(item.ebookFile)) throw httpErr(400, 'The ebook file is no longer at ' + item.ebookFile);
  if (!data.settings.smtp.host) throw httpErr(400, 'Email isn\'t set up yet — an admin can add SMTP details in Settings → Connections');
  if (!req.user.kindleEmail) throw httpErr(400, 'Add your Kindle email in Settings → Profile first');
  await I.sendToKindle(data.settings.smtp, req.user.kindleEmail, item.ebookFile, item.title);
  item.note = 'Sent to ' + req.user.kindleEmail;
  store.save();
  res.json({ ok: true });
}));

app.post('/api/queue/:id/retry', wrap(async (req, res) => {
  const item = data.queue.find(q => q.id === req.params.id);
  if (!item) throw httpErr(404, 'Item not found');
  if (!['failed', 'wanted'].includes(item.status)) throw httpErr(400, 'Only failed or wanted items can be retried');
  if (item.type === 'search' && !item.hash) {
    // an indexer search that failed, or a wanted item being re-checked manually
    item.status = 'searching';
    item.error = null;
    store.save();
    runReleaseSearch(item.id).catch(() => { });
    return res.json({ ok: true });
  }
  if (!item.contentPath) {
    // never saw the torrent — put it back into watch state
    item.status = 'grabbed';
    item.addedAt = Date.now();
    item.error = null;
    store.save();
    return res.json({ ok: true });
  }
  item.status = 'importing';
  item.error = null;
  store.save();
  importer.importItem(item, data.settings)
    .then(async dest => {
      item.importedPath = dest;
      item.status = 'imported';
      item.completedAt = Date.now();
      const abs = data.settings.abs;
      if (abs.url && abs.libraryId) {
        try { await I.absScan(abs, abs.libraryId); } catch { }
      }
      store.save();
    })
    .catch(e => { item.status = 'failed'; item.error = e.message; store.save(); });
  res.json({ ok: true });
}));

/* ---------------- static frontend ---------------- */

const PUB = path.join(__dirname, '..', 'public');
// Assets are cache-busted with ?v= in index.html; index.html itself must never be cached
// (a stale index caused users to run old app code after updates).
app.use(express.static(PUB, {
  index: false,
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUB, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Librarian listening on :${PORT}`);
  importer.start();
  // resume any indexer searches that were interrupted by a restart
  for (const q of data.queue.filter(q => q.status === 'searching')) {
    runReleaseSearch(q.id).catch(() => { });
  }
  // wanted-list watcher: first pass 10 minutes after boot, then every 12 hours
  setTimeout(() => recheckWanted().catch(() => { }), 10 * 60 * 1000);
  setInterval(() => recheckWanted().catch(() => { }), 12 * 60 * 60 * 1000);
});
