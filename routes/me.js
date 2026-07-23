const express = require('express');
const { requireAuth } = require('../middleware/session');
const auth = require('../services/auth');

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

module.exports = router;
