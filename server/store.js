'use strict';
// Simple JSON persistence with atomic writes. Small data set (users, settings, queue) — no DB needed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const FILE = path.join(CONFIG_DIR, 'librarian.json');

const defaults = () => ({
  secret: crypto.randomBytes(32).toString('hex'),
  users: [],     // { id, username, passHash, role: 'admin'|'user', totpSecret, createdAt }
  sessions: {},  // token -> { userId, expires }
  queue: [],     // download/import queue items
  settings: {
    qbit: { url: '', username: '', password: '', category: 'librarian' },
    prowlarr: { url: '', apiKey: '', preferred: '' }, // preferred: comma-separated indexer names listed/picked first
    abb: { enabled: true, url: 'https://audiobookbay.lu, https://audiobookbay.is, https://audiobookbay.se', proxy: '' }, // built-in AudioBookBay indexer — comma-separated mirrors; proxy routes ABB traffic via a VPN'd HTTP proxy
    abs: { url: '', apiKey: '', libraryId: '', libraryName: '' },
    paths: { library: '/audiobooks', ebooks: '/ebooks' },
    pathMap: { remote: '', local: '' }, // qBittorrent path prefix -> Librarian path prefix
    notify: { url: '' }, // optional: ntfy / Discord webhook / Gotify URL
    smtp: { host: '', port: '587', user: '', pass: '', from: '' }, // for Send-to-Kindle email
  }
});

let data = null;

function load() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    data = defaults();
  }
  // Merge in any new default keys after upgrades
  const d = defaults();
  data.settings = data.settings || {};
  for (const key of Object.keys(d.settings)) {
    data.settings[key] = Object.assign({}, d.settings[key], data.settings[key] || {});
  }
  data.users = data.users || [];
  data.sessions = data.sessions || {};
  data.queue = data.queue || [];
  if (!data.secret) data.secret = d.secret;
  // Drop expired sessions
  const now = Date.now();
  for (const [t, s] of Object.entries(data.sessions)) {
    if (!s || s.expires < now) delete data.sessions[t];
  }
  save();
  return data;
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

module.exports = { load, save, get: () => data };
