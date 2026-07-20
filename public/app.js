/* Librarian SPA */
'use strict';

const $app = document.getElementById('app');
const state = {
  user: null,
  view: 'search',
  searchMode: 'audio', // 'audio' | 'ebook' — fully separate catalogs and indexer categories
  activityMode: 'audio',
  searchQuery: '',
  searchResults: null, // null = untouched, [] = no results
  searching: false,
  queue: [],
  settings: null,
  settingsTab: 'connections',
  users: [],
};
let queueTimer = null;

/* ---------------- utils ---------------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  let j = {};
  try { j = await res.json(); } catch { }
  if (res.status === 401 && state.user && !path.startsWith('/login') && !path.startsWith('/me')) {
    state.user = null; render();
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const err = new Error(j.error || ('Request failed (' + res.status + ')'));
    Object.assign(err, j); // carry flags like { duplicate: true }
    throw err;
  }
  return j;
}

function toast(msg, ok = true) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = (ok
    ? '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg class="cross" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 6 6 18M6 6l12 12"/></svg>')
    + '<span>' + esc(msg) + '</span>';
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 2800);
}

const fmtSize = b => {
  if (!b) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
};
const fmtSpeed = b => b ? fmtSize(b) + '/s' : '';
const fmtEta = s => {
  if (!s || s < 0 || s >= 8640000) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
};
const fmtRuntime = m => m ? (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60 ? (m % 60) + 'm' : '') : m + 'm') : '';
const fmtAge = d => {
  if (!d) return '';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return days + 'd';
  if (days < 365) return Math.floor(days / 30) + 'mo';
  return Math.floor(days / 365) + 'y';
};

function spinnerize(btn, on) {
  if (on) {
    btn.dataset.orig = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span>';
    btn.disabled = true;
  } else {
    btn.innerHTML = btn.dataset.orig || btn.innerHTML;
    btn.disabled = false;
  }
}

/* icons */
const IC = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 4v12m0 0 5-5m-5 5-5-5"/><path d="M5 20h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9m-3 3 3 3m-6 0 2 2"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>',
};

/* ---------------- root render ---------------- */

async function boot() {
  try {
    const st = await api('/status');
    state.user = st.user;
    state.setup = st.setup;
  } catch (e) {
    $app.innerHTML = '<div class="empty" style="padding-top:35vh"><div class="big">Can\'t reach the Librarian server</div>' + esc(e.message) + '</div>';
    return;
  }
  render();
}

function render() {
  clearInterval(queueTimer); queueTimer = null;
  if (state.setup) return renderSetup();
  if (!state.user) return renderLogin();
  renderShell();
}

/* ---------------- auth screens ---------------- */

function authFrame(inner) {
  $app.innerHTML = `
    <div class="auth">
      <img class="logo" src="/icon.svg" alt="">
      <h1>Librarian</h1>
      <div class="tag">Your audiobook concierge</div>
      <div class="card">${inner}</div>
    </div>`;
}

function renderSetup() {
  authFrame(`
    <h3>Create the admin account</h3>
    <p class="hint">First run — set up your own account. You'll add other readers later in Settings.</p>
    <div class="err" id="err"></div>
    <div class="field"><label>Username</label><input class="input" id="su" autocomplete="username" autocapitalize="off"></div>
    <div class="field"><label>Password</label><input class="input" id="sp" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
    <button class="btn block" id="go">Continue</button>`);
  const go = document.getElementById('go');
  go.onclick = async () => {
    spinnerize(go, true);
    try {
      const r = await api('/setup', { method: 'POST', body: { username: document.getElementById('su').value.trim(), password: document.getElementById('sp').value } });
      renderEnroll(r, '/setup/verify', 'Scan this with your authenticator app (Google Authenticator, Authy, 1Password…), then enter the 6-digit code to finish.');
    } catch (e) { document.getElementById('err').textContent = e.message; spinnerize(go, false); }
  };
}

function renderLogin() {
  authFrame(`
    <h3>Sign in</h3>
    <div class="err" id="err"></div>
    <div class="field"><label>Username</label><input class="input" id="lu" autocomplete="username" autocapitalize="off"></div>
    <div class="field"><label>Password</label><input class="input" id="lp" type="password" autocomplete="current-password"></div>
    <button class="btn block" id="go">Continue</button>`);
  const go = document.getElementById('go');
  const submit = async () => {
    spinnerize(go, true);
    try {
      const r = await api('/login', { method: 'POST', body: { username: document.getElementById('lu').value.trim(), password: document.getElementById('lp').value } });
      if (r.enroll) renderEnroll(r, '/login/enroll', 'First sign-in: scan this with your authenticator app, then enter the 6-digit code. You\'ll need it every time you sign in.');
      else renderMfa(r.token);
    } catch (e) { document.getElementById('err').textContent = e.message; spinnerize(go, false); }
  };
  go.onclick = submit;
  document.getElementById('lp').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

function codeField(onSubmit) {
  const input = document.getElementById('code');
  input.focus();
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) onSubmit(input.value);
  });
}

function renderEnroll(r, verifyPath, blurb) {
  authFrame(`
    <h3>Set up two-factor auth</h3>
    <p class="hint">${esc(blurb)}</p>
    <div class="qrwrap">
      <img src="${r.qr}" alt="QR code">
      <div class="secret">${esc(r.secret)}</div>
    </div>
    <div class="err" id="err"></div>
    <div class="field"><input class="input codeinput" id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••"></div>`);
  codeField(async code => {
    try {
      const res = await api(verifyPath, { method: 'POST', body: { token: r.token, code } });
      state.user = res.user; state.setup = false;
      toast('Welcome, ' + res.user.username + '!');
      render();
    } catch (e) { document.getElementById('err').textContent = e.message; document.getElementById('code').value = ''; }
  });
}

function renderMfa(token) {
  authFrame(`
    <h3>Enter your code</h3>
    <p class="hint">Open your authenticator app and type the 6-digit code for Librarian.</p>
    <div class="err" id="err"></div>
    <div class="field"><input class="input codeinput" id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="••••••"></div>`);
  codeField(async code => {
    try {
      const res = await api('/login/mfa', { method: 'POST', body: { token, code } });
      state.user = res.user;
      toast('Welcome back, ' + res.user.username + '!');
      render();
    } catch (e) { document.getElementById('err').textContent = e.message; document.getElementById('code').value = ''; }
  });
}

