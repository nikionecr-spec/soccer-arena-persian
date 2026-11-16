/* Authoritative match controller.
 * The server owns the physics simulation. Clients send only {pieceId, angle, power};
 * this module validates the turn, quantizes the launch velocity to integers
 * (cross-engine determinism, see shared/physics.js), simulates to rest and
 * broadcasts {shot, events, final state} to both players.
 */
'use strict';
const PHYS = require('../../shared/physics.js');
const config = require('./config');
const { randomId } = require('./crypto');

function now() { return Date.now(); }

function eloUpdate(ra, rb, scoreA, K) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const eb = 1 - ea;
  const dA = Math.round(K * (scoreA - ea));
  return { dA, dB: -dA };
}

class Match {
  constructor(opts) {
    this.id = 'm_' + randomId(6);
    this.mode = opts.mode || 'ranked';               // ranked | friendly
    this.targetGoals = opts.targetGoals || config.TARGET_GOALS;
    this.turnSeconds = opts.turnSeconds || config.TURN_SECONDS;
    this.players = opts.players;                     // {0:{userId,name,rating,profileRef,conn}, 1:{...}}
    this.onEnded = opts.onEnded || (() => {});
    this.onRematchReady = opts.onRematchReady || (() => {});

    this.sim = PHYS.createSim();
    this.turnTeam = 0;                               // team A kicks off
    this.turnIndex = 0;
    this.scores = [0, 0];
    this.status = 'turn';                            // turn | anim | ended
    this.deadline = now() + this.turnSeconds * 1000;
    this.disconnectedAt = [0, 0];
    this.rematch = [false, false];
    this.createdAt = now();
    this._timer = setTimeout(() => this._onTurnTimeout(), this.turnSeconds * 1000);
    this._broadcastTurnStart();
  }

  teamOf(userId) {
    if (this.players[0] && this.players[0].userId === userId) return 0;
    if (this.players[1] && this.players[1].userId === userId) return 1;
    return -1;
  }

  send(team, msg) {
    const c = this.players[team] && this.players[team].conn;
    if (c && c.readyState === 1) { try { c.send(JSON.stringify(msg)); } catch (e) { /* ignore */ } }
  }
  broadcast(msg) { this.send(0, msg); this.send(1, msg); }

  _broadcastTurnStart() {
    this.broadcast({
      t: 'turn_start', turn: this.turnTeam, turnIndex: this.turnIndex,
      deadline: this.deadline, seconds: this.turnSeconds,
      scores: this.scores
    });
  }

  /* ---------- move handling (anti-cheat core) ---------- */
  onMove(userId, msg) {
    if (this.status === 'ended') return { ok: false, code: 'match_ended' };
    const team = this.teamOf(userId);
    if (team < 0) return { ok: false, code: 'not_in_match' };
    if (this.status !== 'turn') return { ok: false, code: 'shot_in_flight' };
    if (this.turnTeam !== team) return { ok: false, code: 'not_your_turn' };
    if (now() > this.deadline + 1500) return { ok: false, code: 'turn_expired' }; // small grace for latency

    const pieceId = String(msg.pieceId || '');
    const power = Number(msg.power);
    const angle = Number(msg.angle);
    if (!Number.isFinite(angle) || !Number.isFinite(power)) return { ok: false, code: 'bad_move' };
    if (power < 0 || power > 1) return { ok: false, code: 'power_out_of_range' };
    // piece ownership check happens inside PHYS.shoot as well; pre-check for error reporting
    const piece = PHYS.bodyById(this.sim, pieceId);
    if (!piece || piece.team !== team) return { ok: false, code: 'bad_piece' };

    const okShot = PHYS.shoot(this.sim, team, pieceId, angle, power);
    if (!okShot) return { ok: false, code: 'cannot_shoot' };

    clearTimeout(this._timer);
    this.status = 'anim';
    // capture the launch velocity IMMEDIATELY (body reference mutates during sim)
    const launched = PHYS.bodyById(this.sim, pieceId);
    const launchVx = launched.vx, launchVy = launched.vy;
    const result = PHYS.runToEnd(this.sim, true);
    // Quantize the settled state to the wire format (0.1). From now on, the
    // server and every client shoot from the exact same quantized state,
    // which makes replays bit-identical for the whole match.
    PHYS.applySnapshot(this.sim, PHYS.snapshot(this.sim));

    const goals = result.events.filter(e => e.t === 'goal');
    let scoredTeam = -1;
    for (const g of goals) {
      scoredTeam = g.scoringTeam;
      this.scores[g.scoringTeam] += 1;
    }

    const payload = {
      t: 'shot_result',
      pieceId,
      vx: launchVx, vy: launchVy,
      power: Math.round(power * 100) / 100,
      auto: false,
      events: result.events,
      frames: result.frames,
      final: PHYS.snapshot(this.sim),
      scores: this.scores,
      scored: scoredTeam
    };

    // decide next state
    const over = this.scores[0] >= this.targetGoals || this.scores[1] >= this.targetGoals;
    this.broadcast(payload);

    if (over) {
      this._finish(scoredTeam);
    } else if (scoredTeam >= 0) {
      // reset formation; conceding team kicks off
      this._resetForKickoff(1 - scoredTeam);
    } else {
      this.turnTeam = 1 - team;
      this.turnIndex += 1;
      this.status = 'turn';
      this.deadline = now() + this.turnSeconds * 1000;
      this._timer = setTimeout(() => this._onTurnTimeout(), this.turnSeconds * 1000);
      this._broadcastTurnStart();
    }
    return { ok: true };
  }

