/* Config from environment (all secrets stay in env, never in code). */
'use strict';
module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  HOST: process.env.HOST || '0.0.0.0',
  JWT_SECRET: process.env.JWT_SECRET || '',
  TOKEN_TTL_HOURS: parseInt(process.env.TOKEN_TTL_HOURS || '72', 10),
  DB_URL: process.env.DB_URL || '',          // e.g. postgres://user:pass@postgres:5432/soccer
  REDIS_URL: process.env.REDIS_URL || '',    // optional
  TURN_SECONDS: parseInt(process.env.TURN_SECONDS || '10', 10),
  TARGET_GOALS: parseInt(process.env.TARGET_GOALS || '3', 10),
  RECONNECT_GRACE_SECONDS: parseInt(process.env.RECONNECT_GRACE_SECONDS || '60', 10),
  AUTO_SHOT_POWER: parseFloat(process.env.AUTO_SHOT_POWER || '0.55'),
  RATE_MSG_PER_5S: parseInt(process.env.RATE_MSG_PER_5S || '40', 10),
  COIN_WIN: parseInt(process.env.COIN_WIN || '50', 10),
  COIN_DRAW: parseInt(process.env.COIN_DRAW || '20', 10),
  COIN_LOSS: parseInt(process.env.COIN_LOSS || '15', 10),
  COIN_GOAL: parseInt(process.env.COIN_GOAL || '10', 10),
  ELO_K: parseInt(process.env.ELO_K || '32', 10),
  MAX_NAME_LEN: 20,
  STATIC_CLIENT: process.env.STATIC_CLIENT || ''
};
if (!module.exports.JWT_SECRET) {
  console.warn('[config] JWT_SECRET not set — using an insecure dev default. SET IT IN PRODUCTION via .env');
  module.exports.JWT_SECRET = 'dev-insecure-secret-change-me';
}
