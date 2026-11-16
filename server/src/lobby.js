/* Lobby: presence, matchmaking queue, rooms (private codes), invites,
 * WS routing, and match lifecycle wiring (profiles, ratings, coins, history).
 */
'use strict';
const PHYS = require('../../shared/physics.js');
const config = require('./config');
const { Match } = require('./match');
const { roomCode } = require('./crypto');

class Lobby {
  constructor(store) {
    this.store = store;
    this.conns = new Map();      // userId -> ws conn (latest wins)
    this.matches = new Map();    // matchId -> Match
    this.matchByUser = new Map(); // userId -> matchId (active)
    this.queue = [];             // [{userId, rating, ts}]
    this.rooms = new Map();      // code -> {code, host, guest, params, started}
    this.rate = new Map();       // conn -> [timestamps]
  }

  /* ---------- rate limiting ---------- */
  allow(conn) {
    const t = Date.now();
    const arr = (this.rate.get(conn) || []).filter(x => t - x < 5000);
    arr.push(t);
    this.rate.set(conn, arr);
    return arr.length <= config.RATE_MSG_PER_5S;
  }

  send(conn, msg) {
    if (conn && conn.readyState === 1) { try { conn.send(JSON.stringify(msg)); } catch (e) { /* ignore */ } }
  }
  err(conn, code, fa) { this.send(conn, { t: 'error', code, message: fa }); }

  userIdOf(conn) {
    for (const [uid, c] of this.conns) if (c === conn) return uid;
    return null;
  }

  /* ---------- authentication ---------- */
  async onAuth(conn, token) {
    const { verifyToken } = require('./crypto');
    const payload = verifyToken(token);
    if (!payload || !payload.uid) return this.err(conn, 'bad_token', 'نشست نامعتبر است؛ دوباره وارد شوید.');
    const userId = payload.uid;
    const profile = await this.store.getProfile(userId);
    if (!profile) return this.err(conn, 'no_profile', 'پروفایل یافت نشد.');
    const prev = this.conns.get(userId);
    if (prev && prev !== conn && prev.readyState === 1) {
      try { prev.close(4000, 'replaced'); } catch (e) { /* ignore */ }
    }
    this.conns.set(userId, conn);
    conn._userId = userId;
    await this.store.auditLog('auth', { userId });

    // resume an active match (reconnect flow)
    const activeId = this.matchByUser.get(userId);
    if (activeId) {
      const m = this.matches.get(activeId);
      if (m && m.status !== 'ended') {
        const team = m.teamOf(userId);
        if (team >= 0) {
          m.onReconnect(team, conn);
          this.send(conn, { t: 'auth_ok', profile, resumed: true, matchId: m.id });
          return;
        }
      } else {
        this.matchByUser.delete(userId);
      }
    }
    this.send(conn, { t: 'auth_ok', profile });
  }

  /* ---------- matchmaking ---------- */
  async queueJoin(conn) {
    const userId = conn._userId;
    if (!userId) return this.err(conn, 'not_authed', 'ابتدا وارد شوید.');
    if (this.matchByUser.get(userId)) return this.err(conn, 'already_in_match', 'شما داخل مسابقه هستید.');
    if (this.queue.some(q => q.userId === userId)) return;
    const profile = await this.store.getProfile(userId);
    this.queue.push({ userId, rating: profile.rating, ts: Date.now() });
    this.send(conn, { t: 'queued', position: this.queue.length });
    this._tryPair();
  }

  queueLeave(conn) {
    const userId = conn._userId;
    this.queue = this.queue.filter(q => q.userId !== userId);
    this.send(conn, { t: 'queue_left' });
  }

  _tryPair() {
    if (this.queue.length < 2) return;
    const now = Date.now();
    let paired = null;
    for (let i = 0; i < this.queue.length && !paired; i++) {
      for (let j = i + 1; j < this.queue.length; j++) {
        const a = this.queue[i], b = this.queue[j];
        const wait = Math.min(now - a.ts, now - b.ts) / 1000;
        const window = 120 + Math.floor(wait / 5) * 30; // opens over time
        if (Math.abs(a.rating - b.rating) <= window) { paired = [a, b]; break; }
      }
    }
    if (!paired) return;
    const [a, b] = paired;
    this.queue = this.queue.filter(q => q !== a && q !== b);
    this._startMatch(a.userId, b.userId, 'ranked');
  }

  /* ---------- private rooms ---------- */
  async roomCreate(conn, params) {
    const userId = conn._userId;
    if (!userId) return this.err(conn, 'not_authed', 'ابتدا وارد شوید.');
    if (this.matchByUser.get(userId)) return this.err(conn, 'already_in_match', 'شما داخل مسابقه هستید.');
    let code = roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const room = {
      code, host: userId, guest: null, started: false,
      params: {
        targetGoals: clampInt(params && params.targetGoals, 1, 5, config.TARGET_GOALS),
        turnSeconds: clampInt(params && params.turnSeconds, 5, 30, config.TURN_SECONDS)
      }
    };
    this.rooms.set(code, room);
    this.send(conn, { t: 'room_created', code, params: room.params });
    await this.store.auditLog('room_create', { userId, code });
  }

