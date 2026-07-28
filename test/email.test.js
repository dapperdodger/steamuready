require('dotenv').config();
process.env.EMAIL_DRY_RUN = 'true';
process.env.SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || 'no-reply@steamuready.com';
const test = require('node:test');
const assert = require('node:assert');
const email = require('../services/email');

// Parses a raw MIME message's multipart/alternative body into its constituent
// parts, decoding each according to its declared Content-Transfer-Encoding so
// tests can assert on round-tripped content rather than raw wire bytes.
function decodeMimeParts(raw) {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headersSection = raw.slice(0, headerEnd);
  const bodySection = raw.slice(headerEnd + 4);
  const boundary = headersSection.match(/boundary="([^"]+)"/)[1];
  const rawParts = bodySection.split(`--${boundary}`).filter(p => p.trim() && p.trim() !== '--');
  return rawParts.map(part => {
    const trimmed = part.replace(/^\r\n/, '');
    const partHeaderEnd = trimmed.indexOf('\r\n\r\n');
    const partHeaders = trimmed.slice(0, partHeaderEnd);
    const partBody = trimmed.slice(partHeaderEnd + 4).replace(/\r\n$/, '');
    const cte = (partHeaders.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [, '7bit'])[1];
    const contentType = (partHeaders.match(/Content-Type:\s*([^;\r\n]+)/i) || [, ''])[1];
    const decoded = cte.toLowerCase() === 'base64'
      ? Buffer.from(partBody.replace(/\r\n/g, ''), 'base64').toString('utf-8')
      : partBody;
    return { contentType, cte, decoded };
  });
}

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
    { gameName: 'Portal 2', priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'https://store.steampowered.com/app/620' },
  ], unsubscribeUrl);
  assert.match(email._getLastDryRunEmail().subject, /Portal 2 just dropped in price!/);

  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x' },
    { gameName: 'Half-Life', priceFormatted: '$2.99', discountPercent: 70, storeUrl: 'y' },
  ], unsubscribeUrl);
  assert.match(email._getLastDryRunEmail().subject, /2 games on your wishlist just dropped in price!/);
});

test('sendPriceAlertDigest includes the game image with correct src/alt, the discount badge, and a store link, matching the app card layout', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    {
      gameName: 'Portal 2', priceFormatted: '$4.99', originalPriceFormatted: '$9.99',
      discountPercent: 50, storeUrl: 'https://store.steampowered.com/app/620',
      imageUrl: 'https://cdn.akamai.steamstatic.com/steam/apps/620/header.jpg',
    },
  ], unsubscribeUrl);
  const html = email._getLastDryRunEmail().html;
  assert.match(html, /<img[^>]+src="https:\/\/cdn\.akamai\.steamstatic\.com\/steam\/apps\/620\/header\.jpg"[^>]*alt="Portal 2"/);
  assert.match(html, /−50%|-50%/); // discount badge text (allow either minus-sign style)
  assert.match(html, /\$9\.99/); // original (strikethrough) price still shown
  assert.match(html, /\$4\.99/); // final price
  assert.match(html, /href="https:\/\/store\.steampowered\.com\/app\/620"/);
});

test('sendPriceAlertDigest HTML-escapes game names so special characters cannot break the markup', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    {
      gameName: '<script>alert(1)</script> & "Quotes" Game',
      priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x', imageUrl: 'y',
    },
  ], unsubscribeUrl);
  const html = email._getLastDryRunEmail().html;
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('sendPriceAlertDigest degrades gracefully when imageUrl/originalPriceFormatted are absent', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'No Image Game', priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x' },
  ], unsubscribeUrl);
  const sent = email._getLastDryRunEmail();
  assert.ok(sent.html.includes('No Image Game'));
});

test('sendPriceAlertDigest uses the region-formatted price string verbatim, not a re-derived USD amount', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', price: 3.99, priceFormatted: '£3.99', discountPercent: 50, storeUrl: 'https://store.steampowered.com/app/620' },
    { gameName: 'Wiedźmin', price: 49.99, priceFormatted: 'zł49.99', discountPercent: 30, storeUrl: 'y' },
  ], unsubscribeUrl);
  const sent = email._getLastDryRunEmail();
  assert.match(sent.text, /£3\.99/);
  assert.match(sent.text, /zł49\.99/);
  assert.match(sent.html, /£3\.99/);
  assert.match(sent.html, /zł49\.99/);
  // Must not fall back to a hardcoded "$" re-derivation of the raw price.
  assert.doesNotMatch(sent.text, /\$3\.99/);
  assert.doesNotMatch(sent.text, /\$49\.99/);
});

