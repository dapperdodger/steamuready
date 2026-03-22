/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  devices:   [],
  perfScales: [],
  allShops:  [],
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
    minRating:     0,
    histLow:       false,
    newAge:        '',
    search:        '',
    sort:          'discount_desc',
    cc:            'us',
    shops:         [], // empty = all stores
    apps:          [], // empty = all apps
  },
};

/* ── DOM refs ──────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  progressBar:  $('progressBar'),
  statusDot:    $('statusDot'),
  cacheLabel:   $('cacheLabel'),
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
  appList:      $('appList'),
  storeList:    $('storeList'),
  histLowCheck:  $('histLowCheck'),
  newAgeButtons: $('newAgeButtons'),
  ratingButtons: $('ratingButtons'),
};

/* ── API ───────────────────────────────────────────────────────────────────── */
const api = {
  async json(url) {
    const r = await fetch(url);
    if (r.status === 429) {
      const body = await r.json().catch(() => ({}));
      const err = new Error(body.error || 'Rate limit exceeded');
      err.status = 429;
      err.retryAfter = body.retryAfter ?? 30;
      throw err;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  devices()       { return api.json('/api/devices'); },
  perfScales()    { return api.json('/api/performance-scales'); },
  regions()       { return api.json('/api/regions'); },
  shops(cc)       { return api.json(`/api/shops?cc=${cc || 'us'}`); },
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
    // Devices + perf scales + regions + shops in parallel
    const [devices, scales, regions, shops] = await Promise.all([
      api.devices().catch(() => []),
      api.perfScales().catch(() => []),
      api.regions().catch(() => ({})),
      api.shops('us').catch(() => []),
    ]);

    state.devices    = devices;
    state.perfScales = scales;
    state.allShops   = shops;

    populateDevices(devices);
    populateCompatList(scales);
    populateRegions(regions);
    populateStores(shops);
    initAppFilter();
    initPreferredDevicesModal();

    const isFirstVisit = loadPreferredDeviceIds() === null;
    if (isFirstVisit) {
      openPreferredDevicesModal();
    } else {
      applyPreferredDevices();
      applyPreferredCompat();
      applyPreferredRegion();
      applyPreferredStores();
    }

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
const MAX_DEVICES = 5;
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
  if (q) {
    const matches = state.devices
      .filter(d => d.name.toLowerCase().includes(q) && !_selectedDevices.has(d.id))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .slice(0, 60);
    renderDropdown(matches, q);
  } else {
    // Top 20 most popular, sorted alphabetically, with hint
    const top20 = state.devices
      .filter(d => !_selectedDevices.has(d.id))
      .slice(0, 20)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    renderDropdown(top20, '', true);
  }
}

function renderDropdown(devices, q = '', showHint = false) {
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
    if (showHint) {
      const hint = document.createElement('div');
      hint.className = 'device-opt-hint';
      hint.textContent = t('deviceSearchHint');
      el.deviceDropdown.appendChild(hint);
    }
  }
  el.deviceDropdown.hidden = false;
}

function closeDropdown() {
  el.deviceDropdown.hidden = true;
  _deviceFocusIdx = -1;
}

function addDevice(d) {
  if (_selectedDevices.has(d.id)) return;
  if (_selectedDevices.size >= MAX_DEVICES) return;
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
  const atMax = _selectedDevices.size >= MAX_DEVICES;
  el.deviceSearch.disabled = atMax;
  el.deviceSearch.placeholder = atMax
    ? t('deviceMaxReached')(MAX_DEVICES)
    : t(_selectedDevices.size ? 'deviceAddPlaceholder' : 'deviceSearchPlaceholder');
  if (atMax) closeDropdown();
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

/* ── Preferred settings (localStorage) ─────────────────────────────────────── */
const PREF_KEY        = 'preferredDevices';
const PREF_COMPAT_KEY = 'preferredCompat';
const PREF_REGION_KEY = 'preferredRegion';
const PREF_STORES_KEY = 'preferredStores';

function loadPreferredDeviceIds() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY)); } catch { return null; }
}

function savePreferredDeviceIds(ids) {
  localStorage.setItem(PREF_KEY, JSON.stringify(ids));
}

function applyPreferredDevices() {
  const ids = loadPreferredDeviceIds();
  if (!ids || !ids.length) return;
  ids.forEach(id => {
    const d = state.devices.find(x => x.id === id);
    if (d && !_selectedDevices.has(d.id)) addDevice(d);
  });
}

