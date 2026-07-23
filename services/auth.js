const bcrypt = require('bcrypt');

const BCRYPT_COST = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

module.exports = { hashPassword, verifyPassword };
