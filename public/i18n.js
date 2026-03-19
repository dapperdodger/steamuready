/* ── Translations ────────────────────────────────────────────────────────────── */
const translations = {
  fr: {
    title:                  'SteamUReady — Promos Steam × Compatibilité émulation',
    refreshTitle:           'Vider le cache et re-fetcher',
    refresh:                'Refresh',
    filters:                'Filtres',
    device:                 'Appareil',
    deviceSearchPlaceholder:'Rechercher un appareil…',
    deviceAddPlaceholder:   'Ajouter un appareil…',
    deviceRemove:           'Retirer',
    deviceNoResults:        'Aucun résultat',
    compatMin:              'Compatibilité minimale',
    compatAll:              'Toutes',
    priceMax:               'Prix maximum',
    discountMin:            'Réduction minimale',
    discountAll:            'Toutes',
    steamRegion:            'Région Steam',
    searchLabel:            'Rechercher',
    searchPlaceholder:      'Nom du jeu…',
    applyBtn:               '🔍 Rechercher',
    resetBtn:               'Réinitialiser',
    sortDiscount:           'Réduction (↓)',
    sortPriceAsc:           'Prix (↑)',
    sortPriceDesc:          'Prix (↓)',
    sortCompat:             'Compatibilité (↓)',
    sortName:               'Nom (A→Z)',
    loading:                'Chargement…',
    apiError:               'Erreur API',
    refreshing:             'Actualisation…',
    cacheCleared:           'Cache vidé ✓',
    noGamesTitle:           'Aucun jeu trouvé',
    noGamesMsg:             'Essaie avec un autre appareil ou élargis les filtres.<br/>Les promos Steam changent souvent — reviens plus tard !',
    viewOnSteam:            'Voir sur Steam',
    errorTitle:             'Erreur',
    noResults:              'Aucun résultat',
    statusApi:              'Status API',
    regionNoteBR:           "Prix souvent plus bas qu'en USD",
    regionNoteTR:           'Prix très réduits — promos parfois différentes',
    regionNoteAR:           'Prix très bas — peut nécessiter un VPN',
    rankLabel:              rank => `Niveau ${rank}`,
    resultsCount:           (total, page, totalPages) =>
      `<strong>${total}</strong> jeu${total > 1 ? 'x' : ''} trouvé${total > 1 ? 's' : ''} — page ${page}/${totalPages}`,
  },

  en: {
    title:                  'SteamUReady — Steam Sales × Emulation Compatibility',
    refreshTitle:           'Clear cache and re-fetch',
    refresh:                'Refresh',
    filters:                'Filters',
    device:                 'Device',
    deviceSearchPlaceholder:'Search for a device…',
    deviceAddPlaceholder:   'Add a device…',
    deviceRemove:           'Remove',
    deviceNoResults:        'No results',
    compatMin:              'Minimum compatibility',
    compatAll:              'All',
    priceMax:               'Maximum price',
    discountMin:            'Minimum discount',
    discountAll:            'All',
    steamRegion:            'Steam region',
    searchLabel:            'Search',
    searchPlaceholder:      'Game name…',
    applyBtn:               '🔍 Search',
    resetBtn:               'Reset',
    sortDiscount:           'Discount (↓)',
    sortPriceAsc:           'Price (↑)',
    sortPriceDesc:          'Price (↓)',
    sortCompat:             'Compatibility (↓)',
    sortName:               'Name (A→Z)',
    loading:                'Loading…',
    apiError:               'API Error',
    refreshing:             'Refreshing…',
    cacheCleared:           'Cache cleared ✓',
    noGamesTitle:           'No games found',
    noGamesMsg:             'Try a different device or broaden your filters.<br/>Steam sales change often — check back later!',
    viewOnSteam:            'View on Steam',
    errorTitle:             'Error',
    noResults:              'No results',
    statusApi:              'API Status',
    regionNoteBR:           'Often cheaper than USD',
    regionNoteTR:           'Very low prices — sales sometimes different',
    regionNoteAR:           'Very low prices — may require a VPN',
    rankLabel:              rank => `Rank ${rank}`,
    resultsCount:           (total, page, totalPages) =>
      `<strong>${total}</strong> game${total > 1 ? 's' : ''} found — page ${page}/${totalPages}`,
  },

  es: {
    title:                  'SteamUReady — Ofertas Steam × Compatibilidad de emulación',
    refreshTitle:           'Limpiar caché y recargar',
    refresh:                'Actualizar',
    filters:                'Filtros',
    device:                 'Dispositivo',
    deviceSearchPlaceholder:'Buscar un dispositivo…',
    deviceAddPlaceholder:   'Añadir un dispositivo…',
    deviceRemove:           'Quitar',
    deviceNoResults:        'Sin resultados',
    compatMin:              'Compatibilidad mínima',
    compatAll:              'Todas',
    priceMax:               'Precio máximo',
    discountMin:            'Descuento mínimo',
    discountAll:            'Todas',
    steamRegion:            'Región de Steam',
    searchLabel:            'Buscar',
    searchPlaceholder:      'Nombre del juego…',
    applyBtn:               '🔍 Buscar',
    resetBtn:               'Restablecer',
    sortDiscount:           'Descuento (↓)',
    sortPriceAsc:           'Precio (↑)',
    sortPriceDesc:          'Precio (↓)',
    sortCompat:             'Compatibilidad (↓)',
    sortName:               'Nombre (A→Z)',
    loading:                'Cargando…',
    apiError:               'Error de API',
    refreshing:             'Actualizando…',
    cacheCleared:           'Caché limpiado ✓',
    noGamesTitle:           'No se encontraron juegos',
    noGamesMsg:             'Prueba con otro dispositivo o amplía los filtros.<br/>¡Las ofertas de Steam cambian seguido — vuelve más tarde!',
    viewOnSteam:            'Ver en Steam',
    errorTitle:             'Error',
    noResults:              'Sin resultados',
    statusApi:              'Estado de la API',
    regionNoteBR:           'A menudo más barato que USD',
    regionNoteTR:           'Precios muy bajos — ofertas a veces distintas',
    regionNoteAR:           'Precios muy bajos — puede requerir VPN',
    rankLabel:              rank => `Nivel ${rank}`,
    resultsCount:           (total, page, totalPages) =>
      `<strong>${total}</strong> juego${total > 1 ? 's' : ''} encontrado${total > 1 ? 's' : ''} — página ${page}/${totalPages}`,
  },
};

/* ── Detect / restore language ───────────────────────────────────────────────── */
let currentLang = (() => {
  const stored = localStorage.getItem('lang');
  if (stored && translations[stored]) return stored;
  const nav = (navigator.language || '').slice(0, 2).toLowerCase();
  return translations[nav] ? nav : 'en';
})();

/* ── t(key) — look up a translation value ────────────────────────────────────── */
function t(key) {
  return (translations[currentLang] ?? translations.en)[key] ?? key;
}

/* ── applyTranslations — sync all data-i18n* elements to current lang ─────────── */
function applyTranslations() {
  document.documentElement.lang = currentLang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === currentLang);
  });
}

/* ── setLang — switch language and notify app ────────────────────────────────── */
function setLang(lang) {
  if (!translations[lang] || lang === currentLang) return;
  currentLang = lang;
  localStorage.setItem('lang', lang);
  applyTranslations();
  document.dispatchEvent(new CustomEvent('languagechange'));
}

applyTranslations();