  _resetForKickoff(kickTeam) {
    this.sim = PHYS.createSim();          // formation reset, ball center
    this.turnTeam = kickTeam;
    this.turnIndex += 1;
    this.status = 'turn';
    this.deadline = now() + this.turnSeconds * 1000;
    this._timer = setTimeout(() => this._onTurnTimeout(), this.turnSeconds * 1000);
    this.broadcast({ t: 'goal_reset', kickoff: kickTeam, scores: this.scores, formation: PHYS.snapshot(this.sim) });
    this._broadcastTurnStart();
  }

  /* ---------- timeout: server plays a safe auto shot ---------- */
  _onTurnTimeout() {
    if (this.status !== 'turn') return;
    const team = this.turnTeam;
    const ball = PHYS.bodyById(this.sim, 'ball');
    let best = null, bestD = Infinity;
    for (const b of this.sim.bodies) {
      if (b.kind !== 'piece' || b.team !== team) continue;
      const d = Math.hypot(b.x - ball.x, b.y - ball.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) { this._skipTurn(); return; }
    // server-side Math.atan2 is fine: the resulting integer velocity is what
    // gets broadcast, so clients never recompute trigonometry.
    const angle = Math.atan2(ball.y - best.y, ball.x - best.x);
    PHYS.shoot(this.sim, team, best.id, angle, config.AUTO_SHOT_POWER);
    this.status = 'anim';
    const launched = PHYS.bodyById(this.sim, best.id);
    const launchVx = launched.vx, launchVy = launched.vy;
    const result = PHYS.runToEnd(this.sim, true);
    PHYS.applySnapshot(this.sim, PHYS.snapshot(this.sim)); // quantize like clients
    const goals = result.events.filter(e => e.t === 'goal');
    let scoredTeam = -1;
    for (const g of goals) { scoredTeam = g.scoringTeam; this.scores[g.scoringTeam] += 1; }
    this.broadcast({
      t: 'shot_result', pieceId: best.id, vx: launchVx, vy: launchVy,
      power: config.AUTO_SHOT_POWER, auto: true, events: result.events,
      frames: result.frames, final: PHYS.snapshot(this.sim),
      scores: this.scores, scored: scoredTeam
    });
    const over = this.scores[0] >= this.targetGoals || this.scores[1] >= this.targetGoals;
    if (over) this._finish(scoredTeam);
    else if (scoredTeam >= 0) this._resetForKickoff(1 - scoredTeam);
    else this._skipTurn();
  }

  _skipTurn() {
    this.turnTeam = 1 - this.turnTeam;
    this.turnIndex += 1;
    this.status = 'turn';
    this.deadline = now() + this.turnSeconds * 1000;
    this._timer = setTimeout(() => this._onTurnTimeout(), this.turnSeconds * 1000);
    this._broadcastTurnStart();
  }

  /* ---------- disconnect / reconnect ---------- */
  onDisconnect(team) {
    this.disconnectedAt[team] = now();
    this.broadcast({ t: 'opponent_left', team, graceSeconds: config.RECONNECT_GRACE_SECONDS });
    this._graceTimer = setTimeout(() => {
      const c = this.players[team] && this.players[team].conn;
      const online = c && c.readyState === 1;
      if (!online && this.status !== 'ended') this._finish(1 - team, 'forfeit');
    }, config.RECONNECT_GRACE_SECONDS * 1000);
  }

  onReconnect(team, conn) {
    clearTimeout(this._graceTimer);
    this.players[team].conn = conn;
    // full state for seamless resume
    conn.send(JSON.stringify({
      t: 'state_sync', matchId: this.id, mode: this.mode, team,
      turn: this.turnTeam, turnIndex: this.turnIndex, deadline: this.deadline,
      scores: this.scores, formation: PHYS.snapshot(this.sim),
      status: this.status, targetGoals: this.targetGoals
    }));
    this.send(1 - team, { t: 'opponent_rejoin', team });
    if (this.status === 'turn') this._broadcastTurnStart();
  }

  /* ---------- resign / rematch / finish ---------- */
  onResign(userId) {
    const team = this.teamOf(userId);
    if (team < 0 || this.status === 'ended') return { ok: false, code: 'not_in_match' };
    this._finish(1 - team, 'resign');
    return { ok: true };
  }

  onRematch(userId) {
    const team = this.teamOf(userId);
    if (team < 0 || this.status !== 'ended') return { ok: false, code: 'match_not_ended' };
    this.rematch[team] = true;
    this.broadcast({ t: 'rematch_status', rematch: this.rematch });
    if (this.rematch[0] && this.rematch[1]) this.onRematchReady(this);
    return { ok: true };
  }

  _finish(winnerTeam, reason) {
    if (this.status === 'ended') return;
    clearTimeout(this._timer);
    clearTimeout(this._graceTimer);
    this.status = 'ended';
    this.finishedAt = now();

    const [pa, pb] = [this.players[0], this.players[1]];
    const draw = false; // goals-based match always has a winner here
    let dA = 0, dB = 0;
    if (this.mode === 'ranked') {
      ({ dA, dB } = eloUpdate(pa.rating, pb.rating, winnerTeam === 0 ? 1 : 0, config.ELO_K));
    }
    const rankDelta = [dA, dB];
    const coinDelta = [0, 0];
    if (this.mode === 'ranked') {
      for (const team of [0, 1]) {
        const won = team === winnerTeam;
        coinDelta[team] = won ? config.COIN_WIN : (draw ? config.COIN_DRAW : config.COIN_LOSS);
        coinDelta[team] += this.scores[team] * config.COIN_GOAL;
      }
    }

    this.broadcast({
      t: 'match_end', winner: winnerTeam, reason: reason || 'goals',
      scores: this.scores,
      rankDelta: { 0: rankDelta[0], 1: rankDelta[1] },
      coinDelta: { 0: coinDelta[0], 1: coinDelta[1] }
    });

    // persist match + profile updates via callback (lobby wires the store)
    this.onEnded({
      matchId: this.id, mode: this.mode, targetGoals: this.targetGoals,
      turnSeconds: this.turnSeconds, status: 'finished',
      scoreA: this.scores[0], scoreB: this.scores[1],
      winnerUserId: this.players[winnerTeam].userId,
      createdAt: this.createdAt, finishedAt: this.finishedAt,
      players: [0, 1].map(team => ({
        userId: this.players[team].userId, team,
        ratingBefore: this.players[team].rating,
        ratingAfter: this.players[team].rating + rankDelta[team],
        eloDelta: rankDelta[team]
      })),
      goalsFor: [this.scores[0], this.scores[1]],
      goalsAgainst: [this.scores[1], this.scores[0]],
      coinDelta, rankDelta, won: [winnerTeam === 0, winnerTeam === 1]
    });
  }

  destroy() {
    clearTimeout(this._timer);
    clearTimeout(this._graceTimer);
    this.status = 'ended';
  }
}

module.exports = { Match, eloUpdate };
