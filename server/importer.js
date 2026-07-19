'use strict';
// Watches the qBittorrent category for Librarian downloads and imports finished
// audiobooks into the AudioBookShelf library as Author/Title, then triggers a scan.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { qbitList, absScan, notify } = require('./integrations');

const AUDIO_EXT = new Set(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.wma', '.wav']);
const EXTRA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.cue', '.epub']);
const PUID = parseInt(process.env.PUID || '99', 10);
const PGID = parseInt(process.env.PGID || '100', 10);
const DONE_STATES = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP', 'checkingUP']);
const MISSING_GRACE_MS = 2 * 60 * 1000;

// Surface "can't reach qBittorrent" to the UI instead of silently stalling the queue.
let qbitFailStreak = 0;
let qbitWarning = null;
const getWarning = () => qbitWarning;

function sanitize(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') || 'Unknown';
}

function mapPath(p, settings) {
  const { remote, local } = settings.pathMap || {};
  if (remote && local && p && p.startsWith(remote)) return path.posix.join(local, p.slice(remote.length));
  return p;
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function chownDeep(p) {
  try {
    fs.chownSync(p, PUID, PGID);
    if (fs.statSync(p).isDirectory()) {
      for (const e of fs.readdirSync(p)) chownDeep(path.join(p, e));
    }
  } catch { /* best effort */ }
}

async function importItem(item, settings) {
  const src = mapPath(item.contentPath, settings);
  if (!src || !fs.existsSync(src)) {
    throw new Error('Download not visible to Librarian at "' + (src || '?')
      + '". Check that the Downloads mount matches qBittorrent\'s, or set Remote Path Mapping in Settings → Paths.');
  }
  const libRoot = settings.paths.library || '/audiobooks';
  if (!fs.existsSync(libRoot)) throw new Error('Library folder "' + libRoot + '" does not exist inside the container. Check the /audiobooks mount.');

  const destDir = path.join(libRoot, sanitize(item.author || 'Unknown Author'), sanitize(item.title || 'Unknown Title'));
  const stat = fs.statSync(src);
  const all = stat.isFile() ? [src] : [...walk(src)];
  const wanted = all.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return AUDIO_EXT.has(ext) || EXTRA_EXT.has(ext);
  });
  const audio = wanted.filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()));
  if (!audio.length) throw new Error('No audio files found in the completed download');

  fs.mkdirSync(destDir, { recursive: true });
  for (const f of wanted) {
    const rel = stat.isFile() ? path.basename(f) : path.relative(src, f);
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target); // copy (not move) so the torrent keeps seeding
  }
  chownDeep(destDir);
  return destDir;
}

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const data = store.get();
    const s = data.settings;
    const active = data.queue.filter(q => ['grabbed', 'downloading'].includes(q.status));
    if (!active.length || !s.qbit.url) return;

    let torrents;
    try {
      torrents = await qbitList(s.qbit);
      qbitFailStreak = 0;
      qbitWarning = null;
    } catch (e) {
      // temporarily unreachable — try again next tick; warn the UI after ~30s of failures
      qbitFailStreak++;
      if (qbitFailStreak >= 3) qbitWarning = 'Can\'t reach qBittorrent right now (' + e.message + '). Downloads continue, but progress won\'t update until the connection is back.';
      return;
    }

    let changed = false;
    for (const item of active) {
      const t = torrents.find(t =>
        (t.tags || '').split(',').map(x => x.trim()).includes(item.tag));

      if (!t) {
        if (Date.now() - item.addedAt > MISSING_GRACE_MS) {
          item.status = 'failed';
          item.error = item.progress > 0
            ? 'Torrent disappeared from qBittorrent (removed manually?)'
            : 'The torrent never showed up in qBittorrent. It may have been silently rejected (duplicate, or invalid torrent) — check qBittorrent\'s Execution Log (Tools → Log), then Retry or grab a different release.';
          changed = true;
        }
        continue;
      }

      const progress = Math.min(100, Math.round((t.progress || 0) * 100));
      if (item.progress !== progress) { item.progress = progress; changed = true; }
      item.hash = t.hash;
      item.speed = t.dlspeed || 0;
      item.eta = t.eta || 0;
      item.state = t.state || '';
      item.contentPath = t.content_path || item.contentPath;
      if (item.status === 'grabbed') { item.status = 'downloading'; changed = true; }

      const done = (t.progress >= 1) || DONE_STATES.has(t.state);
      if (done && item.status === 'downloading') {
        item.status = 'importing';
        store.save();
        try {
          const dest = await importItem(item, s);
          item.importedPath = dest;
          item.status = 'imported';
          item.completedAt = Date.now();
          item.error = null;
          if (s.abs.url && s.abs.libraryId) {
            try { await absScan(s.abs, s.abs.libraryId); }
            catch (e) { item.note = 'Imported, but the AudioBookShelf scan failed: ' + e.message; }
          }
          notify(s.notify, 'Book ready', `"${item.title}"${item.author ? ' by ' + item.author : ''} is now in AudioBookShelf.`);
        } catch (e) {
          item.status = 'failed';
          item.error = e.message;
          notify(s.notify, 'Import failed', `"${item.title}": ${e.message}`);
        }
        changed = true;
      }
    }
    if (changed) store.save();
  } finally {
    busy = false;
  }
}

function start() {
  setInterval(() => tick().catch(() => {}), 10000);
}

module.exports = { start, tick, importItem, sanitize, getWarning };
