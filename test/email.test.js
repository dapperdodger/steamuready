require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
process.env.SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'no-reply@steamuready.com';
const test = require('node:test');
const assert = require('node:assert');
const email = require('../services/email');

test('sendVerificationEmail composes a verify link containing the token', async () => {
  await email.sendVerificationEmail('user@example.com', 'abc123token', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.strictEqual(sent.to, 'user@example.com');
  assert.match(sent.text, /http:\/\/localhost:3000\/api\/auth\/verify\?token=abc123token/);
});

test('sendPasswordResetEmail composes a reset link containing the token', async () => {
  await email.sendPasswordResetEmail('user@example.com', 'reset456token', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.match(sent.text, /http:\/\/localhost:3000\/\?resetToken=reset456token/);
});

test('sendPriceAlertDigest uses a singular subject for one game and a plural subject for multiple', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 4.99, discountPercent: 50, storeUrl: 'https://store.steampowered.com/app/620' },
  ], unsubscribeUrl);
  assert.match(email._getLastDryRunEmail().subject, /Portal 2 just dropped in price!/);

  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 4.99, discountPercent: 50, storeUrl: 'x' },
    { gameName: 'Half-Life', price: 2.99, discountPercent: 70, storeUrl: 'y' },
  ], unsubscribeUrl);
  assert.match(email._getLastDryRunEmail().subject, /2 games on your wishlist just dropped in price!/);
});

test('every email includes the support/Discord/Ko-fi footer', async () => {
  await email.sendVerificationEmail('user@example.com', 'tok', 'http://localhost:3000');
  const sent = email._getLastDryRunEmail();
  assert.match(sent.text, /support@steamuready\.com/);
  assert.match(sent.text, /discord\.gg\/XAt8awGUMM/);
  assert.match(sent.text, /ko-fi\.com\/dapperdodger/);
});

test('every email is sent from the no-reply identity and sets Reply-To to the support address', async () => {
  await email.sendVerificationEmail('user@example.com', 'tok', 'http://localhost:3000');
  const raw = email._getLastDryRunEmail().raw;
  assert.match(raw, /From: SteamUReady <no-reply@steamuready\.com>/);
  assert.match(raw, /Reply-To: support@steamuready\.com/);
});

test('the price-alert digest includes the unsubscribe link and RFC 8058 one-click headers, but verify/reset emails do not', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=abc';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 4.99, discountPercent: 50, storeUrl: 'x' },
  ], unsubscribeUrl);
  const digestSent = email._getLastDryRunEmail();
  assert.match(digestSent.text, /Unsubscribe from these emails/);
  assert.strictEqual(digestSent.headers['List-Unsubscribe'], `<${unsubscribeUrl}>`);
  assert.strictEqual(digestSent.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(digestSent.raw, /List-Unsubscribe:/);
  assert.match(digestSent.raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);

  await email.sendVerificationEmail('user@example.com', 'tok', 'http://localhost:3000');
  const verifySent = email._getLastDryRunEmail();
  assert.strictEqual(verifySent.headers['List-Unsubscribe'], undefined);
  assert.doesNotMatch(verifySent.raw, /List-Unsubscribe:/);
});
