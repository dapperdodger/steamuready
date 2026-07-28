const express = require('express');
const { requireAuth } = require('../middleware/session');
const steamAuth = require('../services/steamAuth');
const steamApi = require('../services/steamApi');
const steamImport = require('../services/steamImport');
const auth = require('../services/auth');
const steamLibraryCompat = require('../services/steamLibraryCompat');
const { redis } = require('../services/cache');

// Non-fatal: a cache-delete failure shouldn't break the unlink/link
// operation itself — log and continue.
async function clearLibraryCompatCache(userId) {
  try {
    await redis.del(`steam-library-compat:${userId}`);
  } catch (e) {
    console.error('[/api/steam] failed to clear library-compat cache:', e.message);
  }
}

const router = express.Router();
router.use(requireAuth);

function buildUrls(req) {
  const base = `${req.protocol}://${req.get('host')}`;
  return { returnUrl: `${base}/api/steam/callback`, realm: `${base}/` };
}

router.get('/link', async (req, res) => {
  try {
    const { returnUrl, realm } = buildUrls(req);
    const authUrl = await steamAuth.getAuthUrl(returnUrl, realm);
    res.redirect(authUrl);
  } catch (e) {
    console.error('[/api/steam/link]', e.message);
    res.redirect('/?steamError=link_failed');
  }
});

router.get('/callback', async (req, res) => {
  try {
    const { returnUrl, realm } = buildUrls(req);
    const steamId = await steamAuth.verifyAssertion(req, returnUrl, realm);
    if (!steamId) return res.redirect('/?steamError=verification_failed');

    const existing = await auth.findUserBySteamId(steamId);
    if (existing && existing.id !== req.session.userId) {
      return res.redirect('/?steamError=already_linked');
    }

    const personaName = await steamApi.getPersonaName(steamId).catch(() => null);
    await auth.linkSteamAccount(req.session.userId, steamId, personaName);
    // Stale cache guard: if the user previously linked a different Steam
    // account, don't let their old library data leak into the new link.
    await clearLibraryCompatCache(req.session.userId);
    res.redirect('/?steamLinked=1');
  } catch (e) {
    console.error('[/api/steam/callback]', e.message);
    res.redirect('/?steamError=link_failed');
  }
});

router.post('/unlink', async (req, res) => {
  try {
    await auth.unlinkSteamAccount(req.session.userId);
    await clearLibraryCompatCache(req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/steam/unlink]', e);
    res.status(500).json({ error: 'Unlink failed' });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = await auth.getSteamLinkStatus(req.session.userId);
    res.json({ linked: !!status.steamId, personaName: status.personaName });
  } catch (e) {
    console.error('[/api/steam/status]', e);
    res.status(500).json({ error: 'Status check failed' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const status = await auth.getSteamLinkStatus(req.session.userId);
    if (!status.steamId) return res.status(400).json({ error: 'No Steam account linked' });

    const summary = await steamImport.runImport(req.session.userId, status.steamId);
    res.json(summary);
  } catch (e) {
    console.error('[/api/steam/import]', e.message);
    res.status(500).json({ error: 'Import failed' });
  }
});

router.get('/library-compat', async (req, res) => {
  try {
    const status = await auth.getSteamLinkStatus(req.session.userId);
    if (!status.steamId) return res.status(400).json({ error: 'No Steam account linked' });

    const games = await steamLibraryCompat.getLibraryCompat(req.session.userId, status.steamId);
    res.json({ games });
  } catch (e) {
    console.error('[/api/steam/library-compat]', e);
    res.status(500).json({ error: 'Failed to load library compatibility' });
  }
});

module.exports = router;
