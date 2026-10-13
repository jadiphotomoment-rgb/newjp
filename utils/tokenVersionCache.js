'use strict';

const db = require('../database');

// Cache dalam memori: userId -> { token_version, is_active, must_change_password, expiresAt }
const cache = new Map();
const TTL_MS = 15 * 1000; // 15 detik

async function getUserState(userId) {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  const { rows } = await db.query(
    'SELECT token_version, is_active, must_change_password FROM users WHERE id = $1',
    [userId]
  );

  if (rows.length === 0) {
    return null;
  }

  const state = {
    token_version: rows[0].token_version,
    is_active: rows[0].is_active,
    must_change_password: rows[0].must_change_password,
    expiresAt: now + TTL_MS
  };

  cache.set(userId, state);
  return state;
}

function invalidateUserState(userId) {
  if (userId) {
    cache.delete(userId);
  } else {
    cache.clear();
  }
}

module.exports = {
  getUserState,
  invalidateUserState
};
