/* Crypto utilities: JWT (HS256) + scrypt password hashing. Zero external deps. */
'use strict';
const crypto = require('crypto');
const config = require('./config');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlJSON(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }

function signToken(payload) {
  const header = b64urlJSON({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJSON({ ...payload, exp: Math.floor(Date.now() / 1000) + config.TOKEN_TTL_HOURS * 3600 });
  const sig = b64url(crypto.createHmac('sha256', config.JWT_SECRET).update(header + '.' + body).digest());
  return header + '.' + body + '.' + sig;
}

// returns payload or null
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expect = b64url(crypto.createHmac('sha256', config.JWT_SECRET).update(h + '.' + b).digest());
  const a = Buffer.from(s), e = Buffer.from(expect);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(b).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function checkPassword(password, stored) {
  if (typeof stored !== 'string' || stored.indexOf(':') < 0) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expect = Buffer.from(hashHex, 'hex');
  const got = crypto.scryptSync(String(password), salt, expect.length, { N: 16384, r: 8, p: 1 });
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

function randomId(bytes) { return crypto.randomBytes(bytes || 8).toString('hex'); }

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
  return s;
}

module.exports = { signToken, verifyToken, hashPassword, checkPassword, randomId, roomCode };
