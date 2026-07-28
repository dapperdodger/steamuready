const openid = require('openid');

const STEAM_OPENID_IDENTIFIER = 'https://steamcommunity.com/openid';
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

function buildRelyingParty(returnUrl, realm) {
  // (returnUrl, realm, useStateless, strictMode, extensions)
  return new openid.RelyingParty(returnUrl, realm, true, true, []);
}

function extractSteamId(claimedIdentifier) {
  const match = CLAIMED_ID_RE.exec(claimedIdentifier || '');
  return match ? match[1] : null;
}

function getAuthUrl(returnUrl, realm) {
  return new Promise((resolve, reject) => {
    const rp = buildRelyingParty(returnUrl, realm);
    rp.authenticate(STEAM_OPENID_IDENTIFIER, false, (err, authUrl) => {
      if (err || !authUrl) return reject(err || new Error('Steam did not return an auth URL'));
      resolve(authUrl);
    });
  });
}

function verifyAssertion(req, returnUrl, realm) {
  return new Promise((resolve, reject) => {
    const rp = buildRelyingParty(returnUrl, realm);
    rp.verifyAssertion(req, (err, result) => {
      if (err) return reject(err);
      if (!result || !result.authenticated) return resolve(null);
      resolve(extractSteamId(result.claimedIdentifier));
    });
  });
}

module.exports = { getAuthUrl, verifyAssertion, extractSteamId };
