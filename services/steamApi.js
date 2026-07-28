const axios = require('axios');

const STEAM_API_BASE = 'https://api.steampowered.com';

function parseOwnedGamesResponse(data) {
  const games = data?.response?.games ?? [];
  return games.map(g => String(g.appid));
}

function parseWishlistResponse(data) {
  const items = data?.response?.items ?? [];
  return items.map(i => String(i.appid));
}

async function getOwnedGameAppIds(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/`, {
    params: {
      key: process.env.STEAM_API_KEY,
      steamid: steamId,
      include_appinfo: false,
      include_played_free_games: true,
      format: 'json',
    },
    timeout: 10000,
  });
  return parseOwnedGamesResponse(res.data);
}

async function getWishlistAppIds(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/`, {
    params: { key: process.env.STEAM_API_KEY, steamid: steamId, format: 'json' },
    timeout: 10000,
  });
  return parseWishlistResponse(res.data);
}

async function getPersonaName(steamId) {
  const res = await axios.get(`${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/`, {
    params: { key: process.env.STEAM_API_KEY, steamids: steamId, format: 'json' },
    timeout: 10000,
  });
  const player = res.data?.response?.players?.[0];
  return player?.personaname ?? null;
}

module.exports = {
  getOwnedGameAppIds, getWishlistAppIds, getPersonaName,
  parseOwnedGamesResponse, parseWishlistResponse,
};