function loadPreferredCompatId() {
  return localStorage.getItem(PREF_COMPAT_KEY); // null = never set; '' = All
}

function savePreferredCompatId(id) {
  localStorage.setItem(PREF_COMPAT_KEY, id ?? '');
}

function applyPreferredCompat() {
  const id = loadPreferredCompatId();
  if (id === null) return;
  const selector = id === '' ? '[data-value=""]' : `[data-value="${CSS.escape(id)}"]`;
  const item = el.compatList.querySelector(`.compat-item${selector}`);
  if (!item) return;
  el.compatList.querySelectorAll('.compat-item').forEach(i => i.classList.remove('selected'));
  item.classList.add('selected');
  item.querySelector('input').checked = true;
}

function loadPreferredRegion() {
  return localStorage.getItem(PREF_REGION_KEY); // null = never set
}

function savePreferredRegion(cc) {
  localStorage.setItem(PREF_REGION_KEY, cc ?? 'us');
}

function applyPreferredRegion() {
  const cc = loadPreferredRegion();
  if (!cc) return;
  if (el.regionSelect) {
    el.regionSelect.value = cc;
    updateRegionNote();
  }
}

function loadPreferredStoreIds() {
  try { return JSON.parse(localStorage.getItem(PREF_STORES_KEY)); } catch { return null; }
}

function savePreferredStoreIds(ids) {
  localStorage.setItem(PREF_STORES_KEY, JSON.stringify(ids));
}

function applyPreferredStores() {
  const ids = loadPreferredStoreIds();
  if (!ids || !ids.length) return; // null or empty = all selected (already default)
  const idSet = new Set(ids.map(String));
  el.storeList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = idSet.has(String(cb.value));
  });
}

/* ── Preferred settings modal ───────────────────────────────────────────────── */
const _prefSelectedDevices = new Map(); // id → {id, name} — used only inside modal
let _prefDeviceFocusIdx = -1;

const prefEl = {
  modal:        document.getElementById('prefDevicesModal'),
  search:       document.getElementById('prefDeviceSearch'),
  dropdown:     document.getElementById('prefDeviceDropdown'),
  chips:        document.getElementById('prefDeviceChips'),
  regionSelect: document.getElementById('prefRegionSelect'),
  storeList:    document.getElementById('prefStoreList'),
  compatSelect: document.getElementById('prefCompatSelect'),
  skipBtn:      document.getElementById('prefDevicesSkip'),
  saveBtn:      document.getElementById('prefDevicesSave'),
};

function openPreferredDevicesModal() {
  // Seed modal with current preferred device ids
  _prefSelectedDevices.clear();
  const savedIds = loadPreferredDeviceIds() || [];
  savedIds.forEach(id => {
    const d = state.devices.find(x => x.id === id);
    if (d) _prefSelectedDevices.set(d.id, d);
  });
  prefRenderChips();
  prefEl.search.value = '';
  prefEl.dropdown.hidden = true;
  // Seed compat select with saved preference
  const savedCompat = loadPreferredCompatId();
  if (savedCompat !== null) prefEl.compatSelect.value = savedCompat;
  // Seed region select with saved preference
  const savedRegion = loadPreferredRegion();
  if (savedRegion && prefEl.regionSelect) prefEl.regionSelect.value = savedRegion;
  // Seed store checkboxes with saved preference
  const savedStoreIds = loadPreferredStoreIds();
  if (savedStoreIds && prefEl.storeList) {
    const idSet = new Set(savedStoreIds.map(String));
    prefEl.storeList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = idSet.has(String(cb.value));
    });
  }
  prefEl.modal.hidden = false;
  prefEl.search.focus();
}

function closePreferredDevicesModal() {
  prefEl.modal.hidden = true;
}

