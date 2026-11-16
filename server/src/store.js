/* Data layer. Default: in-memory store (works without any DB).
 * If DB_URL is set and `pg` is installed, PostgreSQL is used and initialized
 * from ../db/schema.sql. All methods are async for uniformity.
 */
'use strict';
const config = require('./config');
const { randomId } = require('./crypto');

/* ---------------- shop catalog (visual-only items) ---------------- */
const SHOP_CATALOG = [
  { id: 'piece_classic',  kind: 'piece', name: 'کلاسیک',   price: 0 },
  { id: 'piece_ocean',    kind: 'piece', name: 'اقیانوس',  price: 300 },
  { id: 'piece_fire',     kind: 'piece', name: 'آتشین',    price: 600 },
  { id: 'piece_national', kind: 'piece', name: 'ملی‌پوش',  price: 900 },
  { id: 'piece_king',     kind: 'piece', name: 'پادشاه',   price: 1500 },
  { id: 'field_classic',  kind: 'field', name: 'زمین کلاسیک', price: 0 },
  { id: 'field_night',    kind: 'field', name: 'زمین شب',     price: 400 },
  { id: 'field_desert',   kind: 'field', name: 'زمین کویر',   price: 700 },
  { id: 'field_royal',    kind: 'field', name: 'زمین سلطنتی', price: 1200 }
];

function defaultProfile(name) {
  return {
    userId: null, name, rating: 1000, coins: 500, wins: 0, losses: 0, draws: 0,
    goalsFor: 0, goalsAgainst: 0, selectedPiece: 'piece_classic', selectedField: 'field_classic',
    createdAt: Date.now(), lastSeen: Date.now()
  };
}

/* ---------------- memory store ---------------- */
function createMemoryStore() {
  const users = new Map();     // userId -> {userId, name, passHash, createdAt}
  const byName = new Map();    // lower(name) -> userId
  const profiles = new Map();  // userId -> profile
  const inventory = new Map(); // userId -> Set(itemIds)
  const matches = new Map();   // matchId -> match record
  const friendships = new Map(); // key a|b sorted -> {a,b,status,reqBy,createdAt}
  const audit = [];
  // seed: everyone owns the free items
  function seedInv(uid) {
    inventory.set(uid, new Set(['piece_classic', 'field_classic']));
  }
  return {
    kind: 'memory',
    catalog: SHOP_CATALOG,
    async init() {}, // nothing to prepare
    async createUser(name, passHash) {
      const key = name.toLowerCase();
      if (byName.has(key)) return null;
      const userId = 'u_' + randomId(8);
      users.set(userId, { userId, name, passHash, createdAt: Date.now() });
      byName.set(key, userId);
      profiles.set(userId, defaultProfile(name));
      profiles.get(userId).userId = userId;
      seedInv(userId);
      return users.get(userId);
    },
    async getUserByName(name) {
      const uid = byName.get(String(name).toLowerCase());
      return uid ? users.get(uid) : null;
    },
    async getUserById(userId) { return users.get(userId) || null; },
    async getProfile(userId) { return profiles.get(userId) || null; },
    async saveProfile(userId, patch) {
      const p = profiles.get(userId);
      if (!p) return null;
      Object.assign(p, patch, { userId });
      return p;
    },
    async topProfiles(limit) {
      return [...profiles.values()].sort((a, b) => b.rating - a.rating).slice(0, limit || 20);
    },
    async ownsItem(userId, itemId) { const inv = inventory.get(userId); return !!inv && inv.has(itemId); },
    async grantItem(userId, itemId) { inventory.get(userId).add(itemId); },
    async getInventory(userId) { return [...(inventory.get(userId) || [])]; },
    async saveMatch(rec) { matches.set(rec.matchId, rec); },
    async matchHistory(userId, limit) {
      const out = [];
      for (const m of matches.values()) {
        if (m.players.some(p => p.userId === userId)) out.push(m);
      }
      out.sort((a, b) => b.finishedAt - a.finishedAt);
      return out.slice(0, limit || 20);
    },
    async auditLog(event, data) {
      audit.push({ event, data: data || {}, at: Date.now() });
      if (audit.length > 5000) audit.splice(0, 1000);
    },
    async getFriendship(a, b) {
      const key = [a, b].sort().join('|');
      return friendships.get(key) || null;
    },
    async upsertFriendship(a, b, patch) {
      const key = [a, b].sort().join('|');
      const cur = friendships.get(key) || { a, b, status: 'none', reqBy: null, createdAt: Date.now() };
      Object.assign(cur, patch);
      friendships.set(key, cur);
      return cur;
    },
    async listFriendships(userId) {
      const out = [];
      for (const f of friendships.values()) if (f.a === userId || f.b === userId) out.push(f);
      return out;
    }
  };
}