/* ---------------- app shell ---------------- */

const ATTENTION = ['searching', 'ready', 'grabbed', 'downloading', 'importing'];

function navButtons() {
  const activeCount = state.queue.filter(q => ATTENTION.includes(q.status)).length;
  return `
    <button data-v="search" class="${state.view === 'search' ? 'active' : ''}">${IC.search}<span>Search</span></button>
    <button data-v="activity" class="${state.view === 'activity' ? 'active' : ''}">${IC.activity}<span>Activity</span>${activeCount ? '<span class="badge">' + activeCount + '</span>' : ''}</button>
    <button data-v="settings" class="${state.view === 'settings' ? 'active' : ''}">${IC.settings}<span>Settings</span></button>`;
}

function renderShell() {
  $app.innerHTML = `
    <div class="shell">
      <div class="topbar">
        <div class="brand"><img src="/icon.svg" alt="">Librarian</div>
        <div class="topnav">${navButtons()}</div>
        <div class="spacer"></div>
        <div class="userchip">${esc(state.user.username)}</div>
      </div>
      <div id="content"></div>
    </div>
    <nav class="nav">${navButtons()}</nav>`;
  document.querySelectorAll('.nav button, .topnav button').forEach(b =>
    b.onclick = () => { state.view = b.dataset.v; render(); });
  const c = document.getElementById('content');
  if (state.view === 'search') renderSearch(c);
  else if (state.view === 'activity') renderActivity(c);
  else renderSettings(c);
  refreshQueueBadge();
}

async function refreshQueueBadge() {
  try {
    const r = await api('/queue');
    state.queue = r.items || [];
    state.queueWarning = r.warning || null;
  } catch { return; }
  const activeCount = state.queue.filter(q => ATTENTION.includes(q.status)).length;
  document.querySelectorAll('.nav button[data-v="activity"], .topnav button[data-v="activity"]').forEach(btn => {
    const existing = btn.querySelector('.badge');
    if (activeCount) {
      if (existing) existing.textContent = activeCount;
      else btn.insertAdjacentHTML('beforeend', '<span class="badge">' + activeCount + '</span>');
    } else if (existing) existing.remove();
  });
}

/* ---------------- search view ---------------- */

function renderSearch(c) {
  c.innerHTML = `
    <div class="view">
      <div class="seg" style="margin-bottom:12px">
        <button data-m="audio" class="${state.searchMode === 'audio' ? 'active' : ''}">🎧 Audiobooks</button>
        <button data-m="ebook" class="${state.searchMode === 'ebook' ? 'active' : ''}">📖 eBooks</button>
      </div>
      <div class="searchbar">
        <div class="searchwrap">
          ${IC.search}
          <input class="input" id="q" type="search" placeholder="${state.searchMode === 'ebook' ? 'eBook title, author, or ISBN…' : 'Title, author, series, or ISBN…'}" value="${esc(state.searchQuery)}" enterkeyhint="search">
        </div>
        <button class="btn searchbtn" id="qgo">Search</button>
      </div>
      <div id="results"></div>
    </div>`;
  c.querySelectorAll('.seg button[data-m]').forEach(b => b.onclick = () => {
    if (state.searchMode === b.dataset.m) return;
    state.searchMode = b.dataset.m;
    state.searchResults = null;
    renderSearch(c);
    if (state.searchQuery) doSearch(state.searchQuery);
  });
  const q = document.getElementById('q');
  let deb;
  q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => doSearch(q.value), 550); });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(deb); doSearch(q.value); q.blur(); } });
  document.getElementById('qgo').onclick = () => { clearTimeout(deb); doSearch(q.value); q.blur(); };
  paintResults();
}

async function doSearch(query) {
  query = query.trim();
  state.searchQuery = query;
  if (!query) { state.searchResults = null; paintResults(); return; }
  const mode = state.searchMode;
  state.searching = true; paintResults();
  try {
    const r = await api('/search?type=' + mode + '&q=' + encodeURIComponent(query));
    if (state.searchQuery !== query || state.searchMode !== mode) return; // stale
    state.searchResults = r;
  } catch (e) {
    toast(e.message, false);
    state.searchResults = [];
  }
  state.searching = false;
  paintResults();
}

function paintResults() {
  const el = document.getElementById('results');
  if (!el) return;
  if (state.searching) {
    el.innerHTML = '<div class="results">' + '<div class="sk"></div>'.repeat(6) + '</div>';
    return;
  }
  if (state.searchResults === null) {
    el.innerHTML = state.searchMode === 'ebook'
      ? `<div class="empty">${IC.book}<div class="big">Find your next read</div>Search for eBooks — they're stored on the server and can be sent straight to a Kindle.</div>`
      : `<div class="empty">${IC.book}<div class="big">Find your next listen</div>Search Audible's catalog, then grab a release from your indexers.</div>`;
    return;
  }
  if (!state.searchResults.length) {
    el.innerHTML = `<div class="empty">${IC.book}<div class="big">Nothing found</div>Try fewer words, or just the author's name.</div>`;
    return;
  }
  el.innerHTML = '<div class="results">' + state.searchResults.map((b, i) => `
    <div class="book" data-i="${i}" style="animation-delay:${Math.min(i * 35, 300)}ms">
      ${b.cover ? `<img class="cover" src="${esc(b.cover)}" loading="lazy" alt="">` : '<div class="cover"></div>'}
      <div class="info">
        <div class="t">${esc(b.title)}</div>
        <div class="a">${esc(b.authors.join(', '))}${b.narrators.length ? ' · read by ' + esc(b.narrators.slice(0, 2).join(', ')) : ''}</div>
        <div class="m">
          ${b.inLibrary ? '<span class="pill inlib">✓ In library</span>' : ''}
          ${b.series ? `<span class="pill series">${esc(b.series.title)}${b.series.sequence ? ' #' + esc(b.series.sequence) : ''}</span>` : ''}
          ${b.rating ? `<span class="pill rating">★ ${esc(b.rating)}</span>` : ''}
          ${b.runtimeMin ? `<span class="pill">${fmtRuntime(b.runtimeMin)}</span>` : ''}
          ${b.pages ? `<span class="pill">${b.pages} pages</span>` : ''}
          ${b.releaseDate && b.mediaType === 'ebook' ? `<span class="pill">${esc(String(b.releaseDate).slice(0, 4))}</span>` : ''}
        </div>
      </div>
    </div>`).join('') + '</div>';
  el.querySelectorAll('.book').forEach(bk => bk.onclick = () => openBookSheet(state.searchResults[+bk.dataset.i]));
}

