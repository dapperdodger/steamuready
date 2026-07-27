const express = require('express');
const router = express.Router();
const { verifyUnsubscribeToken } = require('../services/unsubscribeTokens');
const { setAlertsEnabled } = require('../services/auth');

async function handleUnsubscribe(req, res) {
  const userId = req.query.u;
  const token = req.query.token;
  if (typeof userId !== 'string' || !verifyUnsubscribeToken(userId, token)) {
    return res.status(400).send('Invalid or expired unsubscribe link.');
  }
  await setAlertsEnabled(userId, false);
  if (req.method === 'POST') {
    // RFC 8058 one-click unsubscribe: the caller is a mailbox provider issuing
    // an automated POST, not a browser — respond and stop, no redirect.
    return res.status(200).end();
  }
  res.redirect('/?unsubscribed=1');
}

router.get('/unsubscribe', handleUnsubscribe);
router.post('/unsubscribe', handleUnsubscribe);

module.exports = router;