  async roomJoin(conn, msg) {
    const userId = conn._userId;
    const code = String((msg && msg.code) || '').toUpperCase();
    const room = this.rooms.get(code);
    if (!room) return this.err(conn, 'room_not_found', 'اتاقی با این کد وجود ندارد.');
    if (room.started) return this.err(conn, 'room_started', 'این اتاق بازی را شروع کرده است.');
    if (room.host === userId) return this.err(conn, 'already_host', 'شما میزبان این اتاق هستید.');
    if (room.guest && room.guest !== userId) return this.err(conn, 'room_full', 'اتاق پر است.');
    if (this.matchByUser.get(userId)) return this.err(conn, 'already_in_match', 'شما داخل مسابقه هستید.');
    room.guest = userId;
    const hostConn = this.conns.get(room.host);
    this.send(conn, { t: 'room_joined', code, params: room.params });
    if (hostConn) this.send(hostConn, { t: 'room_guest_joined', code });
    room.started = true;
    this._startMatch(room.host, userId, 'friendly', room.params);
  }

  /* ---------- friend invite (WS for live delivery) ---------- */
  async inviteFriend(conn, msg) {
    const userId = conn._userId;
    const target = String((msg && msg.userId) || '');
    const targetConn = this.conns.get(target);
    const myProfile = await this.store.getProfile(userId);
    if (!targetConn || targetConn.readyState !== 1) {
      return this.err(conn, 'friend_offline', 'دوست شما آنلاین نیست.');
    }
    if (this.matchByUser.get(target)) return this.err(conn, 'friend_busy', 'دوست شما در مسابقه است.');
    const inviteId = 'i_' + Math.random().toString(36).slice(2, 10);
    this._invites = this._invites || new Map();
    this._invites.set(inviteId, { from: userId, to: target, ts: Date.now() });
    this.send(targetConn, { t: 'invite', inviteId, from: userId, fromName: myProfile.name });
    this.send(conn, { t: 'invite_sent', inviteId });
  }

  async inviteAccept(conn, msg) {
    const userId = conn._userId;
    const inviteId = String((msg && msg.inviteId) || '');
    const inv = this._invites && this._invites.get(inviteId);
    if (!inv || inv.to !== userId) return this.err(conn, 'invite_invalid', 'دعوت معتبر نیست.');
    this._invites.delete(inviteId);
    if (this.matchByUser.get(inv.from) || this.matchByUser.get(userId)) {
      return this.err(conn, 'friend_busy', 'یکی از دو بازیکن در مسابقه است.');
    }
    this._startMatch(inv.from, userId, 'friendly');
  }

  /* ---------- match lifecycle ---------- */
  async _startMatch(uidA, uidB, mode, params) {
    const [pa, pb] = await Promise.all([this.store.getProfile(uidA), this.store.getProfile(uidB)]);
    if (!pa || !pb) return;
    const match = new Match({
      mode, params: params || {},
      targetGoals: (params && params.targetGoals) || config.TARGET_GOALS,
      turnSeconds: (params && params.turnSeconds) || config.TURN_SECONDS,
      players: {
        0: { userId: uidA, name: pa.name, rating: pa.rating, conn: this.conns.get(uidA) },
        1: { userId: uidB, name: pb.name, rating: pb.rating, conn: this.conns.get(uidB) }
      },
      onEnded: (rec) => this._onMatchEnded(rec),
      onRematchReady: (m) => this._onRematchReady(m)
    });
    this.matches.set(match.id, match);
    this.matchByUser.set(uidA, match.id);
    this.matchByUser.set(uidB, match.id);
    const base = {
      t: 'match_found', matchId: match.id, mode, formation: PHYS.snapshot(match.sim),
      targetGoals: match.targetGoals, turnSeconds: match.turnSeconds
    };
    this.send(this.conns.get(uidA), { ...base, team: 0, opponent: { name: pb.name, rating: pb.rating }, you: pa });
    this.send(this.conns.get(uidB), { ...base, team: 1, opponent: { name: pa.name, rating: pa.rating }, you: pb });
    await this.store.auditLog('match_start', { matchId: match.id, mode, a: uidA, b: uidB });
  }

  async _onMatchEnded(rec) {
    const m = this.matches.get(rec.matchId);
    this.matchByUser.delete(rec.players[0].userId);
    this.matchByUser.delete(rec.players[1].userId);
    try {
      for (let i = 0; i < 2; i++) {
        const userId = rec.players[i].userId;
        const p = await this.store.getProfile(userId);
        if (!p) continue;
        if (rec.mode === 'ranked') {
          const won = rec.won[i];
          p.rating = Math.max(100, p.rating + rec.rankDelta[i]);
          p.coins += rec.coinDelta[i];
          p.wins += won ? 1 : 0;
          p.losses += won ? 0 : 1;
          p.goalsFor += rec.goalsFor[i];
          p.goalsAgainst += rec.goalsAgainst[i];
          await this.store.saveProfile(userId, p);
        }
        const conn = this.conns.get(userId);
        const fresh = await this.store.getProfile(userId);
        if (conn) this.send(conn, { t: 'profile_update', profile: fresh });
      }
      await this.store.saveMatch(rec);
      await this.store.auditLog('match_end', { matchId: rec.matchId, winner: rec.winnerUserId, scores: [rec.scoreA, rec.scoreB] });
    } catch (e) {
      console.error('[lobby] match end persistence failed:', e.message);
    }
  }