test('sendPriceAlertDigest RFC 2047-encodes a non-ASCII subject and it decodes back to the original', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  const gameName = 'Pokémon Company™ Deluxe Edición';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName, priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x' },
  ], unsubscribeUrl);
  const raw = email._getLastDryRunEmail().raw;
  const [headersSection] = raw.split('\r\n\r\n');
  const subjectLine = headersSection.split('\r\n').find(l => l.startsWith('Subject:'));
  assert.ok(subjectLine, 'Subject header exists');
  const subjectValue = subjectLine.slice('Subject: '.length);
  // RFC 5322 requires ASCII header values — confirm no literal non-ASCII bytes leaked through.
  assert.ok(/^[\x00-\x7F]*$/.test(subjectValue), 'Subject header line is pure ASCII on the wire');
  const match = subjectValue.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  assert.ok(match, 'Subject is RFC 2047 base64-encoded');
  const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
  assert.strictEqual(decoded, `${gameName} just dropped in price!`);
});

test('sendVerificationEmail leaves a pure-ASCII subject unencoded', async () => {
  await email.sendVerificationEmail('user@example.com', 'tok', 'http://localhost:3000');
  const raw = email._getLastDryRunEmail().raw;
  assert.match(raw, /Subject: Verify your SteamUReady email\r\n/);
});

test('each MIME part declares a Content-Transfer-Encoding matching how its body is actually encoded, and decodes back to the original text (including the footer\'s non-ASCII · and — characters)', async () => {
  const unsubscribeUrl = 'http://localhost:3000/api/alerts/unsubscribe?u=1&token=x';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', priceFormatted: '£3.99', discountPercent: 50, storeUrl: 'x' },
  ], unsubscribeUrl);
  const sent = email._getLastDryRunEmail();
  const parts = decodeMimeParts(sent.raw);
  assert.strictEqual(parts.length, 2);

  const textPart = parts.find(p => p.contentType.includes('text/plain'));
  const htmlPart = parts.find(p => p.contentType.includes('text/html'));
  assert.ok(textPart && htmlPart, 'both text/plain and text/html parts are present');
  assert.strictEqual(textPart.cte.toLowerCase(), 'base64');
  assert.strictEqual(htmlPart.cte.toLowerCase(), 'base64');

  // Decoded body must round-trip exactly back to the original composed text/html.
  assert.strictEqual(textPart.decoded, sent.text);
  assert.strictEqual(htmlPart.decoded, sent.html);

  // The shared HTML footer already contains · (U+00B7) as a separator, and the
  // digest's discount badge/CTA use − (U+2212 minus) and → (U+2192 arrow);
  // every HTML email sent by this codebase hits this path, so confirm they
  // survive the round trip.
  assert.match(htmlPart.decoded, /·/);
  assert.match(htmlPart.decoded, /−/);
  assert.match(htmlPart.decoded, /→/);
  assert.match(textPart.decoded, /£3\.99/);
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
    { gameName: 'Portal 2', priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x' },
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

test('extraHeaders values are sanitized against header injection (CRLF removal)', async () => {
  const injectionUrl = 'http://example.com\r\nX-Injected: malicious';
  await email.sendPriceAlertDigest('user@example.com', [
    { gameName: 'Portal 2', priceFormatted: '$4.99', discountPercent: 50, storeUrl: 'x' },
  ], injectionUrl);
  const sent = email._getLastDryRunEmail();
  const raw = sent.raw;
  // Split headers from body at the double CRLF
  const [headersSection] = raw.split('\r\n\r\n');
  const headerLines = headersSection.split('\r\n');
  // Verify no line in headers starts with the injected header name
  const hasInjectedHeaderLine = headerLines.some(line => line.startsWith('X-Injected:'));
  assert.strictEqual(hasInjectedHeaderLine, false, 'No line starting with X-Injected: in headers');
  // Verify the List-Unsubscribe header line contains the sanitized URL (CRLF replaced with spaces)
  const listUnsubLine = headerLines.find(line => line.startsWith('List-Unsubscribe:'));
  assert.ok(listUnsubLine, 'List-Unsubscribe header exists');
  assert.match(listUnsubLine, /http:\/\/example\.com  X-Injected: malicious/, 'CRLF replaced with spaces in value');
});