/* ---------------- book sheet ---------------- */

function closeSheets() {
  document.querySelectorAll('.sheet-backdrop, .sheet').forEach(e => e.remove());
}

function openBookSheet(book) {
  closeSheets();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet">
      <div class="handle"></div>
      <div class="head">
        ${book.cover ? `<img src="${esc(book.cover)}" alt="">` : ''}
        <div>
          <div class="t">${esc(book.title)}</div>
          <div class="a">${esc(book.authors.join(', '))}</div>
          ${book.narrators.length ? `<div class="a">Narrated by ${esc(book.narrators.join(', '))}</div>` : ''}
        </div>
      </div>
      <div class="meta">
        ${book.inLibrary ? '<span class="pill inlib">✓ In library</span>' : ''}
        ${book.series ? `<span class="pill series">${esc(book.series.title)}${book.series.sequence ? ' #' + esc(book.series.sequence) : ''}</span>` : ''}
        ${book.rating ? `<span class="pill rating">★ ${esc(book.rating)}</span>` : ''}
        ${book.runtimeMin ? `<span class="pill">${fmtRuntime(book.runtimeMin)}</span>` : ''}
        ${book.pages ? `<span class="pill">${book.pages} pages</span>` : ''}
        ${book.releaseDate ? `<span class="pill">${esc(String(book.releaseDate).slice(0, 4))}</span>` : ''}
        <span class="pill">${book.mediaType === 'ebook' ? '📖 eBook' : '🎧 Audiobook'}</span>
      </div>
      ${book.summary ? `<div class="summary" id="summ">${esc(book.summary)}</div><button class="morebtn" id="more">Read more</button>` : ''}
      <button class="btn block" id="find">${IC.search} Find releases</button>
      <div class="sub" style="text-align:center;margin-top:10px">The search runs in the background — you'll pick a release from the Activity tab.</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('.sheet-backdrop').onclick = closeSheets;
  const more = wrap.querySelector('#more');
  if (more) more.onclick = () => {
    const s = wrap.querySelector('#summ');
    s.classList.toggle('open');
    more.textContent = s.classList.contains('open') ? 'Show less' : 'Read more';
  };
  const find = wrap.querySelector('#find');
  const startSearch = async force => {
    const r = await api('/search-releases', { method: 'POST', body: { book, force } });
    closeSheets();
    toast(r.existing ? 'Already tracked — check Activity' : 'Searching your indexers in the background…');
    state.view = 'activity';
    render();
  };
  find.onclick = async () => {
    spinnerize(find, true);
    try {
      await startSearch(false);
    } catch (e) {
      spinnerize(find, false);
      if (e.duplicate) {
        modal(`
          <h3>Already in your library</h3>
          <p class="sub">${esc(e.message)} Download it again anyway?</p>
          <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="anyway">Download anyway</button></div>`,
          m => m.querySelector('#anyway').onclick = async () => {
            closeModal();
            try { await startSearch(true); } catch (err) { toast(err.message, false); }
          });
      } else toast(e.message, false);
    }
  };
}

/* ---------------- release picker (from Activity) ---------------- */

function relRow(rel, i) {
  const cls = rel.abb ? 'mid' : rel.seeders >= 5 ? 'good' : rel.seeders >= 1 ? 'mid' : 'low';
  return `
  <div class="rel" style="animation-delay:${Math.min(i * 30, 250)}ms">
    <div style="flex:1;min-width:0">
      <div class="rt">${esc(rel.title)}</div>
      <div class="rm">
        ${rel.preferred ? '<span class="pill" style="color:var(--accent)">★</span>' : ''}
        <span class="pill"><span class="seeds ${cls}">${rel.abb ? '?' : rel.seeders}</span>&nbsp;seeders</span>
        <span class="pill">${fmtSize(rel.size)}</span>
        <span class="pill">${esc(rel.indexer)}</span>
        ${rel.publishDate ? `<span class="pill">${fmtAge(rel.publishDate)}</span>` : ''}
      </div>
    </div>
    <button class="grab" data-i="${i}" title="Download">${IC.down}</button>
  </div>`;
}

function openReleasePicker(item) {
  closeSheets();
  const rels = item.releases || [];
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet">
      <div class="handle"></div>
      <div class="head">
        ${item.cover ? `<img src="${esc(item.cover)}" alt="">` : ''}
        <div>
          <div class="t">${esc(item.title)}</div>
          <div class="a">${esc(item.author)}</div>
          <div class="a" style="margin-top:6px">${rels.length} release${rels.length === 1 ? '' : 's'} found — pick one to download</div>
        </div>
      </div>
      <div class="releases">${rels.map(relRow).join('')}</div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('.sheet-backdrop').onclick = closeSheets;
  wrap.querySelectorAll('.grab').forEach(btn => btn.onclick = async () => {
    wrap.querySelectorAll('.grab').forEach(b => b.disabled = true);
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      await api('/grab', {
        method: 'POST',
        body: {
          book: { asin: item.asin, title: item.title, mediaType: item.mediaType || 'audio', authors: (item.authors && item.authors.length) ? item.authors : [item.author], cover: item.cover },
          release: rels[+btn.dataset.i],
          itemId: item.id
        }
      });
      closeSheets();
      toast('Downloading "' + item.title + '"');
      await refreshQueueBadge();
      paintQueue();
    } catch (e) {
      wrap.querySelectorAll('.grab').forEach(b => b.disabled = false);
      btn.innerHTML = IC.down;
      toast(e.message, false);
    }
  });
}

/* ---------------- activity view ---------------- */

const STATUS_LABEL = { searching: 'Searching indexers…', ready: 'Ready for selection', wanted: 'Wanted — watching your indexers', grabbed: 'Sent — waiting for qBittorrent', downloading: 'Downloading', importing: 'Importing', imported: 'In your library', failed: 'Failed' };

