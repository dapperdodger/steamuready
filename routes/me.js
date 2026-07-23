const express = require('express');
const { requireAuth } = require('../middleware/session');
const auth = require('../services/auth');
const wishlist = require('../services/wishlist');
const store = require('../services/store');

const router = express.Router();
router.use(requireAuth);

router.put('/preferences', async (req, res) => {
  const prefs = req.body;
  if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) {
    return res.status(400).json({ error: 'preferences must be an object' });
  }
  try {
    const saved = await auth.updatePreferences(req.session.userId, prefs);
    res.json({ preferences: saved });
  } catch (e) {
    console.error('[/api/me/preferences]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/hide-owned-default', async (req, res) => {
  const { hideOwnedDefault } = req.body ?? {};
  if (typeof hideOwnedDefault !== 'boolean') {
    return res.status(400).json({ error: 'hideOwnedDefault must be a boolean' });
  }
  try {
    const saved = await auth.updateHideOwnedDefault(req.session.userId, hideOwnedDefault);
    res.json({ hideOwnedDefault: saved });
  } catch (e) {
    console.error('[/api/me/hide-owned-default]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function listWithCards(itadIds, cc) {
  if (!itadIds.length) return [];
  const dealMap = await store.getDealsForItadIds(itadIds, cc, []);
  return itadIds.map(id => dealMap.get(id)).filter(Boolean);
}

router.get('/wishlist', async (req, res) => {
  try {
    const itadIds = await wishlist.listWishlistItadIds(req.session.userId);
    const games = await listWithCards(itadIds, req.query.cc || 'us');
    res.json({ games });
  } catch (e) {
    console.error('[/api/me/wishlist]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/wishlist/:itadId', async (req, res) => {
  try {
    await wishlist.addWishlistItem(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[POST /api/me/wishlist/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/wishlist/:itadId', async (req, res) => {
  try {
    await wishlist.removeWishlistItem(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[DELETE /api/me/wishlist/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/owned', async (req, res) => {
  try {
    const itadIds = await wishlist.listOwnedItadIds(req.session.userId);
    const games = await listWithCards(itadIds, req.query.cc || 'us');
    res.json({ games });
  } catch (e) {
    console.error('[/api/me/owned]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/owned/:itadId', async (req, res) => {
  try {
    await wishlist.addOwned(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[POST /api/me/owned/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/owned/:itadId', async (req, res) => {
  try {
    await wishlist.removeOwned(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[DELETE /api/me/owned/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/hidden', async (req, res) => {
  try {
    const games = await wishlist.listHiddenWithTitles(req.session.userId);
    res.json({ games });
  } catch (e) {
    console.error('[/api/me/hidden]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/hidden/:itadId', async (req, res) => {
  try {
    await wishlist.addHidden(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[POST /api/me/hidden/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/hidden/:itadId', async (req, res) => {
  try {
    await wishlist.removeHidden(req.session.userId, req.params.itadId);
    res.status(204).end();
  } catch (e) {
    console.error('[DELETE /api/me/hidden/:itadId]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
