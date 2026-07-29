const express = require('express');
const { requireAuth } = require('../middleware/session');
const steamAuth = require('../services/steamAuth');
const steamApi = require('../services/steamApi');
const steamImport = require('../services/steamImport');
const auth = require('../services/auth');
const { clearOwnedGamesCompatCache } = require('../services/steamLibraryCompat');

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
    await clearOwnedGamesCompatCache(req.session.userId);
    res.redirect('/?steamLinked=1');
  } catch (e) {
    console.error('[/api/steam/callback]', e.message);
    res.redirect('/?steamError=link_failed');
  }
});

router.post('/unlink', async (req, res) => {
  try {
    await auth.unlinkSteamAccount(req.session.userId);
    await clearOwnedGamesCompatCache(req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/steam/unlink]', e.message);
    res.status(500).json({ error: 'Unlink failed' });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = await auth.getSteamLinkStatus(req.session.userId);
    res.json({ linked: !!status.steamId, personaName: status.personaName });
  } catch (e) {
    console.error('[/api/steam/status]', e.message);
    res.status(500).json({ error: 'Status check failed' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const status = await auth.getSteamLinkStatus(req.session.userId);
    if (!status.steamId) return res.status(400).json({ error: 'No Steam account linked' });

    const summary = await steamImport.runImport(req.session.userId, status.steamId);
    // Import adds/removes owned_games rows — without this, My Games could
    // show stale (missing new, or still-showing removed) compat entries
    // for up to the cache's 5-minute TTL.
    await clearOwnedGamesCompatCache(req.session.userId);
    res.json(summary);
  } catch (e) {
    console.error('[/api/steam/import]', e.message);
    // A steamPrivacyGuard error is a known, actionable condition (Steam
    // profile privacy setting likely changed) — surface its specific
    // message instead of the generic one used for unexpected failures.
    if (e.steamPrivacyGuard) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