let queueSig = '';

function renderActivity(c) {
  c.innerHTML = `
    <div class="view">
      <div class="h1">Activity</div>
      <div class="seg" style="margin-bottom:12px">
        <button data-am="audio" class="${state.activityMode === 'audio' ? 'active' : ''}">🎧 Audiobooks</button>
        <button data-am="ebook" class="${state.activityMode === 'ebook' ? 'active' : ''}">📖 eBooks</button>
      </div>
      <div id="qbanner"></div><div id="qlist"></div>
    </div>`;
  c.querySelectorAll('.seg button[data-am]').forEach(b => b.onclick = () => {
    if (state.activityMode === b.dataset.am) return;
    state.activityMode = b.dataset.am;
    c.querySelectorAll('.seg button[data-am]').forEach(x => x.classList.toggle('active', x.dataset.am === state.activityMode));
    queueSig = '';
    paintQueue(true);
  });
  queueSig = ''; // force a fresh (animated) first paint
  paintQueue(true);
  const tick = async () => { await refreshQueueBadge(); paintQueue(); };
  tick();
  queueTimer = setInterval(tick, 4000);
}

function paintQueue(firstPaint = false) {
  const el = document.getElementById('qlist');
  if (!el) return;

  const banner = document.getElementById('qbanner');
  if (banner) banner.innerHTML = state.queueWarning ? `<div class="banner">⚠ ${esc(state.queueWarning)}</div>` : '';

  // Structural signature — only rebuild the DOM when items appear/disappear or change status.
  const sig = state.activityMode + '||' + state.queue.map(q => q.id + ':' + q.status + ':' + (q.error || '') + ':' + (q.note || '')).join('|');
  if (sig === queueSig && !firstPaint) {
    // Same structure: update the moving parts in place. No flicker, no jumping.
    for (const q of state.queue) {
      const item = el.querySelector(`.qitem[data-id="${q.id}"]`);
      if (!item) continue;
      const bar = item.querySelector('.bar');
      if (bar) bar.style.width = (q.progress || 0) + '%';
      const pm = item.querySelector('.pmeta');
      if (pm) pm.innerHTML = `<span>${q.progress || 0}%${q.speed ? ' · ' + fmtSpeed(q.speed) : ''}</span><span>${fmtEta(q.eta)}</span>`;
    }
    return;
  }
  queueSig = sig;

  const shown = state.queue.filter(q => (q.mediaType || 'audio') === state.activityMode);
  if (!shown.length) {
    el.innerHTML = `<div class="empty">${IC.activity}<div class="big">Nothing here yet</div>${state.activityMode === 'ebook' ? 'Grab an eBook from Search and it\'ll show up here.' : 'Grab an audiobook from Search and it\'ll show up here.'}</div>`;
    return;
  }
  const anim = firstPaint ? '' : ' noanim';
  const isAdmin = state.user.role === 'admin';
  const tile = q => `
    <div class="qitem${anim}" data-id="${q.id}">
      ${q.cover ? `<img class="cover" src="${esc(q.cover)}" loading="lazy" alt="">` : '<div class="cover"></div>'}
      <div class="body">
        <div class="t">${esc(q.title)}</div>
        <div class="s">${q.mediaType === 'ebook' ? '📖 ' : '🎧 '}${esc(q.author)}${q.requestedBy ? ' · added by ' + esc(q.requestedBy) : ''}</div>
        <div style="margin-top:7px"><span class="statuschip st-${q.status}"><span class="dot"></span>${STATUS_LABEL[q.status] || q.status}</span></div>
        ${q.status === 'searching' ? '<div class="ibar" style="margin-top:10px"></div>' : ''}
        ${q.status === 'wanted' ? '<div class="s" style="margin-top:6px">No releases yet — Librarian re-checks twice a day and will grab or flag it when one appears.</div>' : ''}
        ${q.status === 'downloading' ? `
          <div class="progress"><div class="bar" style="width:${q.progress || 0}%"></div></div>
          <div class="pmeta"><span>${q.progress || 0}%${q.speed ? ' · ' + fmtSpeed(q.speed) : ''}</span><span>${fmtEta(q.eta)}</span></div>` : ''}
        ${q.status === 'failed' && q.error ? `<div class="err">${esc(q.error)}</div>` : ''}
        ${q.note ? `<div class="note">${esc(q.note)}</div>` : ''}
        <div class="actions">
          ${q.status === 'ready' ? `<button class="btn small" data-act="choose">Choose release</button>` : ''}
          ${q.status === 'failed' ? `<button class="btn small" data-act="retry">Retry</button>` : ''}
          ${q.status === 'wanted' ? `<button class="btn small ghost" data-act="retry">Search now</button>` : ''}
          ${q.status === 'imported' && q.ebookFile ? `<button class="btn small ghost" data-act="kindle">Send to Kindle</button>` : ''}
          ${isAdmin && q.status !== 'searching' ? `<button class="btn small ghost" data-act="remove">Remove</button>` : ''}
        </div>
      </div>
    </div>`;
  el.innerHTML = shown.map(tile).join('');
  el.querySelectorAll('[data-act]').forEach(btn => {
    const id = btn.closest('.qitem').dataset.id;
    const item = state.queue.find(q => q.id === id);
    btn.onclick = async () => {
      if (btn.dataset.act === 'choose') openReleasePicker(item);
      else if (btn.dataset.act === 'retry') retryItem(id, btn);
      else if (btn.dataset.act === 'kindle') {
        spinnerize(btn, true);
        try {
          await api('/queue/' + id + '/send-kindle', { method: 'POST' });
          toast('On its way to your Kindle');
        } catch (e) { toast(e.message, false); }
        await refreshQueueBadge(); paintQueue();
      }
      else confirmRemove(item);
    };
  });
}

async function retryItem(id, btn) {
  spinnerize(btn, true);
  try { await api('/queue/' + id + '/retry', { method: 'POST' }); toast('On it…'); }
  catch (e) { toast(e.message, false); }
  await refreshQueueBadge(); paintQueue();
}

