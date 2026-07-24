const crypto = require('crypto');

// Each call returns a distinct IPv4-shaped string so tests that hit
// rate-limited endpoints (routes/auth.js's authRateLimiter) don't share a
// bucket with other tests. Random, not a sequential counter: node:test runs
// separate test *files* in separate processes, each with its own fresh
// module state, but they all hit the same real (non-flushed) Redis — so a
// counter starting at 0 in every process produced identical IPs across
// files (10.123.0.1, 10.123.0.2, ...), colliding in the shared rate-limit
// keyspace once more than one auth-calling test file existed.
function nextTestIp() {
  const [a, b] = crypto.randomBytes(2);
  return `10.123.${a}.${b}`;
}

module.exports = { nextTestIp };