  async _onRematchReady(oldMatch) {
    const a = oldMatch.players[0].userId, b = oldMatch.players[1].userId;
    if (this.matchByUser.get(a) || this.matchByUser.get(b)) return;
    this._startMatch(a, b, oldMatch.mode, { targetGoals: oldMatch.targetGoals, turnSeconds: oldMatch.turnSeconds });
  }

  /* ---------- connection close ---------- */
  onConnClosed(conn) {
    this.rate.delete(conn);
    const userId = conn._userId;
    if (!userId) return;
    // Only act when the closed socket is the user's CURRENT connection.
    // A replaced socket (new login) closing must not kick the user out of
    // queues, matches or rooms.
    const isCurrent = this.conns.get(userId) === conn;
    if (isCurrent) {
      this.conns.delete(userId);
      this.queue = this.queue.filter(q => q.userId !== userId);
    }
    const activeId = this.matchByUser.get(userId);
    if (isCurrent && activeId) {
      const m = this.matches.get(activeId);
      if (m && m.status !== 'ended') {
        const team = m.teamOf(userId);
        if (team >= 0) m.onDisconnect(team);
      }
    }
    // cleanup empty rooms hosted by this user (only on a real leave)
    if (isCurrent) {
      for (const [code, room] of this.rooms) {
        if (room.host === userId && !room.started) this.rooms.delete(code);
      }
    }
  }

  /* ---------- WS message router ---------- */
  async onMessage(conn, raw) {
    if (!this.allow(conn)) {
      return this.err(conn, 'rate_limited', 'تعداد پیام‌ها بیش از حد مجاز است.');
    }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return this.err(conn, 'bad_json', 'پیام نامعتبر.'); }
    if (!msg || typeof msg.t !== 'string') return this.err(conn, 'bad_message', 'پیام نامعتبر.');

    switch (msg.t) {
      case 'auth': return this.onAuth(conn, msg.token);
      case 'queue_join': return this.queueJoin(conn);
      case 'queue_leave': return this.queueLeave(conn);
      case 'room_create': return this.roomCreate(conn, msg.params);
      case 'room_join': return this.roomJoin(conn, msg);
      case 'invite_friend': return this.inviteFriend(conn, msg);
      case 'invite_accept': return this.inviteAccept(conn, msg);
      case 'ping': return this.send(conn, { t: 'pong', serverTime: Date.now() });
      case 'move': {
        const userId = conn._userId;
        const activeId = userId && this.matchByUser.get(userId);
        if (!activeId) return this.err(conn, 'no_match', 'مسابقه فعالی ندارید.');
        const m = this.matches.get(activeId);
        if (!m) return this.err(conn, 'no_match', 'مسابقه فعالی ندارید.');
        const r = m.onMove(userId, msg);
        if (!r.ok) return this.err(conn, r.code, MOVE_ERRORS[r.code] || 'حرکت نامعتبر است.');
        return;
      }
      case 'resign': {
        const userId = conn._userId;
        const activeId = userId && this.matchByUser.get(userId);
        const m = activeId && this.matches.get(activeId);
        if (!m) return this.err(conn, 'no_match', 'مسابقه فعالی ندارید.');
        const r = m.onResign(userId);
        if (!r.ok) return this.err(conn, r.code, 'امکان تسلیم نیست.');
        return;
      }
      case 'rematch_ok': {
        const userId = conn._userId;
        const m = this.matches.get(this.matchByUser.get(userId) || '');
        // after end, matchByUser is cleared; fall back to last match lookup
        const target = m && m.status === 'ended' ? m : this._lastMatchOf(userId);
        if (!target) return this.err(conn, 'no_match', 'مسابقه‌ای برای دوباره وجود ندارد.');
        const r = target.onRematch(userId);
        if (!r.ok) return this.err(conn, r.code, 'امکان درخواست بازی دوباره نیست.');
        return;
      }
      default:
        return this.err(conn, 'unknown_type', 'نوع پیام شناخته‌شده نیست.');
    }
  }

  _lastMatchOf(userId) {
    let found = null;
    for (const m of this.matches.values()) {
      if (m.status === 'ended' && m.teamOf(userId) >= 0) found = m;
    }
    return found;
  }
}

const MOVE_ERRORS = {
  not_your_turn: 'الان نوبت شما نیست.',
  shot_in_flight: 'منتظر توقف مهره‌ها بمانید.',
  power_out_of_range: 'قدرت ضربه خارج از بازه مجاز است.',
  bad_piece: 'این مهره متعلق به شما نیست.',
  turn_expired: 'زمان نوبت به پایان رسیده بود.',
  cannot_shoot: 'در حال حاضر ضربه ممکن نیست.',
  not_in_match: 'شما در این مسابقه نیستید.'
};

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

module.exports = { Lobby };