function confirmRemove(item) {
  const active = ['grabbed', 'downloading', 'importing'].includes(item.status);
  modal(`
    <h3>Remove "${esc(item.title)}"?</h3>
    <p class="sub">${active ? 'This download is still in progress.' : 'This removes it from the Activity list.'}</p>
    ${item.hash ? `
      <label class="checkrow"><input type="checkbox" id="rmT" ${active ? 'checked' : ''}> Also remove the torrent from qBittorrent</label>
      <label class="checkrow"><input type="checkbox" id="rmF"> …and delete its downloaded files</label>` : ''}
    <div class="row">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn danger" id="doRm">Remove</button>
    </div>`, m => {
    m.querySelector('#doRm').onclick = async () => {
      const rmT = m.querySelector('#rmT')?.checked ? 1 : 0;
      const rmF = m.querySelector('#rmF')?.checked ? 1 : 0;
      try {
        await api(`/queue/${item.id}?removeTorrent=${rmT}&deleteFiles=${rmF}`, { method: 'DELETE' });
        toast('Removed');
      } catch (e) { toast(e.message, false); }
      closeModal();
      await refreshQueueBadge(); paintQueue();
    };
  });
}

/* ---------------- settings ---------------- */

function renderSettings(c) {
  const isAdmin = state.user.role === 'admin';
  const tabs = isAdmin
    ? [['connections', 'Connections'], ['paths', 'Paths'], ['users', 'Users'], ['profile', 'Profile']]
    : [['profile', 'Profile']];
  if (!tabs.some(t => t[0] === state.settingsTab)) state.settingsTab = tabs[0][0];
  c.innerHTML = `
    <div class="view">
      <div class="h1">Settings</div>
      <div class="seg">${tabs.map(t => `<button data-t="${t[0]}" class="${state.settingsTab === t[0] ? 'active' : ''}">${t[1]}</button>`).join('')}</div>
      <div id="tabbody"></div>
    </div>`;
  c.querySelectorAll('.seg button').forEach(b => b.onclick = () => { state.settingsTab = b.dataset.t; renderSettings(c); });
  const body = document.getElementById('tabbody');
  if (state.settingsTab === 'profile') return renderProfile(body);
  if (state.settingsTab === 'users') return renderUsers(body);
  loadSettingsThen(() => {
    if (state.settingsTab === 'connections') renderConnections(body);
    else renderPaths(body);
  }, body);
}

async function loadSettingsThen(fn, body) {
  if (state.settings) return fn();
  body.innerHTML = '<div class="sk"></div>';
  try { state.settings = await api('/settings'); fn(); }
  catch (e) { body.innerHTML = ''; toast(e.message, false); }
}

function connCard(id, title, hint, fields, testSvc) {
  return `
  <div class="card" data-svc="${id}">
    <h3>${title}</h3>
    <p class="hint">${hint}</p>
    ${fields}
    <div class="inputrow" style="margin-top:4px">
      <button class="btn ghost small" data-test="${testSvc}">Test connection</button>
    </div>
    <div class="testresult" id="tr-${id}"></div>
  </div>`;
}

