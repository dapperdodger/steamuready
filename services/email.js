const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const client = new SESClient({});

const FOOTER_HTML = `<hr/><p style="font-size:12px;color:#888">
  Questions? <a href="mailto:support@steamuready.com">support@steamuready.com</a> ·
  <a href="https://discord.gg/XAt8awGUMM">Discord</a> ·
  <a href="https://ko-fi.com/dapperdodger">Support on Ko-fi</a>
</p>`;
const FOOTER_TEXT = '\n\n---\nQuestions? support@steamuready.com | Discord: https://discord.gg/XAt8awGUMM | Support: https://ko-fi.com/dapperdodger';

let _lastDryRunEmail = null;
function _getLastDryRunEmail() { return _lastDryRunEmail; }

// This only guards against literal newlines (header injection); it does not
// by itself make a value ASCII-safe. Use encodeHeaderValue for headers (like
// Subject) whose value may legitimately contain non-ASCII text.
function sanitizeHeaderValue(value) {
  return String(value).replace(/[\r\n]/g, ' ');
}

// RFC 2047-encodes a header value if it contains non-ASCII characters (e.g.
// accented game names, ™/® symbols, non-Latin scripts from ITAD's catalog).
// Pure-ASCII values pass through unchanged, since headers require ASCII and
// encoding is only needed when that's not already the case.
function encodeHeaderValue(value) {
  const sanitized = sanitizeHeaderValue(value);
  if (/^[\x00-\x7F]*$/.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, 'utf-8').toString('base64')}?=`;
}

// Base64-encodes a MIME part body and wraps it at the RFC 2045-recommended
// 76-character line length, joined with CRLF as required by the format.
function encodePartBody(content) {
  const b64 = Buffer.from(String(content), 'utf-8').toString('base64');
  return (b64.match(/.{1,76}/g) || ['']).join('\r\n');
}

function buildRawMime({ to, subject, html, text, extraHeaders = {} }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const headerLines = [
    `From: SteamUReady <${process.env.SES_FROM_EMAIL}>`,
    `To: ${sanitizeHeaderValue(to)}`,
    'Reply-To: support@steamuready.com',
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${sanitizeHeaderValue(value)}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodePartBody(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodePartBody(html),
    `--${boundary}--`,
  ].join('\r\n');
  return `${headerLines.join('\r\n')}\r\n\r\n${body}`;
}

async function sendEmail(to, subject, html, text, extraHeaders = {}) {
  const raw = buildRawMime({ to, subject, html, text, extraHeaders });
  if (process.env.EMAIL_DRY_RUN === 'true') {
    _lastDryRunEmail = { to, subject, html, text, headers: extraHeaders, raw };
    console.log(`[email:dry-run] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  await client.send(new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw, 'utf-8') } }));
}

function buildVerifyUrl(baseUrl, token) { return `${baseUrl}/api/auth/verify?token=${token}`; }
function buildResetUrl(baseUrl, token) { return `${baseUrl}/?resetToken=${token}`; }

async function sendVerificationEmail(to, token, baseUrl) {
  const url = buildVerifyUrl(baseUrl, token);
  const html = `<p>Click to verify your email:</p><p><a href="${url}">${url}</a></p>${FOOTER_HTML}`;
  const text = `Verify your email: ${url}${FOOTER_TEXT}`;
  await sendEmail(to, 'Verify your SteamUReady email', html, text);
}

async function sendPasswordResetEmail(to, token, baseUrl) {
  const url = buildResetUrl(baseUrl, token);
  const html = `<p>Click to reset your password (expires in 1 hour):</p><p><a href="${url}">${url}</a></p>${FOOTER_HTML}`;
  const text = `Reset your password (expires in 1 hour): ${url}${FOOTER_TEXT}`;
  await sendEmail(to, 'Reset your SteamUReady password', html, text);
}

async function sendPriceAlertDigest(to, items, unsubscribeUrl) {
  const subject = items.length === 1
    ? `${items[0].gameName} just dropped in price!`
    : `${items.length} games on your wishlist just dropped in price!`;
  const rowsHtml = items.map(i =>
    `<li><a href="${i.storeUrl}">${i.gameName}</a> — ${i.priceFormatted} (${i.discountPercent}% off)</li>`
  ).join('');
  const rowsText = items.map(i =>
    `- ${i.gameName}: ${i.priceFormatted} (${i.discountPercent}% off) ${i.storeUrl}`
  ).join('\n');
  const unsubHtml = `<p style="font-size:12px;color:#888"><a href="${unsubscribeUrl}">Unsubscribe from these emails</a></p>`;
  const unsubText = `\nUnsubscribe from these emails: ${unsubscribeUrl}`;
  const html = `<ul>${rowsHtml}</ul>${unsubHtml}${FOOTER_HTML}`;
  const text = `${rowsText}${unsubText}${FOOTER_TEXT}`;
  await sendEmail(to, subject, html, text, {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
}

module.exports = {
  sendVerificationEmail, sendPasswordResetEmail, sendPriceAlertDigest,
  buildVerifyUrl, buildResetUrl, _getLastDryRunEmail,
};
