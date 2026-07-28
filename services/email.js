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

// Game names/store URLs come from ITAD's catalog, not from our own trusted
// templates — escape before interpolating into HTML so a title containing
// `<`, `&`, `"`, etc. can't break the markup.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

// Mirrors the app's own card styling (public/style.css `:root` tokens, hex'd
// literally since email clients don't support CSS custom properties):
// --bg #0d1117, --surface #161b22, --card #1c2333, --border #21262d,
// --text #e6edf3, --muted #8b949e, --steam-blue #66c0f4 (price-final),
// discount-badge bg #4c6741 / text #a4d97a, .btn-steam bg #1b2838 / border
// #2a475e / text #66c0f4. Table-based layout (not flex/grid) for
// compatibility with clients like Outlook desktop that don't support them.
function buildDigestItemHtml(i) {
  const name = escapeHtml(i.gameName);
  const originalPrice = i.originalPriceFormatted
    ? `<span style="color:#8b949e;font-size:12px;text-decoration:line-through;margin-right:6px;">${escapeHtml(i.originalPriceFormatted)}</span>`
    : '';
  const imageCell = i.imageUrl
    ? `<td width="120" style="padding:12px;vertical-align:top;">
         <img src="${escapeHtml(i.imageUrl)}" alt="${name}" width="100" style="display:block;width:100px;height:auto;border-radius:4px;" />
       </td>`
    : '';
  return `
    <tr>
      <td style="padding:0 20px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1c2333;border:1px solid #21262d;border-radius:8px;">
          <tr>
            ${imageCell}
            <td style="padding:12px 12px 12px ${i.imageUrl ? '0' : '12px'};vertical-align:top;">
              <div style="color:#e6edf3;font-size:14px;font-weight:700;margin-bottom:6px;">${name}</div>
              <div style="margin-bottom:10px;">
                ${originalPrice}<span style="color:#66c0f4;font-size:15px;font-weight:800;">${escapeHtml(i.priceFormatted)}</span>
                <span style="background:#4c6741;color:#a4d97a;font-size:11px;font-weight:800;padding:2px 6px;border-radius:4px;margin-left:6px;">−${i.discountPercent}%</span>
              </div>
              <a href="${escapeHtml(i.storeUrl)}" style="display:inline-block;background:#1b2838;border:1px solid #2a475e;color:#66c0f4;font-size:12px;font-weight:600;padding:6px 14px;border-radius:4px;text-decoration:none;">View Deal →</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

async function sendPriceAlertDigest(to, items, unsubscribeUrl) {
  const subject = items.length === 1
    ? `${items[0].gameName} just dropped in price!`
    : `${items.length} games on your wishlist just dropped in price!`;
  const intro = items.length === 1
    ? 'A game on your wishlist just dropped in price:'
    : `${items.length} games on your wishlist just dropped in price:`;
  const rowsText = items.map(i =>
    `- ${i.gameName}: ${i.priceFormatted} (${i.discountPercent}% off) ${i.storeUrl}`
  ).join('\n');
  const unsubText = `\nUnsubscribe from these emails: ${unsubscribeUrl}`;
  const html = `
    <div style="background:#0d1117;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#161b22;border:1px solid #21262d;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:20px 20px 4px;">
          <span style="color:#66c0f4;font-size:18px;font-weight:800;">SteamUReady</span>
        </td></tr>
        <tr><td style="padding:0 20px 16px;color:#e6edf3;font-size:15px;">${escapeHtml(intro)}</td></tr>
        ${items.map(buildDigestItemHtml).join('')}
        <tr><td style="padding:4px 20px 20px;">
          <a href="${unsubscribeUrl}" style="color:#8b949e;font-size:12px;">Unsubscribe from these emails</a>
        </td></tr>
      </table>
    </div>
    ${FOOTER_HTML}`;
  const text = `${intro}\n\n${rowsText}${unsubText}${FOOTER_TEXT}`;
  await sendEmail(to, subject, html, text, {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
}

module.exports = {
  sendVerificationEmail, sendPasswordResetEmail, sendPriceAlertDigest,
  buildVerifyUrl, buildResetUrl, _getLastDryRunEmail,
};