function renderConnections(body) {
  const s = state.settings;
  const secretPh = v => v === '__KEEP__' ? '••••••••  (saved)' : '';
  body.innerHTML = `
    <div class="card">
      <h3>Auto-detect services</h3>
      <p class="hint">Librarian can scan this server for qBittorrent, Prowlarr, and AudioBookShelf on their usual ports and fill in the URLs for you.</p>
      <button class="btn small" id="disc">Scan for services</button>
      <div class="discover-found" id="discout"></div>
    </div>

    ${connCard('qbit', 'qBittorrent', 'The download client. Username and password are the same ones you use for its web UI.', `
      <div class="field"><label>URL</label><input class="input" id="qb-url" placeholder="http://192.168.1.10:8080" value="${esc(s.qbit.url)}"></div>
      <div class="field"><label>Username</label><input class="input" id="qb-user" value="${esc(s.qbit.username)}" autocapitalize="off"></div>
      <div class="field"><label>Password</label><input class="input" id="qb-pass" type="password" placeholder="${secretPh(s.qbit.password)}"></div>
      <div class="field"><label>Category</label><input class="input" id="qb-cat" value="${esc(s.qbit.category || 'librarian')}"></div>
    `, 'qbit')}

    ${connCard('abb', 'AudioBookBay (built-in)', 'Librarian searches AudioBookBay directly — no Prowlarr indexer needed. It\'s tried FIRST for every audiobook; Prowlarr is the fallback when it finds nothing. If the site stops responding, swap in a mirror URL (audiobookbay.lu / audiobookbay.is).', `
      <label class="checkrow" style="margin:0 0 12px"><input type="checkbox" id="bb-en" ${s.abb?.enabled !== false ? 'checked' : ''}> Search AudioBookBay first for audiobooks</label>
      <div class="field"><label>Site URL</label><input class="input" id="bb-url" placeholder="https://audiobookbay.lu" value="${esc(s.abb?.url || 'https://audiobookbay.lu')}"></div>
    `, 'abb')}

    ${connCard('prowlarr', 'Prowlarr', 'Your indexer hub. Find the API key in Prowlarr under Settings → General → API Key.', `
      <div class="field"><label>URL</label><input class="input" id="pr-url" placeholder="http://192.168.1.10:9696" value="${esc(s.prowlarr.url)}"></div>
      <div class="field"><label>API key</label><input class="input" id="pr-key" type="password" placeholder="${secretPh(s.prowlarr.apiKey)}"></div>
      <div class="field"><label>Preferred indexers (optional)</label><input class="input" id="pr-pref" placeholder="AudioBookBay, MyAnonamouse" value="${esc(s.prowlarr.preferred || '')}"></div>
      <p class="hint" style="margin-top:-4px">Comma-separated indexer names (as shown in Prowlarr). Their releases are listed first (★) and win auto-pick.</p>
    `, 'prowlarr')}

    ${connCard('notify', 'Notifications (optional)', 'Get a push when a book is imported, fails, or is ready for selection. Paste an ntfy topic URL (e.g. https://ntfy.sh/my-librarian), a Discord webhook URL, or a Gotify message URL.', `
      <div class="field"><label>Notification URL</label><input class="input" id="nt-url" placeholder="https://ntfy.sh/your-topic" value="${esc(s.notify?.url || '')}"></div>
    `, 'notify')}

    ${connCard('smtp', 'Email / Send-to-Kindle (optional)', 'Needed to email eBooks to Kindles. Use any SMTP account (a Gmail app-password works). IMPORTANT: Amazon only accepts documents from approved senders — each Kindle owner must add the "From" address below at amazon.com → Content Library → Preferences → Approved Personal Document E-mail List.', `
      <div class="field"><label>SMTP server</label><input class="input" id="sm-host" placeholder="smtp.gmail.com" value="${esc(s.smtp?.host || '')}"></div>
      <div class="field"><label>Port</label><input class="input" id="sm-port" placeholder="587" value="${esc(s.smtp?.port || '587')}"></div>
      <div class="field"><label>Username</label><input class="input" id="sm-user" autocapitalize="off" value="${esc(s.smtp?.user || '')}"></div>
      <div class="field"><label>Password</label><input class="input" id="sm-pass" type="password" placeholder="${secretPh(s.smtp?.pass)}"></div>
      <div class="field"><label>From address (must be Kindle-approved)</label><input class="input" id="sm-from" placeholder="you@example.com" value="${esc(s.smtp?.from || '')}"></div>
    `, 'smtp')}

    ${connCard('abs', 'AudioBookShelf', 'Your library server. Get an API token in AudioBookShelf under Settings → Users → your user → API Token.', `
      <div class="field"><label>URL</label><input class="input" id="ab-url" placeholder="http://192.168.1.10:13378" value="${esc(s.abs.url)}"></div>
      <div class="field"><label>API token</label><input class="input" id="ab-key" type="password" placeholder="${secretPh(s.abs.apiKey)}"></div>
      <div class="field"><label>Library</label>
        <div class="inputrow">
          <select class="input" id="ab-lib">${s.abs.libraryId ? `<option value="${esc(s.abs.libraryId)}">${esc(s.abs.libraryName || s.abs.libraryId)}</option>` : '<option value="">— load libraries →</option>'}</select>
          <button class="btn ghost small" id="ab-load" style="flex:none">Load</button>
        </div>
      </div>
    `, 'abs')}

    <button class="btn block" id="saveConn">Save connections</button>`;

  const grabCfg = svc => {
    if (svc === 'notify') return { url: body.querySelector('#nt-url').value.trim() };
    if (svc === 'abb') return {
      enabled: body.querySelector('#bb-en').checked,
      url: body.querySelector('#bb-url').value.trim() || 'https://audiobookbay.lu'
    };
    if (svc === 'smtp') return {
      host: body.querySelector('#sm-host').value.trim(),
      port: body.querySelector('#sm-port').value.trim() || '587',
      user: body.querySelector('#sm-user').value.trim(),
      pass: body.querySelector('#sm-pass').value || (s.smtp?.pass ? '__KEEP__' : ''),
      from: body.querySelector('#sm-from').value.trim()
    };
    if (svc === 'qbit') return {
      url: body.querySelector('#qb-url').value.trim(),
      username: body.querySelector('#qb-user').value.trim(),
      password: body.querySelector('#qb-pass').value || (s.qbit.password ? '__KEEP__' : ''),
      category: body.querySelector('#qb-cat').value.trim() || 'librarian'
    };
    if (svc === 'prowlarr') return {
      url: body.querySelector('#pr-url').value.trim(),
      apiKey: body.querySelector('#pr-key').value || (s.prowlarr.apiKey ? '__KEEP__' : ''),
      preferred: body.querySelector('#pr-pref').value.trim()
    };
    const sel = body.querySelector('#ab-lib');
    return {
      url: body.querySelector('#ab-url').value.trim(),
      apiKey: body.querySelector('#ab-key').value || (s.abs.apiKey ? '__KEEP__' : ''),
      libraryId: sel.value,
      libraryName: sel.selectedOptions[0]?.textContent || ''
    };
  };

  body.querySelectorAll('[data-test]').forEach(btn => btn.onclick = async () => {
    const svc = btn.dataset.test;
    const out = body.querySelector('#tr-' + svc);
    out.className = 'testresult';
    spinnerize(btn, true);
    try {
      const r = await api('/settings/test/' + svc, { method: 'POST', body: grabCfg(svc) });
      out.textContent = '✓ ' + r.detail; out.className = 'testresult ok';
    } catch (e) {
      out.textContent = '✕ ' + e.message; out.className = 'testresult err';
    }
    spinnerize(btn, false);
  });

  body.querySelector('#ab-load').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    try {
      const libs = await api('/abs/libraries', { method: 'POST', body: grabCfg('abs') });
      const sel = body.querySelector('#ab-lib');
      const books = libs.filter(l => l.mediaType === 'book');
      sel.innerHTML = (books.length ? books : libs).map(l => `<option value="${esc(l.id)}" ${l.id === s.abs.libraryId ? 'selected' : ''}>${esc(l.name)}</option>`).join('') || '<option value="">No libraries found</option>';
      toast('Libraries loaded — pick one and save');
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };

  body.querySelector('#disc').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    const out = body.querySelector('#discout');
    try {
      const found = await api('/settings/discover', { method: 'POST', body: { host: location.hostname } });
      const rows = [];
      if (found.qbit) { body.querySelector('#qb-url').value = found.qbit.url; rows.push('qBittorrent at ' + found.qbit.url); }
      if (found.prowlarr) { body.querySelector('#pr-url').value = found.prowlarr.url; rows.push('Prowlarr at ' + found.prowlarr.url); }
      if (found.abs) { body.querySelector('#ab-url').value = found.abs.url; rows.push('AudioBookShelf at ' + found.abs.url); }
      out.innerHTML = rows.length
        ? rows.map(r => `<div class="row"><span class="ok">✓</span> ${esc(r)} — URL filled in below</div>`).join('')
        : '<div class="row">Nothing found on the usual ports. If services run on another host or port, enter their URLs manually.</div>';
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };

  body.querySelector('#saveConn').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    try {
      state.settings = await api('/settings', {
        method: 'PUT',
        body: { qbit: grabCfg('qbit'), prowlarr: grabCfg('prowlarr'), abb: grabCfg('abb'), abs: grabCfg('abs'), notify: grabCfg('notify'), smtp: grabCfg('smtp') }
      });
      toast('Connections saved');
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };
}