/* ---------------- PostgreSQL store (optional) ---------------- */
function createPgStore(pg) {
  const mem = createMemoryStore(); // fallback for anything not persisted
  return {
    kind: 'postgres',
    catalog: SHOP_CATALOG,
    async init() {
      const fs = require('fs');
      const path = require('path');
      const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
      const client = new pg.Client({ connectionString: config.DB_URL });
      await client.connect();
      await client.query(schema);
      await client.end();
      console.log('[store] PostgreSQL schema ensured');
    },
    async createUser(name, passHash) {
      try {
        const r = await pg.query(
          'INSERT INTO users (username, pass_hash) VALUES ($1,$2) RETURNING id',
          [name, passHash]);
        const uid = r.rows[0].id;
        await pg.query(
          'INSERT INTO profiles (user_id, name) VALUES ($1,$2)', [uid, name]);
        await pg.query(
          'INSERT INTO inventory (user_id, item_id) VALUES ($1,$2),($1,$3)',
          [uid, 'piece_classic', 'field_classic']);
        return { userId: uid, name, passHash, createdAt: Date.now() };
      } catch (e) {
        if (String(e.code) === '23505') return null; // unique violation
        throw e;
      }
    },
    async getUserByName(name) {
      const r = await pg.query('SELECT id, username, pass_hash FROM users WHERE lower(username)=lower($1)', [name]);
      if (!r.rows[0]) return null;
      return { userId: r.rows[0].id, name: r.rows[0].username, passHash: r.rows[0].pass_hash };
    },
    async getUserById(id) {
      const r = await pg.query('SELECT id, username, pass_hash FROM users WHERE id=$1', [id]);
      if (!r.rows[0]) return null;
      return { userId: r.rows[0].id, name: r.rows[0].username, passHash: r.rows[0].pass_hash };
    },
    async getProfile(userId) {
      const r = await pg.query('SELECT * FROM profiles WHERE user_id=$1', [userId]);
      const row = r.rows[0];
      if (!row) return null;
      return {
        userId, name: row.name, rating: row.rating, coins: row.coins,
        wins: row.wins, losses: row.losses, draws: row.draws,
        goalsFor: row.goals_for, goalsAgainst: row.goals_against,
        selectedPiece: row.selected_piece, selectedField: row.selected_field,
        createdAt: new Date(row.created_at).getTime(), lastSeen: Date.now()
      };
    },
    async saveProfile(userId, p) {
      await pg.query(
        `UPDATE profiles SET name=$2, rating=$3, coins=$4, wins=$5, losses=$6, draws=$7,
         goals_for=$8, goals_against=$9, selected_piece=$10, selected_field=$11, last_seen=now()
         WHERE user_id=$1`,
        [userId, p.name, p.rating, p.coins, p.wins, p.losses, p.draws,
         p.goalsFor, p.goalsAgainst, p.selectedPiece, p.selectedField]);
      return p;
    },
    async topProfiles(limit) {
      const r = await pg.query(
        `SELECT p.user_id, p.name, p.rating, p.wins, p.losses, p.draws FROM profiles p
         ORDER BY p.rating DESC LIMIT $1`, [limit || 20]);
      return r.rows.map(x => ({ userId: x.user_id, name: x.name, rating: x.rating, wins: x.wins, losses: x.losses, draws: x.draws }));
    },
    async ownsItem(userId, itemId) {
      const r = await pg.query('SELECT 1 FROM inventory WHERE user_id=$1 AND item_id=$2', [userId, itemId]);
      return r.rows.length > 0;
    },
    async grantItem(userId, itemId) {
      await pg.query('INSERT INTO inventory (user_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, itemId]);
    },
    async getInventory(userId) {
      const r = await pg.query('SELECT item_id FROM inventory WHERE user_id=$1', [userId]);
      return r.rows.map(x => x.item_id);
    },
    async saveMatch(rec) {
      const c = await pg.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO matches (id, mode, target_goals, turn_seconds, status,
             score_a, score_b, winner_user_id, created_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),to_timestamp($10/1000.0))`,
          [rec.matchId, rec.mode, rec.targetGoals, rec.turnSeconds, rec.status,
           rec.scoreA, rec.scoreB, rec.winnerUserId, rec.createdAt, rec.finishedAt]);
        for (const pl of rec.players) {
          await c.query(
            `INSERT INTO match_players (match_id, user_id, team, rating_before, rating_after, elo_delta)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [rec.matchId, pl.userId, pl.team, pl.ratingBefore, pl.ratingAfter, pl.eloDelta]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); mem.saveMatch(rec); throw e; }
      finally { c.release(); }
    },
    async matchHistory(userId, limit) {
      const r = await pg.query(
        `SELECT m.id, m.mode, m.score_a, m.score_b, m.winner_user_id, m.finished_at,
                mp.team, mp.rating_before, mp.rating_after, mp.elo_delta
         FROM match_players mp JOIN matches m ON m.id = mp.match_id
         WHERE mp.user_id=$1 AND m.status='finished'
         ORDER BY m.finished_at DESC LIMIT $2`, [userId, limit || 20]);
      return r.rows.map(x => ({
        matchId: x.id, mode: x.mode, scoreA: x.score_a, scoreB: x.score_b,
        winnerUserId: x.winner_user_id, finishedAt: new Date(x.finished_at).getTime(),
        team: x.team, ratingBefore: x.rating_before, ratingAfter: x.rating_after, eloDelta: x.elo_delta
      }));
    },
    async auditLog(event, data) {
      mem.auditLog(event, data);
      try {
        await pg.query('INSERT INTO audit_log (event, data) VALUES ($1,$2)', [event, JSON.stringify(data || {})]);
      } catch (e) { /* logging must never break the game */ }
    },
    async getFriendship(a, b) {
      const r = await pg.query(
        'SELECT user_id_a, user_id_b, status, req_by FROM friendships WHERE (user_id_a=$1 AND user_id_b=$2) OR (user_id_a=$2 AND user_id_b=$1)',
        [a, b]);
      const x = r.rows[0];
      return x ? { a: x.user_id_a, b: x.user_id_b, status: x.status, reqBy: x.req_by } : null;
    },
    async upsertFriendship(a, b, patch) {
      const cur = await this.getFriendship(a, b) || { a: [a, b].sort()[0], b: [a, b].sort()[1], status: 'none', reqBy: null };
      Object.assign(cur, patch);
      await pg.query(
        `INSERT INTO friendships (user_id_a, user_id_b, status, req_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id_a, user_id_b) DO UPDATE SET status=$3, req_by=$4`,
        [cur.a, cur.b, cur.status, cur.reqBy]);
      return cur;
    },
    async listFriendships(userId) {
      const r = await pg.query(
        'SELECT user_id_a, user_id_b, status, req_by FROM friendships WHERE user_id_a=$1 OR user_id_b=$1', [userId]);
      return r.rows.map(x => ({ a: x.user_id_a, b: x.user_id_b, status: x.status, reqBy: x.req_by }));
    }
  };
}

function createStore() {
  if (config.DB_URL) {
    try {
      // eslint-disable-next-line global-require
      const pg = require('pg');
      console.log('[store] using PostgreSQL');
      return createPgStore(pg);
    } catch (e) {
      console.warn('[store] DB_URL set but `pg` not installed (' + e.message + ') — falling back to memory store. Run: npm install pg');
    }
  }
  console.log('[store] using in-memory store (data resets on restart; set DB_URL for persistence)');
  return createMemoryStore();
}

module.exports = { createStore, SHOP_CATALOG };
