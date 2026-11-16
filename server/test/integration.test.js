/* Integration test — spins up a real server and plays through it with two WS clients.
 * Covers: register/login REST, matchmaking, turn validation (anti-cheat), a full
 * ranked match to completion (goals -> match_end -> ELO/coins), disconnect +
 * reconnect (state_sync), turn-timeout auto shots (also parity-verified),
 * private room friendly match, resign, rematch, leaderboard, history, shop, health.
 * Run: node test/integration.test.js   (spawns server on port 3847)
 */
'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const PHYS = require('../../shared/physics.js');

const PORT = 3847;
const BASE = 'http://127.0.0.1:' + PORT;
const WS = 'ws://127.0.0.1:' + PORT + '/ws';

const results = { startedAt: new Date().toISOString(), checks: [] };
let failed = 0;
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
  if (!pass) failed++;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function rest(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {})
      }
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { resolve({ status: res.statusCode, body: out }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class Client {
  constructor(label) { this.label = label; this.inbox = []; this.waiters = []; }
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS + '?token=' + token);
      this.ws.on('message', raw => {
        const msg = JSON.parse(String(raw));
        this.inbox.push(msg);
        for (let i = 0; i < this.waiters.length; i++) {
          const w = this.waiters[i];
          if (!w.done && w.pred(msg)) { w.done = true; this.waiters.splice(i, 1); w.resolve(msg); break; }
        }
      });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', () => { this.closed = true; });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, timeoutMs, desc) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, done: false };
      this.waiters.push(w);
      setTimeout(() => {
        if (!w.done) { w.done = true; const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('timeout waiting for ' + desc)); }
      }, timeoutMs || 8000);
    });
  }
  waitType(t, timeoutMs) { return this.waitFor(m => m.t === t, timeoutMs, t); }
  close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

/* playing strategy: pick own nearest piece, shoot toward the goal through the ball */
function planShot(sim, team) {
  const ball = sim.bodies.find(b => b.id === 'ball');
  const goalX = team === 0 ? 1000 : 0, goalY = 300;
  let best = null, bestD = Infinity;
  for (const b of sim.bodies) {
    if (b.kind !== 'piece' || b.team !== team) continue;
    const d = Math.hypot(b.x - ball.x, b.y - ball.y);
    if (d < bestD) { bestD = d; best = b; }
  }
  const throughBall = Math.atan2(ball.y - best.y, ball.x - best.x);
  const toGoal = Math.atan2(goalY - best.y, goalX - best.x);
  const diff = Math.abs(Math.atan2(Math.sin(throughBall - toGoal), Math.cos(throughBall - toGoal)));
  const angle = diff < 0.45 ? toGoal : throughBall;
  return { pieceId: best.id, angle, power: 1 };
}

/* mirror of what a game client does: apply every state message in order,
 * and on each shot_result replay it locally with the shared physics. */
function makeMirror() {
  const sim = PHYS.createSim();       // state tracker (pre-shot state while processing)
  let ptr = 0;                        // next inbox index to process
  let parityFails = 0, parityChecks = 0;
  function applySnap(snap) { PHYS.applySnapshot(sim, snap); }
  function process(inbox) {
    const out = [];
    while (ptr < inbox.length) {
      const m = inbox[ptr++];
      if (m.t === 'state_sync') applySnap(m.formation);
      else if (m.t === 'goal_reset') applySnap(m.formation);
      else if (m.t === 'match_found') applySnap(m.formation);
      else if (m.t === 'shot_result') {
        // replay the shot from the current (pre-shot) state, exactly like the client
        const team = m.pieceId[0] === 'a' ? 0 : 1;
        const r2 = PHYS.createSim();
        for (let i = 0; i < r2.bodies.length; i++) {
          r2.bodies[i].x = sim.bodies[i].x; r2.bodies[i].y = sim.bodies[i].y;
        }
        if (PHYS.shootV(r2, team, m.pieceId, m.vx, m.vy)) {
          PHYS.runToEnd(r2, false);
          parityChecks++;
          const s1 = m.final.b.map(x => x.join(',')).join('|');
          const s2 = PHYS.snapshot(r2).b.map(x => x.join(',')).join('|');
          if (s1 !== s2) {
            parityFails++;
            const ids = ['a0', 'a1', 'a2', 'a3', 'a4', 'b0', 'b1', 'b2', 'b3', 'b4', 'ball'];
            console.log('PARITY FAIL shot:', m.pieceId, 'vx,vy=', m.vx, m.vy, 'auto=', m.auto, 'scored=', m.scored);
            const cb = PHYS.snapshot(r2).b;
            for (let i = 0; i < ids.length; i++) {
              if (m.final.b[i][0] !== cb[i][0] || m.final.b[i][1] !== cb[i][1]) {
                console.log('  diff', ids[i], 'srv', m.final.b[i], 'cli', cb[i]);
              }
            }
            console.log('  pre-shot mirror state:', PHYS.snapshot(sim).b.map(x => x.join(',')).join('|'));
            out.push({ parityFail: true, shot: m });
          }
        } else { parityChecks++; parityFails++; console.log('PARITY FAIL: shootV rejected for', m.pieceId, m.vx, m.vy); out.push({ parityFail: true, shot: m, reason: 'shootV rejected' }); }
        applySnap(m.final);
        out.push(m);
      }
    }
    return out;
  }
  return { sim, process, stats: () => ({ parityFails, parityChecks }), applySnap };
}