function renderPaths(body) {
  const s = state.settings;
  body.innerHTML = `
    <div class="card">
      <h3>Audiobook library</h3>
      <p class="hint">Where finished books go, organized as Author/Title. This should be the same folder AudioBookShelf reads (mounted at /audiobooks in the Librarian container).</p>
      <div class="field"><label>Library folder</label>
        <div class="pathrow">
          <input class="input" id="p-lib" value="${esc(s.paths.library)}">
          <button class="btn ghost small" data-browse="p-lib" style="flex:none">${IC.folder} Browse</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>eBook library</h3>
      <p class="hint">Where finished eBooks go, organized as Author/Title (mounted at /ebooks in the Librarian container).</p>
      <div class="field"><label>eBook folder</label>
        <div class="pathrow">
          <input class="input" id="p-ebooks" value="${esc(s.paths.ebooks || '/ebooks')}">
          <button class="btn ghost small" data-browse="p-ebooks" style="flex:none">${IC.folder} Browse</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Remote path mapping</h3>
      <p class="hint">Only needed if qBittorrent reports a different path than Librarian sees. Example: qBittorrent says "/data/torrents" but the same files appear here as "/downloads" — enter both and Librarian translates automatically. Leave blank if both containers mount downloads at the same path.</p>
      <div class="field"><label>Path in qBittorrent</label>
        <input class="input" id="p-remote" placeholder="/data/torrents" value="${esc(s.pathMap.remote)}"></div>
      <div class="field"><label>Same folder in Librarian</label>
        <div class="pathrow">
          <input class="input" id="p-local" placeholder="/downloads" value="${esc(s.pathMap.local)}">
          <button class="btn ghost small" data-browse="p-local" style="flex:none">${IC.folder} Browse</button>
        </div>
      </div>
    </div>
    <button class="btn block" id="savePaths">Save paths</button>`;

  body.querySelectorAll('[data-browse]').forEach(btn => btn.onclick = () => {
    const input = body.querySelector('#' + btn.dataset.browse);
    openBrowser(input.value || '/', p => { input.value = p; });
  });

  body.querySelector('#savePaths').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    try {
      state.settings = await api('/settings', {
        method: 'PUT',
        body: {
          paths: {
            library: body.querySelector('#p-lib').value.trim() || '/audiobooks',
            ebooks: body.querySelector('#p-ebooks').value.trim() || '/ebooks'
          },
          pathMap: { remote: body.querySelector('#p-remote').value.trim(), local: body.querySelector('#p-local').value.trim() }
        }
      });
      toast('Paths saved');
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };
}

function openBrowser(startPath, onPick) {
  modal(`
    <h3>Choose a folder</h3>
    <div class="browser">
      <div class="cur" id="bp"></div>
      <div class="list" id="bl"></div>
    </div>
    <div class="row">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn" id="pick">Use this folder</button>
    </div>`, async m => {
    let cur = startPath;
    const load = async p => {
      try {
        const r = await api('/fs/browse?path=' + encodeURIComponent(p));
        cur = r.path;
        m.querySelector('#bp').textContent = r.path + (r.exists ? (r.writable ? '' : '  (read-only)') : '  (doesn\'t exist)');
        const rows = [];
        if (r.parent) rows.push(`<button class="dir" data-p="${esc(r.parent)}">${IC.folder} ..</button>`);
        rows.push(...r.dirs.map(d => `<button class="dir" data-p="${esc(d.path)}">${IC.folder} ${esc(d.name)}</button>`));
        m.querySelector('#bl').innerHTML = rows.join('') || '<div class="none">No subfolders</div>';
        m.querySelectorAll('.dir').forEach(b => b.onclick = () => load(b.dataset.p));
      } catch (e) { toast(e.message, false); }
    };
    await load(cur);
    m.querySelector('#pick').onclick = () => { onPick(cur); closeModal(); };
  });
}

/* ---------------- users tab ---------------- */

