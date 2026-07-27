const REGION_TIMEZONES = {
  us: 'America/New_York',
  ca: 'America/Toronto',
  br: 'America/Sao_Paulo',
  ar: 'America/Argentina/Buenos_Aires',
  gb: 'Europe/London',
  fr: 'Europe/Paris',
  de: 'Europe/Berlin',
  pl: 'Europe/Warsaw',
  tr: 'Europe/Istanbul',
  au: 'Australia/Sydney',
};

const FALLBACK_TIMEZONE = 'Etc/UTC';
const FALLBACK_HOUR = 9;
const COMFORTABLE_MIN_HOUR = 7;
const COMFORTABLE_MAX_HOUR = 22;
const PACIFIC_TZ = 'America/Los_Angeles';
const PACIFIC_ANCHOR_HOUR = 12; // noon Pacific = 2h after Steam's confirmed 10am-PT deal refresh

function getLocalHour(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).formatToParts(at);
  return parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
}

function getUtcOffsetHours(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours + (hours < 0 ? -minutes / 60 : minutes / 60);
}

function getCurrentLocalHour(region, at = new Date()) {
  return getLocalHour(REGION_TIMEZONES[region] || FALLBACK_TIMEZONE, at);
}

function getTargetLocalHour(region, at = new Date()) {
  const timeZone = REGION_TIMEZONES[region] || FALLBACK_TIMEZONE;
  const pacificOffset = getUtcOffsetHours(PACIFIC_TZ, at);
  const regionOffset = getUtcOffsetHours(timeZone, at);
  const noonPacificUtcHour = (PACIFIC_ANCHOR_HOUR - pacificOffset + 24) % 24;
  const localHourAtAnchor = Math.round((noonPacificUtcHour + regionOffset + 24) % 24);
  if (localHourAtAnchor >= COMFORTABLE_MIN_HOUR && localHourAtAnchor <= COMFORTABLE_MAX_HOUR) {
    return localHourAtAnchor;
  }
  return FALLBACK_HOUR;
}

function shouldSendNow(region, at = new Date()) {
  return getCurrentLocalHour(region, at) === getTargetLocalHour(region, at);
}

module.exports = { getTargetLocalHour, getCurrentLocalHour, shouldSendNow, REGION_TIMEZONES };
