let counter = 0;

// Each call returns a distinct IPv4-shaped string so tests that hit
// rate-limited endpoints (routes/auth.js's authRateLimiter) don't share a
// bucket with other tests running in the same `npm test` invocation.
function nextTestIp() {
  counter += 1;
  return `10.123.${Math.floor(counter / 255) % 255}.${counter % 255}`;
}

module.exports = { nextTestIp };
