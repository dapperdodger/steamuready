/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  devices:   [],
  perfScales: [],
  games:     [],
  total:     0,
  page:      1,
  totalPages:0,
  loading:   false,
  loaded:    false,

  filters: {
    deviceIds:     [],
    performanceId: '',
    minPrice:      '',
    maxPrice:      '',
    minDiscount:   0,
    search:        '',
    sort:          'discount_desc',
    cc:            'us',
  },
};

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  progressBar:  $('progressBar'),
  statusDot:    $('statusDot'),
  cacheLabel:   $('cacheLabel'),
  refreshBtn:   $('refreshBtn'),
  deviceSearch:       $('deviceSearch'),       // text input for filtering
  deviceDropdown:     $('deviceDropdown'),     // dropdown list
  deviceChips:        $('deviceChips'),        // selected device chips container
  compatList:   $('compatList'),
  minPrice:     $('minPrice'),
  maxPrice:     $('maxPrice'),
  searchInput:  $('searchInput'),
  applyBtn:     $('applyBtn'),
  resetBtn:     $('resetBtn'),
  sortSelect:   $('sortSelect'),
  regionSelect: $('regionSelect'),
  regionNote:   $('regionNote'),
  resultsCount: $('resultsCount'),
  gamesGrid:    $('gamesGrid'),
  pagination:   $('pagination'),
};

/* ── API ───────────────────────────────────────────────────────────────────── */
const api = {
  async json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  devices()       { return api.json('/api/devices'); },
  perfScales()    { return api.json('/api/performance-scales'); },
  regions()       { return api.json('/api/regions'); },
  games(params)   {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) q.set(k, v); });
    return api.json(`/api/games?${q}`);
  },
  refresh()       { return fetch('/api/refresh', { method: 'POST' }).then(r => r.json()); },
};

/* ── Progress ──────────────────────────────────────────────────────────────── */
function progress(pct) {
  el.progressBar.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => { el.progressBar.style.width = '0'; }, 400);
}

/* ── Compat color helper ───────────────────────────────────────────────────── */
// EmuReady: rank 1=Perfect(best) → rank 8=Nothing(worst)
function compatClass(rank) {
  if (!rank) return '0';
  if (rank <= 1) return '5'; // Perfect
  if (rank <= 2) return '4'; // Great
  if (rank <= 3) return '3'; // Playable
  if (rank <= 5) return '2'; // Poor / Ingame
  return '1';                 // Intro / Loadable / Nothing
}

/* ── Init ──────────────────────────────────────────────────────────────────── */
async function init() {
  progress(10);
  el.statusDot.className = 'status-dot';
  el.cacheLabel.textContent = t('loading');

  showSkeletons();

  try {
    // Devices + perf scales + regions in parallel
    const [devices, scales, regions] = await Promise.all([
      api.devices().catch(() => []),
      api.perfScales().catch(() => []),
      api.regions().catch(() => ({})),
    ]);

    state.devices    = devices;
    state.perfScales = scales;

    populateDevices(devices);
    populateCompatList(scales);
    populateRegions(regions);

    el.statusDot.className = 'status-dot ok';
    el.cacheLabel.textContent = '';

    progress(40);
    await fetchGames();
  } catch (e) {
    el.statusDot.className = 'status-dot err';
    el.cacheLabel.textContent = t('apiError');
    showError(e.message);
    progress(100);
  }
}

/* ── Device combobox — multi-select with chips ───────────────────────────────── */
let _deviceFocusIdx = -1;
const _selectedDevices = new Map(); // id → {id, name}

function populateDevices(devices) {
  state.devices = devices;
  el.deviceSearch.addEventListener('input', onDeviceInput);
  el.deviceSearch.addEventListener('focus', onDeviceInput);
  el.deviceSearch.addEventListener('keydown', onDeviceKey);
  document.addEventListener('click', e => {
    if (!e.target.closest('#deviceCombo')) closeDropdown();
  });
}

function onDeviceInput() {
  const q = el.deviceSearch.value.trim().toLowerCase();
  const matches = q
    ? state.devices.filter(d => d.name.toLowerCase().includes(q) && !_selectedDevices.has(d.id)).slice(0, 60)
    : state.devices.filter(d => !_selectedDevices.has(d.id)).slice(0, 60);
  renderDropdown(matches, q);
}

