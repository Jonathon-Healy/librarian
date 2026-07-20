'use strict';
// Watches the qBittorrent category for Librarian downloads and imports finished
// audiobooks into the AudioBookShelf library as Author/Title, then triggers a scan.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { qbitList, absScan, notify, sendToKindle } = require('./integrations');

const AUDIO_EXT = new Set(['.m4b', '.mp3', '.m4a', '.flac', '.ogg', '.opus', '.aac', '.wma', '.wav']);
const EBOOK_EXT = new Set(['.epub', '.mobi', '.azw3', '.azw', '.azw4', '.pdf', '.fb2', '.djvu', '.lit', '.prc', '.rtf', '.chm', '.htmlz', '.cbz', '.cbr']);
const EXTRA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.cue']);
const KINDLE_PREF = ['.epub', '.pdf', '.azw3', '.mobi']; // preference order for the "main" ebook file
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
  const isEbook = item.mediaType === 'ebook';
  const src = mapPath(item.contentPath, settings);
  if (!src || !fs.existsSync(src)) {
    throw new Error('Download not visible to Librarian at "' + (src || '?')
      + '". Check that the Downloads mount matches qBittorrent\'s, or set Remote Path Mapping in Settings → Paths.');
  }
  const libRoot = isEbook ? (settings.paths.ebooks || '/ebooks') : (settings.paths.library || '/audiobooks');
  if (!fs.existsSync(libRoot)) {
    throw new Error((isEbook ? 'eBook' : 'Library') + ' folder "' + libRoot
      + '" does not exist inside the container. Check the ' + (isEbook ? '/ebooks' : '/audiobooks') + ' mount.');
  }

  const MAIN_EXT = isEbook ? EBOOK_EXT : AUDIO_EXT;
  const destDir = path.join(libRoot, sanitize(item.author || 'Unknown Author'), sanitize(item.title || 'Unknown Title'));
  const stat = fs.statSync(src);
  const all = stat.isFile() ? [src] : [...walk(src)];
  const wanted = all.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return MAIN_EXT.has(ext) || EXTRA_EXT.has(ext);
  });
  const mainFiles = wanted.filter(f => MAIN_EXT.has(path.extname(f).toLowerCase()));

  // Ebook torrents often ship the book inside a ZIP — pre-scan archives for ebook entries
  // so we know we have something to import before creating the library folder.
  let zipPlan = []; // [{ zipPath, entries: [entryName] }]
  if (isEbook && !mainFiles.length) {
    const AdmZip = require('adm-zip');
    for (const z of all.filter(f => path.extname(f).toLowerCase() === '.zip')) {
      try {
        const entries = new AdmZip(z).getEntries()
          .filter(e => !e.isDirectory && EBOOK_EXT.has(path.extname(e.entryName).toLowerCase()))
          .map(e => e.entryName);
        if (entries.length) zipPlan.push({ zipPath: z, entries });
      } catch { /* unreadable archive — ignore */ }
    }
  }

  if (!mainFiles.length && !zipPlan.length) {
    const present = [...new Set(all.map(f => path.extname(f).toLowerCase()).filter(Boolean))].join(', ') || 'none';
    const hasRar = all.some(f => /\.r(ar|\d\d)$/i.test(f));
    throw new Error('No ' + (isEbook ? 'ebook' : 'audio') + ' files found in the download (file types present: ' + present + ').'
      + (hasRar ? ' The book is packed in a RAR archive, which Librarian can\'t unpack — grab a different release' + (isEbook ? ' (EPUB preferred)' : '') + '.' : ''));
  }

  fs.mkdirSync(destDir, { recursive: true });
  const copied = [];
  for (const f of wanted) {
    const rel = stat.isFile() ? path.basename(f) : path.relative(src, f);
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f, target); // copy (not move) so the torrent keeps seeding
    copied.push(target);
  }
  // Extract ebook files straight out of ZIPs into the library folder
  if (zipPlan.length) {
    const AdmZip = require('adm-zip');
    for (const { zipPath, entries } of zipPlan) {
      try {
        const zip = new AdmZip(zipPath);
        for (const name of entries) {
          zip.extractEntryTo(name, destDir, false, true);
          copied.push(path.join(destDir, path.basename(name)));
        }
      } catch { /* skip bad archive */ }
    }
  }
  chownDeep(destDir);

  if (isEbook) {
    // remember the best single file for Send-to-Kindle (EPUB > PDF > AZW3 > MOBI, then largest)
    const candidates = copied.filter(f => EBOOK_EXT.has(path.extname(f).toLowerCase()));
    candidates.sort((a, b) => {
      const pa = KINDLE_PREF.indexOf(path.extname(a).toLowerCase());
      const pb = KINDLE_PREF.indexOf(path.extname(b).toLowerCase());
      const ra = pa === -1 ? 99 : pa, rb = pb === -1 ? 99 : pb;
      if (ra !== rb) return ra - rb;
      return fs.statSync(b).size - fs.statSync(a).size;
    });
    item.ebookFile = candidates[0] || null;
  }
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
          if (item.mediaType === 'ebook') {
            notify(s.notify, 'eBook ready', `"${item.title}"${item.author ? ' by ' + item.author : ''} is on the server.`);
            // auto Send-to-Kindle if the requester opted in
            const requester = (data.users || []).find(u => u.username === item.requestedBy);
            if (requester?.autoSendKindle && requester.kindleEmail && s.smtp.host && item.ebookFile) {
              try {
                await sendToKindle(s.smtp, requester.kindleEmail, item.ebookFile, item.title);
                item.note = 'Sent to ' + requester.kindleEmail;
                notify(s.notify, 'Sent to Kindle', `"${item.title}" is on its way to ${requester.kindleEmail}.`);
              } catch (e) {
                item.note = 'Kindle send failed: ' + e.message;
              }
            }
          } else {
            if (s.abs.url && s.abs.libraryId) {
              try { await absScan(s.abs, s.abs.libraryId); }
              catch (e) { item.note = 'Imported, but the AudioBookShelf scan failed: ' + e.message; }
            }
            notify(s.notify, 'Book ready', `"${item.title}"${item.author ? ' by ' + item.author : ''} is now in AudioBookShelf.`);
          }
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
