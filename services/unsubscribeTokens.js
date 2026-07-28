const crypto = require('crypto');

// Fail fast at startup rather than letting an unset secret throw silently
// inside the hourly price-alert job (buildUnsubscribeUrl -> generateUnsubscribeToken
// -> crypto.createHmac(..., undefined)), which would abort checkRegion for every
// region, every hour, forever, logging only a console.error and sending zero emails.
if (!process.env.UNSUBSCRIBE_SECRET && process.env.EMAIL_DRY_RUN !== 'true') {
  throw new Error('UNSUBSCRIBE_SECRET must be set (unless EMAIL_DRY_RUN=true)');
}

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