async function renderUsers(body) {
  body.innerHTML = '<div class="sk"></div>';
  try { state.users = await api('/users'); }
  catch (e) { body.innerHTML = ''; return toast(e.message, false); }
  body.innerHTML = `
    <div class="card">
      <h3>Accounts</h3>
      <p class="hint">Each person gets their own login. New users set up their authenticator app the first time they sign in.</p>
      <div id="ulist">${state.users.map(u => `
        <div class="userrow" data-id="${u.id}">
          <div class="avatar">${esc(u.username[0].toUpperCase())}</div>
          <div>
            <div class="un">${esc(u.username)}${u.id === state.user.id ? ' <span class="sub">(you)</span>' : ''}</div>
            <div class="um"><span class="pill">${u.role}</span>${u.hasMfa ? '<span class="pill" style="color:var(--good)">MFA on</span>' : '<span class="pill" style="color:var(--warn)">MFA pending</span>'}${u.autoPick ? '<span class="pill" style="color:var(--accent)">Auto-pick</span>' : ''}</div>
          </div>
          <div class="spacer"></div>
          <button class="iconbtn ${u.autoPick ? '' : ''}" data-act="auto" title="${u.autoPick ? 'Disable' : 'Enable'} auto-pick" ${u.autoPick ? 'style="color:var(--accent)"' : ''}>${IC.zap}</button>
          <button class="iconbtn" data-act="pw" title="Set password">${IC.key}</button>
          <button class="iconbtn" data-act="mfa" title="Reset MFA">${IC.shield}</button>
          ${u.id !== state.user.id ? `<button class="iconbtn danger" data-act="del" title="Delete">${IC.trash}</button>` : ''}
        </div>`).join('')}
      </div>
      <button class="btn small" id="addUser" style="margin-top:14px">Add user</button>
    </div>`;

  body.querySelector('#addUser').onclick = () => modal(`
    <h3>Add a user</h3>
    <p class="sub">Give them the username and temporary password — they'll scan a QR code for MFA on first sign-in.</p>
    <div class="field"><label>Username</label><input class="input" id="nu" autocapitalize="off"></div>
    <div class="field"><label>Temporary password</label><input class="input" id="np" placeholder="At least 8 characters"></div>
    <div class="field"><label>Role</label><select class="input" id="nr"><option value="user">User</option><option value="admin">Admin</option></select></div>
    <label class="checkrow"><input type="checkbox" id="nap" checked> Auto-pick: skip the release list and download the best match automatically</label>
    <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="mk">Create</button></div>`,
    m => {
      m.querySelector('#mk').onclick = async () => {
        try {
          await api('/users', { method: 'POST', body: { username: m.querySelector('#nu').value.trim(), password: m.querySelector('#np').value, role: m.querySelector('#nr').value, autoPick: m.querySelector('#nap').checked } });
          toast('User created');
          closeModal(); renderUsers(body);
        } catch (e) { toast(e.message, false); }
      };
    });

  body.querySelectorAll('.userrow .iconbtn').forEach(btn => {
    const id = btn.closest('.userrow').dataset.id;
    const u = state.users.find(x => x.id === id);
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'auto') {
        api('/users/' + id + '/autopick', { method: 'POST', body: { enabled: !u.autoPick } })
          .then(() => { toast(u.autoPick ? 'Auto-pick disabled for ' + u.username : 'Auto-pick enabled — ' + u.username + '\'s downloads start automatically'); renderUsers(body); })
          .catch(e => toast(e.message, false));
        return;
      }
      if (act === 'del') modal(`
        <h3>Delete ${esc(u.username)}?</h3><p class="sub">They won't be able to sign in anymore. Their download history stays.</p>
        <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="ok">Delete</button></div>`,
        m => m.querySelector('#ok').onclick = async () => {
          try { await api('/users/' + id, { method: 'DELETE' }); toast('User deleted'); } catch (e) { toast(e.message, false); }
          closeModal(); renderUsers(body);
        });
      else if (act === 'mfa') modal(`
        <h3>Reset MFA for ${esc(u.username)}?</h3><p class="sub">They'll be signed out and asked to scan a new QR code next time they log in. Use this if they lost their phone.</p>
        <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ok">Reset MFA</button></div>`,
        m => m.querySelector('#ok').onclick = async () => {
          try { await api('/users/' + id + '/reset-mfa', { method: 'POST' }); toast('MFA reset'); } catch (e) { toast(e.message, false); }
          closeModal(); renderUsers(body);
        });
      else modal(`
        <h3>Set password for ${esc(u.username)}</h3>
        <div class="field"><label>New password</label><input class="input" id="pw" placeholder="At least 8 characters"></div>
        <div class="row"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ok">Set password</button></div>`,
        m => m.querySelector('#ok').onclick = async () => {
          try { await api('/users/' + id + '/password', { method: 'POST', body: { password: m.querySelector('#pw').value } }); toast('Password updated'); closeModal(); }
          catch (e) { toast(e.message, false); }
        });
    };
  });
}

/* ---------------- profile tab ---------------- */

function renderProfile(body) {
  body.innerHTML = `
    <div class="card">
      <h3>${esc(state.user.username)}</h3>
      <p class="hint">Signed in as ${state.user.role}.</p>
      <label class="checkrow" style="margin:0 0 16px"><input type="checkbox" id="ap" ${state.user.autoPick ? 'checked' : ''}> Auto-pick: when I hit "Find releases", download the best match automatically</label>
      <div class="field"><label>Current password</label><input class="input" id="cp" type="password" autocomplete="current-password"></div>
      <div class="field"><label>New password</label><input class="input" id="npw" type="password" autocomplete="new-password" placeholder="At least 8 characters"></div>
      <button class="btn small" id="chpw">Change password</button>
    </div>
    <div class="card">
      <h3>Kindle</h3>
      <p class="hint">eBooks can be emailed straight to your Kindle. Find your @kindle.com address at amazon.com → Content Library → Preferences → Personal Document Settings — and make sure Librarian's "From" address (set by the admin under Connections) is on your Approved Senders list there.</p>
      <div class="field"><label>Your Kindle email</label><input class="input" id="ke" type="email" autocapitalize="off" placeholder="yourname_123@kindle.com" value="${esc(state.user.kindleEmail || '')}"></div>
      <label class="checkrow"><input type="checkbox" id="kauto" ${state.user.autoSendKindle ? 'checked' : ''}> Automatically send my eBooks to this Kindle when they finish</label>
      <button class="btn small" id="ksave" style="margin-top:12px">Save Kindle settings</button>
    </div>
    <button class="btn ghost block" id="out">Sign out</button>`;
  body.querySelector('#ksave').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    try {
      const r = await api('/me/kindle', {
        method: 'POST',
        body: { kindleEmail: body.querySelector('#ke').value.trim(), autoSendKindle: body.querySelector('#kauto').checked }
      });
      state.user.kindleEmail = r.kindleEmail;
      state.user.autoSendKindle = r.autoSendKindle;
      toast(r.autoSendKindle ? 'Saved — new eBooks will land on your Kindle automatically' : 'Kindle settings saved');
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };
  body.querySelector('#ap').onchange = async e => {
    try {
      const r = await api('/me/autopick', { method: 'POST', body: { enabled: e.target.checked } });
      state.user.autoPick = r.autoPick;
      toast(r.autoPick ? 'Auto-pick on — your downloads start automatically' : 'Auto-pick off — you\'ll choose releases yourself');
    } catch (err) { toast(err.message, false); e.target.checked = !e.target.checked; }
  };
  body.querySelector('#chpw').onclick = async e => {
    const btn = e.currentTarget;
    spinnerize(btn, true);
    try {
      await api('/me/password', { method: 'POST', body: { current: body.querySelector('#cp').value, password: body.querySelector('#npw').value } });
      toast('Password changed');
      body.querySelector('#cp').value = ''; body.querySelector('#npw').value = '';
    } catch (err) { toast(err.message, false); }
    spinnerize(btn, false);
  };
  body.querySelector('#out').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => { });
    state.user = null; state.settings = null;
    render();
  };
}

/* ---------------- modal helper ---------------- */

function closeModal() { document.querySelectorAll('.modal-backdrop').forEach(e => e.remove()); }
function modal(html, setup) {
  closeModal();
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) closeModal(); });
  document.body.appendChild(wrap);
  const m = wrap.querySelector('.modal');
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
  if (setup) setup(m);
}

/* back button closes sheets/modals on mobile */
window.addEventListener('popstate', () => { closeSheets(); closeModal(); });

boot();
