const crypto = require('crypto');

function generateUnsubscribeToken(userId) {
  return crypto.createHmac('sha256', process.env.UNSUBSCRIBE_SECRET).update(String(userId)).digest('hex');
}

function verifyUnsubscribeToken(userId, token) {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(generateUnsubscribeToken(userId), 'hex');
  const actual = Buffer.from(token, 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function buildUnsubscribeUrl(baseUrl, userId) {
  const token = generateUnsubscribeToken(userId);
  return `${baseUrl}/api/alerts/unsubscribe?u=${userId}&token=${token}`;
}

module.exports = { generateUnsubscribeToken, verifyUnsubscribeToken, buildUnsubscribeUrl };
