const axios = require('axios');
const { redis } = require('./cache');

const EPIC_API = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions';
const EPIC_FREE_KEY = 'epic:free:games';
const EPIC_FREE_TTL = 60 * 60 * 1000; // 1 h

function isCurrentlyFree(element) {
  const now = Date.now();
  const groups = element.promotions?.promotionalOffers ?? [];
  for (const group of groups) {
    for (const offer of group.promotionalOffers ?? []) {
      if (
        offer.discountSetting?.discountPercentage === 0 &&
        new Date(offer.startDate).getTime() <= now &&
        new Date(offer.endDate).getTime() > now
      ) {
        return offer;
      }
    }
  }
  return null;
}

function getImage(keyImages) {
  const preferred = ['Thumbnail', 'DieselStoreFrontWide', 'OfferImageWide'];
  for (const type of preferred) {
    const img = keyImages?.find(k => k.type === type);
    if (img?.url) return img.url;
  }
  return keyImages?.[0]?.url ?? '';
}

function getStoreUrl(element) {
  const slug =
    element.catalogNs?.mappings?.[0]?.pageSlug ??
    element.offerMappings?.[0]?.pageSlug;
  return slug
    ? `https://store.epicgames.com/en-US/p/${slug}`
    : 'https://store.epicgames.com/free-games';
}

async function getEpicFreeGames() {
  const cached = await redis.get(EPIC_FREE_KEY);
  if (cached) return new Map(JSON.parse(cached));

  let elements = [];
  try {
    const res = await axios.get(EPIC_API, {
      params: { locale: 'en-US', country: 'US', allowCountries: 'US' },
      timeout: 10000,
    });
    elements = res.data?.data?.Catalog?.searchStore?.elements ?? [];
  } catch (e) {
    console.warn('[Epic] free games fetch failed:', e.message);
    return new Map();
  }

  const result = new Map();
  for (const element of elements) {
    const offer = isCurrentlyFree(element);
    if (!offer) continue;
    const title = element.title;
    if (!title) continue;

    result.set(title.toLowerCase(), {
      appId:                  `epic:${element.id ?? title.toLowerCase().replace(/\W+/g, '-')}`,
      name:                   title,
      storeName:              'Epic Games Store',
      imageUrl:               getImage(element.keyImages),
      storeUrl:               getStoreUrl(element),
      discountPercent:        100,
      price:                  0,
      originalPrice:          0,
      priceFormatted:         'Free',
      originalPriceFormatted: '',
      currency:               'USD',
      dealSince:              offer.startDate ?? null,
      dealExpiry:             offer.endDate ?? null,
      historicalLow:          null,
      igdbRating:             null,
    });
  }

  console.log(`[Epic] ${result.size} free game(s) currently available`);
  await redis.set(EPIC_FREE_KEY, JSON.stringify([...result.entries()]), 'PX', EPIC_FREE_TTL);
  return result;
}

async function clearCache() {
  await redis.del(EPIC_FREE_KEY);
}

module.exports = { getEpicFreeGames, clearCache };
