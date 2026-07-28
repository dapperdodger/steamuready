require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword } = require('../services/auth');

test('hashPassword produces a bcrypt hash distinct from the input, and verifyPassword round-trips', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notStrictEqual(hash, 'correct horse battery staple');
  assert.match(hash, /^\$2[aby]\$12\$/); // cost factor 12

  assert.strictEqual(await verifyPassword('correct horse battery staple', hash), true);
  assert.strictEqual(await verifyPassword('wrong password', hash), false);
});

test('hashPassword salts each call, producing different hashes for the same password', async () => {
  const [h1, h2] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
  assert.notStrictEqual(h1, h2);
});

const { pool } = require('../services/db');
const {
  createUser, findUserByEmail, findUserById,
  updatePasswordHash, updatePreferences, updateHideOwnedDefault, deleteUser,
} = require('../services/auth');

test('createUser + findUserByEmail + findUserById + updatePreferences + updatePasswordHash + updateHideOwnedDefault + deleteUser', async () => {
  const email = `crud-test-${Date.now()}@example.com`;
  const hash = await hashPassword('initial-password');

  const created = await createUser(email, hash);
  assert.strictEqual(created.email, email);
  assert.deepStrictEqual(created.preferences, {});
  assert.strictEqual(created.hide_owned_default, false);

  const byEmail = await findUserByEmail(email);
  assert.strictEqual(byEmail.id, created.id);
  assert.strictEqual(byEmail.password_hash, hash);

  const byId = await findUserById(created.id);
  assert.strictEqual(byId.email, email);
  assert.strictEqual(byId.hide_owned_default, false);
  assert.strictEqual('password_hash' in byId, false); // never expose the hash from findUserById

  const savedPrefs = await updatePreferences(created.id, { region: 'us' });
  assert.deepStrictEqual(savedPrefs, { region: 'us' });

  const savedHideOwned = await updateHideOwnedDefault(created.id, true);
  assert.strictEqual(savedHideOwned, true);
  assert.strictEqual((await findUserById(created.id)).hide_owned_default, true);

  const newHash = await hashPassword('new-password');
  await updatePasswordHash(created.id, newHash);
  const afterPwUpdate = await findUserByEmail(email);
  assert.strictEqual(afterPwUpdate.password_hash, newHash);

  await deleteUser(created.id);
  assert.strictEqual(await findUserById(created.id), null);
});

test('createUser rejects a duplicate email with a Postgres unique_violation', async () => {
  const email = `dup-test-${Date.now()}@example.com`;
  const hash = await hashPassword('password123');
  const first = await createUser(email, hash);

  await assert.rejects(
    () => createUser(email, hash),
    err => err.code === '23505'
  );

  await deleteUser(first.id);
});

const {
  findUserBySteamId, linkSteamAccount, unlinkSteamAccount, getSteamLinkStatus,
} = require('../services/auth');

test('linkSteamAccount / getSteamLinkStatus / findUserBySteamId / unlinkSteamAccount', async () => {
  const email = `steam-link-${Date.now()}@example.com`;
  const user = await createUser(email, await hashPassword('password123'));

  const before = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(before, { steamId: null, personaName: null });

  const steamId = `7656119${Date.now()}`.slice(0, 17);
  await linkSteamAccount(user.id, steamId, 'CoolGamer42');

  const after = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(after, { steamId, personaName: 'CoolGamer42' });

  const found = await findUserBySteamId(steamId);
  assert.strictEqual(found.id, user.id);

  await unlinkSteamAccount(user.id);
  const afterUnlink = await getSteamLinkStatus(user.id);
  assert.deepStrictEqual(afterUnlink, { steamId: null, personaName: null });
  assert.strictEqual(await findUserBySteamId(steamId), null);

  await deleteUser(user.id);
});