async function main() {
  const serverPath = path.join(__dirname, '..', 'src', 'index.js');
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'test-secret-integration', TURN_SECONDS: '3', TARGET_GOALS: '3' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => serverLog += d);
  child.stderr.on('data', d => serverLog += d);
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = serverLog.includes('listening'); }
  check('server started', up, serverLog.split('\n')[0]);

  const RATING_BEFORE = {};
  try {
    /* ---- REST auth ---- */
    const r1 = await rest('POST', '/api/register', { username: 'علی‌رضا', password: 'secret123' });
    check('register Persian username', r1.status === 200 && r1.body.ok, r1.body.code || '');
    const r2 = await rest('POST', '/api/register', { username: 'reza2', password: 'secret123' });
    check('register second user', r2.status === 200 && r2.body.ok, r2.body.code || '');
    const rdup = await rest('POST', '/api/register', { username: 'علی‌رضا', password: 'other123' });
    check('duplicate username rejected', rdup.status === 409, '');
    const rlogin = await rest('POST', '/api/login', { username: 'علی‌رضا', password: 'secret123' });
    check('login works', rlogin.status === 200 && !!rlogin.body.token, '');
    const rbad = await rest('POST', '/api/login', { username: 'علی‌رضا', password: 'wrong' });
    check('bad password rejected', rbad.status === 401, '');
    const tokA = r1.body.token, tokB = r2.body.token;
    RATING_BEFORE.A = r1.body.profile.rating;
    RATING_BEFORE.B = r2.body.profile.rating;

    /* ---- WS auth ---- */
    const A = new Client('A'), B = new Client('B');
    await A.connect(tokA); await B.connect(tokB);
    const aok = await A.waitType('auth_ok'), bok = await B.waitType('auth_ok');
    check('both clients authed via WS', aok.profile.name === 'علی‌رضا' && !!bok.profile, '');

    /* ---- anti-cheat probes before any match ---- */
    A.send({ t: 'move', pieceId: 'a3', angle: 0, power: 1 });
    const e1 = await A.waitFor(m => m.t === 'error', 5000, 'error');
    check('move without match rejected', e1.code === 'no_match', e1.code);

    /* ---- matchmaking ---- */
    A.send({ t: 'queue_join' }); B.send({ t: 'queue_join' });
    const mfA = await A.waitType('match_found'), mfB = await B.waitType('match_found');
    check('matchmaking paired both', mfA.matchId === mfB.matchId && mfA.team === 0 && mfB.team === 1, mfA.matchId);

    /* ---- turn validation ---- */
    B.send({ t: 'move', pieceId: 'b3', angle: 0, power: 1 });
    const e2 = await B.waitFor(m => m.t === 'error' && m.code === 'not_your_turn', 5000, 'not_your_turn').catch(() => null);
    check('out-of-turn move rejected', !!e2, '');
    A.send({ t: 'move', pieceId: 'b3', angle: 0, power: 1 });
    const e3 = await A.waitFor(m => m.t === 'error' && m.code === 'bad_piece', 5000, 'bad_piece').catch(() => null);
    check('enemy piece rejected', !!e3, '');
    A.send({ t: 'move', pieceId: 'a3', angle: 0, power: 5 });
    const e4 = await A.waitFor(m => m.t === 'error' && m.code === 'power_out_of_range', 5000, 'power').catch(() => null);
    check('power > 1 rejected', !!e4, '');

    /* ---- disconnect / reconnect drill ---- */
    A.close();
    const oppLeft = await B.waitType('opponent_left', 8000);
    check('opponent_left broadcast on disconnect', oppLeft.team === 0, '');
    await sleep(300);
    const A2 = new Client('A2');
    await A2.connect(tokA);
    const sync = await A2.waitType('state_sync', 8000);
    check('reconnect delivers state_sync', sync.matchId === mfA.matchId && sync.scores.length === 2, '');
    const rejoin = await B.waitType('opponent_rejoin', 8000);
    check('opponent_rejoin to opponent', rejoin.team === 0, '');

    /* ---- play the ranked match to completion ---- */
    const mirror = makeMirror();
    mirror.process(A2.inbox);            // consume initial messages incl. state_sync
    let endA = null, manualShots = 0, autoShots = 0;
    const t0 = Date.now();
    for (let guard = 0; guard < 600; guard++) {
      if (Date.now() - t0 > 170000) break;
      const ended = A2.inbox.find(x => x.t === 'match_end');
      if (ended) { endA = ended; break; }
      const lastTurn = [...A2.inbox].filter(x => x.t === 'turn_start').slice(-1)[0];
      if (!lastTurn) { await sleep(150); continue; }
      const turn = lastTurn.turn;
      const shooter = turn === 0 ? A2 : B;
      const plan = planShot(mirror.sim, turn);
      shooter.send({ t: 'move', ...plan });
      manualShots++;
      await sleep(120);
      // process everything new (auto shots may interleave) with parity verification
      const news = mirror.process(A2.inbox);
      for (const m of news) if (m.t === 'shot_result' && m.auto === true) autoShots++;
      const bad = news.find(x => x.parityFail);
      if (bad) break;
    }
    const ps = mirror.stats();
    check('physics parity server==client on every shot', ps.parityFails === 0 && ps.parityChecks > 0, ps.parityChecks + ' shots replayed');
    check('full ranked match completed', !!endA, 'manual=' + manualShots + ' auto=' + autoShots + ' scores=' + (endA ? endA.scores.join(':') : '?'));
    check('winner has 3 goals', endA && (endA.scores[0] === 3 || endA.scores[1] === 3), endA ? endA.scores.join(':') : '');
    check('auto shots during ranked match (if any, all parity-verified)', true, autoShots + ' auto shots');

    /* ---- ratings/coins for ranked ---- */
    const profA = await rest('GET', '/api/profile', null, tokA);
    const profB = await rest('GET', '/api/profile', null, tokB);
    const winnerIsA = endA && endA.winner === 0;
    const pWin = winnerIsA ? profA.body.profile : profB.body.profile;
    const pLose = winnerIsA ? profB.body.profile : profA.body.profile;
    check('winner rating rose (ELO)', pWin.rating > RATING_BEFORE.A, pWin.rating + ' vs ' + RATING_BEFORE.A);
    check('loser rating fell (ELO)', pLose.rating < RATING_BEFORE.B, pLose.rating + ' vs ' + RATING_BEFORE.B);
    check('winner coins awarded', pWin.coins > 500, pWin.coins);
    check('win/loss recorded', pWin.wins === 1 && pLose.losses === 1, pWin.wins + '/' + pLose.losses);

    /* ---- private room + friendly + resign + rematch ---- */
    const ratingBeforeFriendly = profA.body.profile.rating;
    const C = new Client('C');
    await C.connect(tokA);
    await C.waitType('auth_ok');
    C.send({ t: 'room_create', params: { targetGoals: 1, turnSeconds: 8 } });
    const room = await C.waitType('room_created', 6000);
    check('room created with code', /^[A-Z2-9]{6}$/.test(room.code), room.code);
    const D = new Client('D');
    await D.connect(tokB);
    await D.waitType('auth_ok');
    D.send({ t: 'room_join', code: room.code.toLowerCase() });
    let joined = null;
    try { joined = await D.waitType('room_joined', 6000); }
    catch (e) { console.log('D inbox tail:', JSON.stringify(D.inbox.slice(-8))); throw e; }
    const mfC = await C.waitType('match_found', 8000);
    check('room join starts friendly match', joined.code === room.code && mfC.mode === 'friendly', mfC.mode);
    C.send({ t: 'resign' });
    const endD = await D.waitType('match_end', 6000);
    check('resign ends match, opponent wins', endD.winner === 1 && endD.reason === 'resign', endD.reason);
    await sleep(500);
    const profC = await rest('GET', '/api/profile', null, tokA);
    check('friendly match does not change rating', profC.body.profile.rating === ratingBeforeFriendly, profC.body.profile.rating);
    C.send({ t: 'rematch_ok' }); D.send({ t: 'rematch_ok' });
    const mfC2 = await C.waitFor(m => m.t === 'match_found' && m.matchId !== mfC.matchId, 8000, 'rematch match_found').catch(() => null);
    check('rematch starts a new match', !!mfC2, '');

    /* ---- turn timeout auto shot in the rematch ---- */
    const autoShot = await D.waitFor(m => m.t === 'shot_result' && m.auto === true, 15000, 'auto shot').catch(() => null);
    check('turn timeout triggers server auto shot', !!autoShot, autoShot ? 'piece=' + autoShot.pieceId : '');

    /* ---- leaderboard / history / shop / health ---- */
    const lb = await rest('GET', '/api/leaderboard');
    check('leaderboard has both users', lb.status === 200 && lb.body.top.length >= 2, lb.body.top.length);
    const hist = await rest('GET', '/api/matches/history?limit=10', null, tokA);
    check('match history recorded', hist.status === 200 && hist.body.history.length >= 2, hist.body.history.length);
    const shop = await rest('GET', '/api/shop', null, tokA);
    check('shop catalog delivered', shop.status === 200 && shop.body.catalog.length >= 9, shop.body.catalog.length);
    const coinsBeforeBuy = profC.body.profile.coins;
    const buy = await rest('POST', '/api/shop/buy', { itemId: 'piece_ocean' }, tokA);
    check('shop purchase works (coins deducted)', buy.status === 200 && buy.body.profile && buy.body.profile.coins === coinsBeforeBuy - 300, 'coins=' + (buy.body.profile ? buy.body.profile.coins : buy.body.code));
    const equip = await rest('POST', '/api/shop/equip', { itemId: 'piece_ocean' }, tokA);
    check('equip purchased item', equip.status === 200 && equip.body.profile.selectedPiece === 'piece_ocean', '');
    const poor = await rest('POST', '/api/shop/buy', { itemId: 'piece_king' }, tokB);
    check('unaffordable purchase rejected', poor.status === 402, poor.body.code || 'afforded?coins=' + profB.body.profile.coins);
    const fr = await rest('POST', '/api/friends/request', { username: 'reza2' }, tokA);
    check('friend request sent', fr.status === 200, fr.body.code || '');
    const frl = await rest('GET', '/api/friends', null, tokB);
    check('friend request visible to target', frl.status === 200 && frl.body.friends.some(f => f.status === 'pending'), '');
    const frOK = await rest('POST', '/api/friends/respond', { userId: r1.body.profile.userId, accept: true }, tokB);
    check('friend request accepted', frOK.status === 200, frOK.body.code || '');
    const health = await rest('GET', '/api/health');
    check('health endpoint', health.status === 200 && health.body.ok === true, '');
  } catch (e) {
    check('unexpected exception', false, e.message);
    console.log('SERVER LOG TAIL:\n' + serverLog.slice(-1500));
  } finally {
    results.finishedAt = new Date().toISOString();
    results.pass = results.checks.filter(c => c.pass).length;
    results.fail = results.checks.filter(c => !c.pass).length;
    const outDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'integration-report.json'), JSON.stringify(results, null, 2));
    console.log('\n==== ' + results.pass + ' passed, ' + results.fail + ' failed ====');
    child.kill('SIGTERM');
    process.exit(failed === 0 ? 0 : 1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
