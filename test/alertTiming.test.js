require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { getTargetLocalHour, getCurrentLocalHour, shouldSendNow, REGION_TIMEZONES } = require('../services/alertTiming');

test('REGION_TIMEZONES covers every region supported by services/store.js', () => {
  const expectedRegions = ['us', 'fr', 'gb', 'de', 'ca', 'au', 'br', 'tr', 'ar', 'pl'];
  for (const region of expectedRegions) {
    assert.ok(REGION_TIMEZONES[region], `missing timezone mapping for region "${region}"`);
  }
});

test('an unrecognized region falls back to a fixed hour instead of crashing', () => {
  const hour = getTargetLocalHour('xx-not-a-real-region', new Date('2026-07-15T12:00:00Z'));
  assert.strictEqual(typeof hour, 'number');
  assert.ok(hour >= 0 && hour <= 23);
});

test('getCurrentLocalHour reflects the actual wall-clock hour in that timezone', () => {
  // 2026-07-15T19:00:00Z is 12:00 in America/Los_Angeles (PDT, UTC-7) that day.
  const at = new Date('2026-07-15T19:00:00Z');
  assert.strictEqual(getCurrentLocalHour('us', at), 15); // America/New_York, EDT UTC-4 -> 15:00
});

test('getTargetLocalHour falls back to a comfortable fixed hour when the noon-Pacific instant would be overnight (Southern winter)', () => {
  // Mid-July: Northern summer (Pacific on PDT), Southern winter (Sydney on AEST, no DST) -> ~5am local, uncomfortable.
  const julyAt = new Date('2026-07-15T12:00:00Z');
  const auHour = getTargetLocalHour('au', julyAt);
  assert.strictEqual(auHour, 9, `expected fallback hour 9 in Southern winter, got ${auHour}`);
});

test('getTargetLocalHour uses the freshest comfortable hour when the noon-Pacific instant lands in daytime (Southern summer)', () => {
  // Mid-January: Southern summer (Sydney on AEDT) -> the noon-Pacific instant lands closer to Sydney's morning.
  const janAt = new Date('2026-01-15T12:00:00Z');
  const auHour = getTargetLocalHour('au', janAt);
  assert.strictEqual(auHour, 7, `expected DST-aware hour 7 in Southern summer, got ${auHour}`);
});

test('shouldSendNow is true only when the current local hour matches the computed target', () => {
  const at = new Date('2026-07-15T19:00:00Z'); // 15:00 in America/New_York
  const target = getTargetLocalHour('us', at);
  assert.strictEqual(shouldSendNow('us', at), target === 15);
});
