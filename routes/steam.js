const express = require('express');
const { requireAuth } = require('../middleware/session');
const steamAuth = require('../services/steamAuth');
const steamApi = require('../services/steamApi');
const steamImport = require('../services/steamImport');
const auth = require('../services/auth');

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
    console.error('[/api/steam/link]', e);
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
    res.redirect('/?steamLinked=1');
  } catch (e) {
    console.error('[/api/steam/callback]', e);
    res.redirect('/?steamError=link_failed');
  }
});

router.post('/unlink', async (req, res) => {
  await auth.unlinkSteamAccount(req.session.userId);
  res.json({ ok: true });
});

router.get('/status', async (req, res) => {
  const status = await auth.getSteamLinkStatus(req.session.userId);
  res.json({ linked: !!status.steamId, personaName: status.personaName });
});

router.post('/import', async (req, res) => {
  const status = await auth.getSteamLinkStatus(req.session.userId);
  if (!status.steamId) return res.status(400).json({ error: 'No Steam account linked' });

  try {
    const summary = await steamImport.runImport(req.session.userId, status.steamId);
    res.json(summary);
  } catch (e) {
    console.error('[/api/steam/import]', e);
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