function prefRenderChips() {
  prefEl.chips.innerHTML = '';
  _prefSelectedDevices.forEach(d => {
    const chip = document.createElement('div');
    chip.className = 'device-chip';
    chip.dataset.id = d.id;
    chip.innerHTML = `<span title="${escHtml(d.name)}">${escHtml(d.name)}</span><button type="button" title="${t('deviceRemove')}">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      _prefSelectedDevices.delete(d.id);
      prefRenderChips();
    });
    prefEl.chips.appendChild(chip);
  });
  const atMax = _prefSelectedDevices.size >= MAX_DEVICES;
  prefEl.search.disabled = atMax;
  prefEl.search.placeholder = atMax
    ? t('deviceMaxReached')(MAX_DEVICES)
    : t(_prefSelectedDevices.size ? 'deviceAddPlaceholder' : 'deviceSearchPlaceholder');
  if (atMax) prefEl.dropdown.hidden = true;
}

function prefRenderDropdown(devices, q = '', showHint = false) {
  prefEl.dropdown.innerHTML = '';
  _prefDeviceFocusIdx = -1;
  if (!devices.length) {
    prefEl.dropdown.innerHTML = `<div class="device-opt-empty">${t('deviceNoResults')}</div>`;
  } else {
    devices.forEach(d => {
      const div = document.createElement('div');
      div.className = 'device-opt';
      div.dataset.id = d.id;
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      div.innerHTML = q ? d.name.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>') : d.name;
      div.addEventListener('mousedown', e => { e.preventDefault(); prefAddDevice(d); });
      prefEl.dropdown.appendChild(div);
    });
    if (showHint) {
      const hint = document.createElement('div');
      hint.className = 'device-opt-hint';
      hint.textContent = t('deviceSearchHint');
      prefEl.dropdown.appendChild(hint);
    }
  }
  prefEl.dropdown.hidden = false;
}

function prefAddDevice(d) {
  if (_prefSelectedDevices.has(d.id)) return;
  if (_prefSelectedDevices.size >= MAX_DEVICES) return;
  _prefSelectedDevices.set(d.id, d);
  prefEl.search.value = '';
  prefRenderChips();
  prefEl.dropdown.hidden = true;
  _prefDeviceFocusIdx = -1;
}

function getPrefDeviceMatches(q) {
  if (q) {
    return {
      matches: state.devices
        .filter(d => d.name.toLowerCase().includes(q) && !_prefSelectedDevices.has(d.id))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
        .slice(0, 60),
      hint: false,
    };
  }
  return {
    matches: state.devices
      .filter(d => !_prefSelectedDevices.has(d.id))
      .slice(0, 20)
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    hint: true,
  };
}

function initPreferredDevicesModal() {
  prefEl.search.addEventListener('input', () => {
    const q = prefEl.search.value.trim().toLowerCase();
    const { matches, hint } = getPrefDeviceMatches(q);
    prefRenderDropdown(matches, q, hint);
  });

  prefEl.search.addEventListener('focus', () => {
    const q = prefEl.search.value.trim().toLowerCase();
    const { matches, hint } = getPrefDeviceMatches(q);
    prefRenderDropdown(matches, q, hint);
  });

  prefEl.search.addEventListener('keydown', e => {
    const opts = [...prefEl.dropdown.querySelectorAll('.device-opt')];
    if (e.key === 'Escape') { prefEl.dropdown.hidden = true; return; }
    if (!opts.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _prefDeviceFocusIdx = Math.min(_prefDeviceFocusIdx + 1, opts.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _prefDeviceFocusIdx = Math.max(_prefDeviceFocusIdx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_prefDeviceFocusIdx >= 0) {
        const id = opts[_prefDeviceFocusIdx].dataset.id;
        const d = state.devices.find(x => x.id === id);
        if (d) prefAddDevice(d);
      }
      return;
    } else { return; }
    opts.forEach((o, i) => o.classList.toggle('focused', i === _prefDeviceFocusIdx));
    opts[_prefDeviceFocusIdx]?.scrollIntoView({ block: 'nearest' });
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#prefDeviceCombo')) prefEl.dropdown.hidden = true;
  });

  // Populate compat select from perfScales
  prefEl.compatSelect.innerHTML = `<option value="">${t('compatAll')}</option>`;
  const sortedScales = [...state.perfScales].sort((a, b) =>
    (a.rank ?? a.position ?? 99) - (b.rank ?? b.position ?? 99)
  );
  sortedScales.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label ?? s.description ?? `Rank ${s.rank ?? s.position}`;
    prefEl.compatSelect.appendChild(opt);
  });

  // Populate modal region select from same data as sidebar
  if (prefEl.regionSelect) {
    prefEl.regionSelect.innerHTML = el.regionSelect.innerHTML;
    prefEl.regionSelect.value = el.regionSelect.value;
  }

  // Populate modal store checkboxes from same data as sidebar
  if (prefEl.storeList) {
    prefEl.storeList.innerHTML = '';
    state.allShops.forEach(s => {
      const label = document.createElement('label');
      label.className = 'store-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(s.title));
      prefEl.storeList.appendChild(label);
    });
  }

  prefEl.skipBtn.addEventListener('click', () => {
    savePreferredDeviceIds([]);
    savePreferredCompatId('');
    savePreferredRegion('us');
    savePreferredStoreIds([]);
    closePreferredDevicesModal();
  });

  prefEl.saveBtn.addEventListener('click', () => {
    const ids = [..._prefSelectedDevices.keys()];
    savePreferredDeviceIds(ids);
    savePreferredCompatId(prefEl.compatSelect.value);
    // Save + apply region
    const selectedRegion = prefEl.regionSelect ? prefEl.regionSelect.value : el.regionSelect.value;
    savePreferredRegion(selectedRegion);
    if (el.regionSelect.value !== selectedRegion) {
      el.regionSelect.value = selectedRegion;
      updateRegionNote();
    }
    // Save + apply stores
    if (prefEl.storeList) {
      const storeIds = [...prefEl.storeList.querySelectorAll('input:checked')].map(i => i.value);
      savePreferredStoreIds(storeIds);
      const storeIdSet = new Set(storeIds.map(String));
      el.storeList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = storeIdSet.has(String(cb.value));
      });
    }
    // Apply devices + compat to main UI
    _prefSelectedDevices.forEach(d => {
      if (!_selectedDevices.has(d.id)) addDevice(d);
    });
    applyPreferredCompat();
    closePreferredDevicesModal();
    fetchGames(true, true);
  });

  // Close on overlay click
  prefEl.modal.addEventListener('click', e => {
    if (e.target === prefEl.modal) {
      savePreferredDeviceIds([...(_prefSelectedDevices.keys())]);
      closePreferredDevicesModal();
    }
  });

  document.getElementById('managePreferredBtn').addEventListener('click', openPreferredDevicesModal);
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

/* ── App filter checkboxes ──────────────────────────────────────────────────── */
function initAppFilter() {
  el.appList.querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', () => fetchGames(true));
  });
}

/* ── Populate store checkboxes ──────────────────────────────────────────────── */
function populateStores(shops) {
  state.allShops = shops;
  el.storeList.innerHTML = '';
  shops.forEach(s => {
    const label = document.createElement('label');
    label.className = 'store-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s.id;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(s.title));
    el.storeList.appendChild(label);
  });
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

  // Click on row = select radio + instant re-fetch (Filters)
  el.compatList.querySelectorAll('.compat-item').forEach(item => {
    item.addEventListener('click', () => {
      el.compatList.querySelectorAll('.compat-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      item.querySelector('input').checked = true;
      fetchGames(true);
    });
  });
}

/* ── Search rate-limit cooldown ─────────────────────────────────────────────── */
let _searchCoolUntil = 0;
let _searchCoolTimer = null;

function startSearchCooldown(seconds) {
  _searchCoolUntil = Date.now() + seconds * 1000;
  clearTimeout(_searchCoolTimer);
  const applyText = t('applyBtn');
  function tick() {
    const rem = Math.ceil((_searchCoolUntil - Date.now()) / 1000);
    if (rem <= 0) {
      el.applyBtn.disabled = false;
      el.applyBtn.textContent = applyText;
      return;
    }
    el.applyBtn.disabled = true;
    el.applyBtn.textContent = `⏳ ${rem}s`;
    _searchCoolTimer = setTimeout(tick, 500);
  }
  tick();
}

/* ── Fetch & render games ───────────────────────────────────────────────────── */
async function fetchGames(resetPage = true, isSettingsChange = false) {
  if (state.loading) return;

  if (_selectedDevices.size === 0) {
    showDevicePrompt();
    return;
  }

  state.loading = true;

  if (resetPage) state.page = 1;

  readFilters();

  const params = {
    deviceIds:     state.filters.deviceIds.join(',') || '',
    performanceId: state.filters.performanceId,
    minPrice:      state.filters.minPrice,
    maxPrice:      state.filters.maxPrice,
    minDiscount:   state.filters.minDiscount || '',
    minRating:     state.filters.minRating   || '',
    search:        state.filters.search,
    sort:          state.filters.sort,
    cc:            state.filters.cc,
    shops:         state.filters.shops.join(',') || '',
    apps:          state.filters.apps.join(',') || '',
    histLow:       state.filters.histLow ? '1' : '',
    newAge:        state.filters.newAge,
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

    if (resetPage && isSettingsChange) startSearchCooldown(5);

    renderGames();
    renderPagination();
    updateCount();

    progress(100);
  } catch (e) {
    console.error(e);
    if (e.status === 429) {
      startSearchCooldown(e.retryAfter ?? 30);
      showError(e.message);
    } else {
      showError(e.message);
    }
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
  const allStores   = el.storeList.querySelectorAll('input');
  const checkedStores = el.storeList.querySelectorAll('input:checked');
  state.filters.shops = checkedStores.length === allStores.length
    ? []  // all selected = send empty to hit the 'all' cache key
    : [...checkedStores].map(i => i.value);
  state.filters.apps          = [...el.appList.querySelectorAll('input:checked')].map(i => i.value);
  state.filters.histLow       = el.histLowCheck.checked;
  const activeAge = el.newAgeButtons.querySelector('.disc-btn.active');
  state.filters.newAge        = activeAge ? activeAge.dataset.value : '';

  const activeDisc   = document.querySelector('#discountButtons .disc-btn.active');
  state.filters.minDiscount = activeDisc ? parseInt(activeDisc.dataset.value) : 0;

  const activeRating = el.ratingButtons.querySelector('.disc-btn.active');
  state.filters.minRating = activeRating ? parseInt(activeRating.dataset.value) : 0;
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
  const isHistLow = g.historicalLow && g.price <= g.historicalLow.price;
  const isNew  = isNewDeal(g.dealSince);
  const expiry = g.dealExpiry ? formatShortDate(g.dealExpiry) : null;

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
      ${isHistLow ? `<span class="hist-low-badge" title="${escHtml(g.historicalLow.priceFormatted)} · ${escHtml(g.historicalLow.shop)}">${t('histLowBadge')}</span>` : ''}
      ${isNew ? `<span class="new-deal-badge">${t('newBadge')}</span>` : ''}
    </div>

    <div class="card-body"${notesAttr}>
      <div class="card-game-name">${escHtml(g.gameName)}</div>

      <div class="card-meta">
        ${g.storeName ? `<span class="tag tag-store">${escHtml(g.storeName)}</span>` : ''}
        ${g.igdbRating?.igdbRating != null ? `<span class="tag tag-rating" title="IGDB Rating">⭐ ${Math.round(g.igdbRating.igdbRating)}</span>` : ''}
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
        ${expiry ? `<span class="deal-expiry">${escHtml(t('dealEnds')(expiry))}</span>` : ''}
      </div>
    </div>

    <div class="card-footer">
      <a href="${escHtml(g.storeUrl)}" target="_blank" rel="noopener" class="btn-steam">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        ${t('viewOnStore')(escHtml(g.storeName || 'Store'))}
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

function showDevicePrompt() {
  el.gamesGrid.innerHTML = `
    <div class="state-box">
      <div class="icon">🎮</div>
      <h3>${t('devicePromptTitle')}</h3>
      <p>${t('devicePromptMsg')}</p>
    </div>`;
  el.pagination.innerHTML = '';
  el.resultsCount.innerHTML = '';
}

function showError(msg) {
  el.gamesGrid.innerHTML = `
    <div class="state-box">
      <div class="icon">⚠️</div>
      <h3>${t('errorTitle')}</h3>
      <p>${escHtml(msg)}</p>
    </div>`;
}

/* ── Deal date helpers ──────────────────────────────────────────────────────── */
const NEW_DEAL_MS = 48 * 60 * 60 * 1000; // 48 h

function isNewDeal(isoStr) {
  if (!isoStr) return false;
  return (Date.now() - new Date(isoStr).getTime()) < NEW_DEAL_MS;
}

function formatShortDate(isoStr) {
  return new Date(isoStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ── Utility ────────────────────────────────────────────────────────────────── */
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Event listeners ────────────────────────────────────────────────────────── */

// Apply filters (Settings change — triggers cooldown)
el.applyBtn.addEventListener('click', () => fetchGames(true, true));

// Sort change = instant re-fetch (Filters)
el.sortSelect.addEventListener('change', () => {
  state.filters.sort = el.sortSelect.value;
  fetchGames(true);
});

// Discount buttons (instant, Filters)
document.querySelectorAll('#discountButtons .disc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    btn.closest('.discount-buttons').querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    fetchGames(true);
  });
});

// Deal age buttons (instant, Filters)
el.newAgeButtons.querySelectorAll('.disc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    el.newAgeButtons.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    fetchGames(true);
  });
});

// Rating filter buttons (instant, Filters)
el.ratingButtons.querySelectorAll('.disc-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    el.ratingButtons.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    fetchGames(true);
  });
});

// Historical low toggle (instant, Filters)
el.histLowCheck.addEventListener('change', () => fetchGames(true));

// Price inputs — debounced (Filters)
const _debouncedFetch = debounce(() => fetchGames(true), 400);
el.minPrice.addEventListener('input', _debouncedFetch);
el.maxPrice.addEventListener('input', _debouncedFetch);

// Search text — debounced (Filters)
el.searchInput.addEventListener('input', debounce(() => fetchGames(true), 400));


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

  // Reset app filter
  el.appList.querySelectorAll('input').forEach(i => { i.checked = false; });

  // Reset stores + clear preference
  el.storeList.querySelectorAll('input').forEach(i => { i.checked = false; });
  savePreferredStoreIds([]);

  // Reset region to default + clear preference
  el.regionSelect.value = 'us';
  updateRegionNote();
  savePreferredRegion('us');

  // Reset historical low
  el.histLowCheck.checked = false;

  // Reset deal age
  el.newAgeButtons.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
  el.newAgeButtons.querySelector('[data-value=""]')?.classList.add('active');

  // Reset rating filter
  el.ratingButtons.querySelectorAll('.disc-btn').forEach(b => b.classList.remove('active'));
  el.ratingButtons.querySelector('[data-value="0"]')?.classList.add('active');

  fetchGames(true, true);
});

/* ── Re-render dynamic content on language change ───────────────────────────── */
document.addEventListener('languagechange', () => {
  updateRegionNote();
  renderChips();
  if (_selectedDevices.size === 0) {
    showDevicePrompt();
  } else if (state.loaded) {
    renderGames();
    updateCount();
  }
});

/* ── Konami Code Easter Egg ─────────────────────────────────────────────────── */
(function () {
  const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  let seq = 0;
  let toastEl = null;
  let hideTimer = null;

  document.addEventListener('keydown', e => {
    if (e.key === KONAMI[seq]) {
      seq++;
      if (seq === KONAMI.length) {
        seq = 0;
        triggerKonami();
      }
    } else {
      seq = e.key === KONAMI[0] ? 1 : 0;
    }
  });

  function triggerKonami() {
    if (toastEl) {
      clearTimeout(hideTimer);
      toastEl.remove();
      toastEl = null;
    }
    toastEl = document.createElement('div');
    toastEl.className = 'konami-toast';
    toastEl.innerHTML = '🎮 +30 lives unlocked<br><span style="font-size:.8rem;font-weight:400;opacity:.8">Too bad this isn\'t that kind of game</span>';
    document.body.appendChild(toastEl);

    hideTimer = setTimeout(() => {
      toastEl.classList.add('hide');
      toastEl.addEventListener('animationend', () => { toastEl?.remove(); toastEl = null; }, { once: true });
    }, 3500);
  }
})();

/* ── Mobile sidebar toggle ──────────────────────────────────────────────────── */
(function () {
  const toggle   = document.getElementById('sidebarToggle');
  const closeBtn = document.getElementById('sidebarClose');
  const sidebar  = document.querySelector('.sidebar');
  const overlay  = document.getElementById('sidebarOverlay');
  const applyBtn = document.getElementById('applyBtn');
  if (!toggle || !sidebar || !overlay) return;

  function isMobile() { return window.innerWidth <= 768; }
  function open()  { sidebar.classList.add('open');    overlay.classList.add('open');    document.body.style.overflow = 'hidden'; }
  function close() { sidebar.classList.remove('open'); overlay.classList.remove('open'); document.body.style.overflow = ''; }

  toggle.addEventListener('click',   () => sidebar.classList.contains('open') ? close() : open());
  overlay.addEventListener('click',  close);
  closeBtn?.addEventListener('click', close);

  // Auto-close sidebar on mobile after tapping Apply/Save
  applyBtn?.addEventListener('click', () => { if (isMobile()) close(); });
})();

/* ── Boot ───────────────────────────────────────────────────────────────────── */
init();