function renderDropdown(devices, q = '') {
  el.deviceDropdown.innerHTML = '';
  _deviceFocusIdx = -1;
  if (!devices.length) {
    el.deviceDropdown.innerHTML = `<div class="device-opt-empty">${t('deviceNoResults')}</div>`;
  } else {
    devices.forEach(d => {
      const div = document.createElement('div');
      div.className = 'device-opt';
      div.dataset.id = d.id;
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      div.innerHTML = q ? d.name.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>') : d.name;
      div.addEventListener('mousedown', e => { e.preventDefault(); addDevice(d); });
      el.deviceDropdown.appendChild(div);
    });
  }
  el.deviceDropdown.hidden = false;
}

function closeDropdown() {
  el.deviceDropdown.hidden = true;
  _deviceFocusIdx = -1;
}

function addDevice(d) {
  if (_selectedDevices.has(d.id)) return;
  _selectedDevices.set(d.id, d);
  el.deviceSearch.value = '';
  renderChips();
  closeDropdown();
}

function removeDevice(id) {
  _selectedDevices.delete(id);
  renderChips();
}

function renderChips() {
  el.deviceChips.innerHTML = '';
  _selectedDevices.forEach(d => {
    const chip = document.createElement('div');
    chip.className = 'device-chip';
    chip.dataset.id = d.id;
    chip.innerHTML = `<span title="${escHtml(d.name)}">${escHtml(d.name)}</span><button type="button" title="${t('deviceRemove')}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => removeDevice(d.id));
    el.deviceChips.appendChild(chip);
  });
  el.deviceSearch.placeholder = t(_selectedDevices.size ? 'deviceAddPlaceholder' : 'deviceSearchPlaceholder');
}

function clearAllDevices() {
  _selectedDevices.clear();
  renderChips();
}

function onDeviceKey(e) {
  const opts = [...el.deviceDropdown.querySelectorAll('.device-opt')];
  if (e.key === 'Escape') { closeDropdown(); return; }
  if (!opts.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _deviceFocusIdx = Math.min(_deviceFocusIdx + 1, opts.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _deviceFocusIdx = Math.max(_deviceFocusIdx - 1, 0);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (_deviceFocusIdx >= 0) {
      const id = opts[_deviceFocusIdx].dataset.id;
      const d = state.devices.find(x => x.id === id);
      if (d) addDevice(d);
    }
    return;
  } else { return; }
  opts.forEach((o, i) => o.classList.toggle('focused', i === _deviceFocusIdx));
  opts[_deviceFocusIdx]?.scrollIntoView({ block: 'nearest' });
}

/* ── Populate region select ──────────────────────────────────────────────────── */
function populateRegions(regions) {
  el.regionSelect.innerHTML = '';
  Object.entries(regions).forEach(([cc, info]) => {
    const opt = document.createElement('option');
    opt.value = cc;
    opt.textContent = info.label;
    el.regionSelect.appendChild(opt);
  });
  el.regionSelect.value = 'us';
  updateRegionNote();

  el.regionSelect.addEventListener('change', () => {
    updateRegionNote();
    fetchGames(true);
  });
}

function updateRegionNote() {
  const cc = el.regionSelect.value;
  const notes = {
    us: '', fr: '', gb: '', de: '',
    ca: '',
    au: '',
    br: t('regionNoteBR'),
    tr: t('regionNoteTR'),
    ar: t('regionNoteAR'),
    pl: '',
  };
  el.regionNote.textContent = notes[cc] || '';
}

/* ── Populate compat radio list ─────────────────────────────────────────────── */
function populateCompatList(scales) {
  el.compatList.innerHTML = `
    <label class="compat-item selected" data-value="">
      <input type="radio" name="compat" value="" checked />
      <span class="compat-dot dot-0"></span>
      <span class="compat-label-text" data-i18n="compatAll">${t('compatAll')}</span>
    </label>`;

  // Sort by rank ascending: rank 1 (Perfect) first
  const sorted = [...scales].sort((a, b) =>
    (a.rank ?? a.position ?? 99) - (b.rank ?? b.position ?? 99)
  );

  sorted.forEach(s => {
    const rank = s.rank ?? s.position ?? 0;
    const cls  = compatClass(rank);
    const lbl  = document.createElement('label');
    lbl.className = 'compat-item';
    lbl.dataset.value = s.id;
    lbl.innerHTML = `
      <input type="radio" name="compat" value="${s.id}" />
      <span class="compat-dot dot-${cls}"></span>
      <span class="compat-label-text">${s.label ?? s.description ?? `Rank ${rank}`}</span>`;
    el.compatList.appendChild(lbl);
  });

  // Click on row = select radio
  el.compatList.querySelectorAll('.compat-item').forEach(item => {
    item.addEventListener('click', () => {
      el.compatList.querySelectorAll('.compat-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      item.querySelector('input').checked = true;
    });
  });
}

/* ── Fetch & render games ───────────────────────────────────────────────────── */
async function fetchGames(resetPage = true) {
  if (state.loading) return;
  state.loading = true;

  if (resetPage) state.page = 1;

  readFilters();

  const params = {
    deviceIds:     state.filters.deviceIds.join(',') || '',
    performanceId: state.filters.performanceId,
    minPrice:      state.filters.minPrice,
    maxPrice:      state.filters.maxPrice,
    minDiscount:   state.filters.minDiscount || '',
    search:        state.filters.search,
    sort:          state.filters.sort,
    cc:            state.filters.cc,
    page:          state.page,
  };

  // UX: show skeletons while loading
  if (!state.loaded) showSkeletons();
  progress(30);

  try {
    const data = await api.games(params);
    progress(90);

    state.games      = data.games    ?? [];
    state.total      = data.total    ?? 0;
    state.totalPages = data.totalPages ?? 1;
    state.loaded     = true;

    renderGames();
    renderPagination();
    updateCount();

    progress(100);
  } catch (e) {
    console.error(e);
    showError(e.message);
    progress(100);
  } finally {
    state.loading = false;
  }
}

/* ── Read current filter values from DOM ────────────────────────────────────── */
function readFilters() {
  // deviceIds: array of selected device IDs (multi-select)
  state.filters.deviceIds    = [...document.querySelectorAll('.device-chip')].map(c => c.dataset.id);
  state.filters.performanceId = el.compatList.querySelector('input:checked')?.value ?? '';
  state.filters.minPrice      = el.minPrice.value;
  state.filters.maxPrice      = el.maxPrice.value;
  state.filters.search        = el.searchInput.value.trim();
  state.filters.sort          = el.sortSelect.value;
  state.filters.cc            = el.regionSelect?.value || 'us';

  const activeDisc = document.querySelector('.disc-btn.active');
  state.filters.minDiscount = activeDisc ? parseInt(activeDisc.dataset.value) : 0;
}

/* ── Render game cards ──────────────────────────────────────────────────────── */
function renderGames() {
  el.gamesGrid.innerHTML = '';

  if (!state.games.length) {
    el.gamesGrid.innerHTML = `
      <div class="state-box">
        <div class="icon">🎮</div>
        <h3>${t('noGamesTitle')}</h3>
        <p>${t('noGamesMsg')}</p>
      </div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  state.games.forEach(g => {
    frag.appendChild(buildCard(g));
  });
  el.gamesGrid.appendChild(frag);
}

function buildCard(g) {
  const cls    = compatClass(g.performanceRank);
  const label  = g.performanceLabel || (g.performanceRank ? t('rankLabel')(g.performanceRank) : '?');

  const div = document.createElement('div');
  div.className = 'card';

  // Notes tooltip
  const notesAttr = g.notes ? ` title="${escHtml(g.notes)}" class="has-notes"` : '';

  div.innerHTML = `
    <div class="card-img-wrap">
      <img class="card-img" src="${escHtml(g.imageUrl)}" alt="${escHtml(g.gameName)}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <div class="card-img-placeholder" style="display:none">🎮</div>
      <span class="discount-badge">−${g.discountPercent}%</span>
      <span class="compat-badge compat-${cls}">${escHtml(label)}</span>
    </div>

    <div class="card-body"${notesAttr}>
      <div class="card-game-name">${escHtml(g.gameName)}</div>

      <div class="card-meta">
        ${g.device  ? `<span class="tag" title="${escHtml(g.device)}">${escHtml(g.device)}</span>` : ''}
        ${g.emulator ? `<span class="tag" title="${escHtml(g.emulator)}">${escHtml(g.emulator)}</span>` : ''}
        ${g.system  ? `<span class="tag" title="${escHtml(g.system)}">${escHtml(g.system)}</span>` : ''}
      </div>

      ${g.notes ? `<div class="card-notes">${escHtml(g.notes)}</div>` : ''}

      <div class="card-price">
        ${g.originalPriceFormatted
          ? `<span class="price-original">${escHtml(g.originalPriceFormatted)}</span>`
          : ''}
        <span class="price-final${g.price === 0 ? ' price-free' : ''}">
          ${escHtml(g.priceFormatted)}
        </span>
      </div>
    </div>

    <div class="card-footer">
      <a href="${escHtml(g.storeUrl)}" target="_blank" rel="noopener" class="btn-steam">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.98 0C5.366 0 0 5.367 0 12c0 6.63 5.366 12 11.98 12 6.615 0 12.02-5.37 12.02-12S18.595 0 11.98 0zM6.31 18.66l-1.95-1.12 4.24-7.34a3.72 3.72 0 0 1 2.12-.9l-4.41 9.36zm9.39-3.4a3.71 3.71 0 0 1-5.1-1.36 3.72 3.72 0 0 1 1.36-5.1 3.71 3.71 0 0 1 5.1 1.36 3.72 3.72 0 0 1-1.36 5.1z"/>
        </svg>
        ${t('viewOnSteam')}
      </a>
    </div>`;

  return div;
}

/* ── Pagination ─────────────────────────────────────────────────────────────── */
function renderPagination() {
  el.pagination.innerHTML = '';
  const { page, totalPages } = state;
  if (totalPages <= 1) return;

  const make = (label, p, disabled = false, active = false) => {
    const btn = document.createElement('button');
    btn.className = 'page-btn' + (active ? ' active' : '');
    btn.textContent = label;
    btn.disabled = disabled;
    btn.addEventListener('click', () => goToPage(p));
    return btn;
  };

  // Prev
  el.pagination.appendChild(make('‹', page - 1, page <= 1));

  // Page numbers (smart ellipsis)
  const pages = smartPages(page, totalPages);
  pages.forEach(p => {
    if (p === '…') {
      const span = document.createElement('span');
      span.className = 'page-dots';
      span.textContent = '…';
      el.pagination.appendChild(span);
    } else {
      el.pagination.appendChild(make(p, p, false, p === page));
    }
  });

  // Next
  el.pagination.appendChild(make('›', page + 1, page >= totalPages));
}

function smartPages(current, total) {
  if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
  const pages = [];
  if (current <= 4) {
    pages.push(1, 2, 3, 4, 5, '…', total);
  } else if (current >= total - 3) {
    pages.push(1, '…', total - 4, total - 3, total - 2, total - 1, total);
  } else {
    pages.push(1, '…', current - 1, current, current + 1, '…', total);
  }
  return pages;
}

async function goToPage(p) {
  if (p < 1 || p > state.totalPages || p === state.page) return;
  state.page = p;
  await fetchGames(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ── Results count ──────────────────────────────────────────────────────────── */
function updateCount() {
  const { total, page, totalPages } = state;
  if (!state.loaded) { el.resultsCount.innerHTML = ''; return; }
  el.resultsCount.innerHTML = total
    ? t('resultsCount')(total, page, totalPages)
    : t('noResults');
}

/* ── Skeletons ──────────────────────────────────────────────────────────────── */
function showSkeletons(n = 12) {
  el.gamesGrid.innerHTML = Array(n).fill('<div class="skeleton"></div>').join('');
  el.pagination.innerHTML = '';
  el.resultsCount.innerHTML = t('loading');
}

function showError(msg) {
  el.gamesGrid.innerHTML = `
    <div class="state-box">
      <div class="icon">⚠️</div>
      <h3>${t('errorTitle')}</h3>
      <p>${escHtml(msg)}</p>
    </div>`;
}

/* ── Utility ────────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ── Event listeners ────────────────────────────────────────────────────────── */

// Apply filters
el.applyBtn.addEventListener('click', () => fetchGames(true));

// Enter in search
el.searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchGames(true);
});

// Sort change = instant re-fetch
el.sortSelect.addEventListener('change', () => {
  state.filters.sort = el.sortSelect.value;
  fetchGames(true);
});

// Discount buttons
document.querySelectorAll('.disc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Refresh
el.refreshBtn.addEventListener('click', async () => {
  el.refreshBtn.classList.add('spinning');
  el.cacheLabel.textContent = t('refreshing');
  try {
    await api.refresh();
    await fetchGames(true);
    el.cacheLabel.textContent = t('cacheCleared');
    setTimeout(() => { el.cacheLabel.textContent = ''; }, 3000);
  } finally {
    el.refreshBtn.classList.remove('spinning');
  }
});

// Reset
el.resetBtn.addEventListener('click', () => {
  clearAllDevices();
  el.minPrice.value       = '';
  el.maxPrice.value       = '';
  el.searchInput.value    = '';
  el.sortSelect.value     = 'discount_desc';

  // Reset compat
  el.compatList.querySelectorAll('.compat-item').forEach(i => i.classList.remove('selected'));
  el.compatList.querySelector('[data-value=""]')?.classList.add('selected');
  el.compatList.querySelector('input[value=""]').checked = true;

  // Reset discount
  document.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.disc-btn[data-value="0"]')?.classList.add('active');

  fetchGames(true);
});

/* ── Re-render dynamic content on language change ───────────────────────────── */
document.addEventListener('languagechange', () => {
  updateRegionNote();
  renderChips();
  if (state.loaded) {
    renderGames();
    updateCount();
  }
});

/* ── Boot ───────────────────────────────────────────────────────────────────── */
init();
