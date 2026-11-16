/* Physics unit tests — run: node server/test/physics.test.js
 * Writes machine-readable results to server/test-results/physics-report.json
 * (used as evidence in the reverse-engineering / feasibility report). */
'use strict';
const path = require('path');
const fs = require('fs');
const PHYS = require('../../shared/physics.js');

const results = { version: PHYS.VERSION, startedAt: new Date().toISOString(), checks: [], calibration: {} };
let failed = 0;

function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));
  if (!pass) failed++;
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

// Deterministic PRNG (mulberry32) — for test inputs only, never inside physics.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playShot(st, team, pieceId, angle, power) {
  if (!PHYS.shoot(st, team, pieceId, angle, power)) return null;
  return PHYS.runToEnd(st, true);
}

// Park all pieces in two rows far from the middle lane (test-only layout).
function parkPieces(st) {
  const spots = { a0: 120, a1: 260, a2: 400, a3: 540, a4: 680, b0: 320, b1: 460, b2: 600, b3: 740, b4: 880 };
  for (const id in spots) {
    const y = id[0] === 'a' ? 60 : 540;
    PHYS.debugPlace(st, id, spots[id], y);
  }
}

/* ---- T1: determinism: same input sequence => byte-identical outcome ---- */
(function () {
  function sequence() {
    const rnd = mulberry32(20261116); // fresh PRNG per run — same inputs both times
    const st = PHYS.createSim();
    const finals = [];
    for (let i = 0; i < 120; i++) {
      const team = i % 2;
      const ids = team === 0 ? ['a0', 'a1', 'a2', 'a3', 'a4'] : ['b0', 'b1', 'b2', 'b3', 'b4'];
      const pid = ids[Math.floor(rnd() * 5)];
      const angle = rnd() * Math.PI * 2;
      const power = rnd();
      if (!PHYS.shoot(st, team, pid, angle, power)) continue;
      PHYS.runToEnd(st, false);
      finals.push(JSON.stringify(PHYS.snapshot(st)));
      if (st.scored !== 0) {
        // reset to formation like the server does after a goal
        st.bodies = PHYS.FORMATION.map(f => mk(f[0], f[0] === 'ball' ? 'ball' : 'piece', f[1], f[2], f[3]));
      }
    }
    return finals.join('|');
  }
  function mk(id, kind, team, x, y) {
    const ball = kind === 'ball';
    return { id, kind, team, x, y, vx: 0, vy: 0, r: ball ? PHYS.BALL_R : PHYS.PIECE_R, m: ball ? PHYS.BALL_M : PHYS.PIECE_M, invM: 1 / (ball ? PHYS.BALL_M : PHYS.PIECE_M) };
  }
  const a = sequence(), b = sequence();
  check('T1 determinism (120-shot sequence x2 identical)', a === b, a.length + ' chars');
})();

/* ---- T2: bounds + no-overlap fuzz at max power ---- */
(function () {
  const rnd = mulberry32(777);
  let worst = null, overlaps = 0, outOfBounds = 0, goals = 0;
  for (let i = 0; i < 800; i++) {
    const st = PHYS.createSim();
    const team = Math.floor(rnd() * 2);
    const pid = (team === 0 ? 'a' : 'b') + Math.floor(rnd() * 5);
    const angle = rnd() * Math.PI * 2;
    const r = playShot(st, team, pid, angle, 1);
    if (r && r.scored) { goals++; continue; } // goal freezes sim; ball legitimately in goal box
    for (const b of st.bodies) {
      const minX = b.kind === 'ball' ? -(PHYS.GOAL_DEPTH - b.r) : b.r;
      const maxX = b.kind === 'ball' ? PHYS.FIELD_W + (PHYS.GOAL_DEPTH - b.r) : PHYS.FIELD_W - b.r;
      if (b.x < minX - 0.6 || b.x > maxX + 0.6 || b.y < b.r - 0.6 || b.y > PHYS.FIELD_H - b.r + 0.6) {
        outOfBounds++; if (!worst) worst = { i, id: b.id, x: b.x, y: b.y };
      }
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) outOfBounds++;
    }
    for (let a = 0; a < st.bodies.length; a++) for (let c = a + 1; c < st.bodies.length; c++) {
      const A = st.bodies[a], C = st.bodies[c];
      const d = Math.hypot(A.x - C.x, A.y - C.y);
      if (d < A.r + C.r - 0.6) overlaps++;
    }
  }
  check('T2 fuzz 800 max-power shots: in-bounds', outOfBounds === 0, outOfBounds + ' violations' + (worst ? ' first=' + JSON.stringify(worst) : ''));
  check('T2 fuzz: no resting overlaps', overlaps === 0, overlaps + ' overlaps');
  check('T2 fuzz: goals happened (sanity)', goals > 0, goals + ' goals in 800 random shots');
})();

/* ---- T3: goal detection both sides + scoring team attribution ---- */
(function () {
  function laneShot(dir) {
    const st = PHYS.createSim();
    parkPieces(st);
    PHYS.debugPlace(st, 'ball', 500, 300, dir < 0 ? -1500 : 1500, 0); // test-only direct velocity
    PHYS.debugStart(st);
    const r = PHYS.runToEnd(st, true);
    return r;
  }
  const L = laneShot(-1), R = laneShot(1);
  check('T3 goal into left goal detected, scoringTeam=1', L.scored === 1 && L.events.some(e => e.t === 'goal' && e.side === 'left' && e.scoringTeam === 1), JSON.stringify({ scored: L.scored }));
  check('T3 goal into right goal detected, scoringTeam=0', R.scored === 2 && R.events.some(e => e.t === 'goal' && e.side === 'right' && e.scoringTeam === 0), JSON.stringify({ scored: R.scored }));
})();

/* ---- T4: goal post deflects the ball (no goal) ---- */
(function () {
  const st = PHYS.createSim();
  parkPieces(st);
  // aimed at the post body from inside the mouth band -> clean horizontal rebound
  PHYS.debugPlace(st, 'ball', 930, 205, 1100, -260);
  PHYS.debugStart(st);
  const r = PHYS.runToEnd(st, true);
  const post = r.events.some(e => e.t === 'post');
  const ball = st.bodies.find(b => b.id === 'ball');
  check('T4 post hit registered, no goal', r.scored === 0 && post, 'postEvents=' + r.events.filter(e => e.t === 'post').length);
  check('T4 ball stayed on/inside field after post hit', Number.isFinite(ball.x) && ball.x <= PHYS.FIELD_W + PHYS.GOAL_DEPTH && ball.x >= -(PHYS.GOAL_DEPTH - ball.r), 'x=' + ball.x.toFixed(1));
})();

/* ---- T5: rounded corner returns the ball to play ---- */
(function () {
  const st = PHYS.createSim();
  parkPieces(st);
  PHYS.debugPlace(st, 'ball', 120, 120, -900, -900);
  PHYS.debugStart(st);
  const r = PHYS.runToEnd(st, true);
  const ball = st.bodies.find(b => b.id === 'ball');
  check('T5 corner deflect keeps ball in bounds', r.scored === 0 && ball.x >= 0 && ball.x <= PHYS.FIELD_W && ball.y >= 0 && ball.y <= PHYS.FIELD_H, 'x=' + ball.x.toFixed(0) + ',y=' + ball.y.toFixed(0));
})();

/* ---- T6: rest stability — settled bodies never move again ---- */
(function () {
  const rnd = mulberry32(99);
  const st = PHYS.createSim();
  playShot(st, 0, 'a3', rnd() * 6.28, 0.9);
  const before = JSON.stringify(PHYS.snapshot(st));
  for (let i = 0; i < 600; i++) PHYS.step(st); // 10 more simulated seconds
  const after = JSON.stringify(PHYS.snapshot(st));
  check('T6 settled state is stable for 600 frames', before === after, '');
})();

/* ---- T7: restitution sanity — head-on equal pieces, relative speed scales ---- */
(function () {
  const st = PHYS.createSim();
  parkPieces(st);
  PHYS.debugPlace(st, 'ball', 500, 560); // ball out of the collision lane
  PHYS.debugPlace(st, 'a3', 400, 300, 800, 0);
  PHYS.debugPlace(st, 'b3', 620, 300, 0, 0);
  PHYS.debugStart(st);
  // capture velocities at the collision frame (after settle everything is 0)
  let vBmax = 0, vAAfter = null, frames = 0;
  while (st.active && frames < PHYS.MAX_FRAMES) {
    PHYS.step(st); frames++;
    const B = st.bodies.find(b => b.id === 'b3');
    const sb = Math.hypot(B.vx, B.vy);
    if (sb > 0 && vAAfter === null) {
      const A = st.bodies.find(b => b.id === 'a3');
      vAAfter = Math.hypot(A.vx, A.vy);
    }
    if (sb > vBmax) vBmax = sb;
  }
  // piece starts at 800, damped ~0.85/s over ~0.22 s => v≈664 at impact.
  // e=0.94, equal masses, B at rest: vB' = (1+e)/2*v ≈ 645, vA' = (1-e)/2*v < 40
  check('T7 impulse transfer ~ e=0.94 head-on', near(vBmax, 645, 35) && vAAfter !== null && vAAfter < 80, 'vBmax=' + vBmax.toFixed(1) + ' vAAfter=' + (vAAfter === null ? 'n/a' : vAAfter.toFixed(1)));
})();

/* ---- T8: worst-case settle time under cap ---- */
(function () {
  const st = PHYS.createSim();
  const r = playShot(st, 0, 'a0', 0, 1); // full power straight down the middle
  check('T8 full-power shot settles < cap', r.frames < PHYS.MAX_FRAMES, r.frames + ' frames (' + (r.frames / 60).toFixed(1) + 's)');
})();

/* ---- T9: NaN guard over fuzz ---- */
(function () {
  const rnd = mulberry32(31337);
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const st = PHYS.createSim();
    const team = i % 2;
    playShot(st, team, (team === 0 ? 'a' : 'b') + Math.floor(rnd() * 5), rnd() * 6.283185307, rnd());
    for (const b of st.bodies) if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.vx) || !Number.isFinite(b.vy)) bad++;
  }
  check('T9 no NaN/Inf across 300 shots', bad === 0, bad + ' bad values');
})();

/* ---- T10: shootV + integer replay determinism (client==server path) ---- */
(function () {
  // Server computes integer velocity from angle+power; client replays via shootV.
  const st1 = PHYS.createSim(), st2 = PHYS.createSim();
  const vx = Math.round(Math.cos(0.7123) * 1500), vy = Math.round(Math.sin(0.7123) * 1500);
  PHYS.shoot(st1, 0, 'a3', 0.7123, (1500 - PHYS.MIN_SHOT) / (PHYS.MAX_SHOT - PHYS.MIN_SHOT));
  PHYS.shootV(st2, 0, 'a3', vx, vy);
  PHYS.runToEnd(st1, false);
  PHYS.runToEnd(st2, false);
  check('T10 shoot(angle,power) === shootV(integer vx,vy) replay', JSON.stringify(PHYS.snapshot(st1)) === JSON.stringify(PHYS.snapshot(st2)), 'v=(' + vx + ',' + vy + ')');
  // shootV rejects wrong team / while active
  const st3 = PHYS.createSim();
  const badTeam = PHYS.shootV(st3, 1, 'a3', 500, 0);
  check('T10 shootV validates team ownership', badTeam === false, '');
})();

/* ---- T11: calibration tables (goes into the design report) ---- */
(function () {
  const powers = [0.1, 0.25, 0.5, 0.75, 1.0];
  const pieceDist = [], ballFromPiece = [];
  for (const p of powers) {
    // piece travel distance on an empty straight lane
    const st2 = PHYS.createSim();
    parkPieces(st2);
    PHYS.debugPlace(st2, 'ball', 500, 560); // park ball out of the lane
    PHYS.debugPlace(st2, 'a0', 66, 300);
    PHYS.shoot(st2, 0, 'a0', 0, p);
    let traveled = 0, px = 66, frames = 0;
    while (st2.active && frames < PHYS.MAX_FRAMES) {
      PHYS.step(st2); frames++;
      const a0 = st2.bodies.find(b => b.id === 'a0');
      traveled += Math.abs(a0.x - px); px = a0.x;
    }
    pieceDist.push({ power: p, distance: Math.round(traveled), seconds: +(frames / 60).toFixed(2) });

    // ball speed right after a clean piece->ball hit (piece exactly 900 speed head-on)
    const st3 = PHYS.createSim();
    parkPieces(st3);
    PHYS.debugPlace(st3, 'ball', 700, 300, 0, 0);
    PHYS.debugPlace(st3, 'a3', 400, 300, 900, 0);
    PHYS.debugStart(st3);
    let maxBall = 0, f2 = 0;
    while (st3.active && f2 < PHYS.MAX_FRAMES) {
      PHYS.step(st3); f2++;
      const ball = st3.bodies.find(b => b.id === 'ball');
      const sp = Math.hypot(ball.vx, ball.vy); if (sp > maxBall) maxBall = sp;
    }
    ballFromPiece.push({ pieceSpeed: 900, maxBallSpeed: Math.round(maxBall) });
  }
  results.calibration = { pieceTravel: pieceDist, ballTransfer: ballFromPiece };
  check('T11 calibration produced', pieceDist.length === 5, 'piece distances: ' + pieceDist.map(d => d.distance).join(', ') + ' | ball transfer @900: ' + ballFromPiece[0].maxBallSpeed);
})();

/* ---- summary ---- */
results.finishedAt = new Date().toISOString();
results.pass = results.checks.filter(c => c.pass).length;
results.fail = results.checks.filter(c => !c.pass).length;
const outDir = path.join(__dirname, '..', 'test-results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'physics-report.json'), JSON.stringify(results, null, 2));
console.log('\n==== ' + results.pass + ' passed, ' + results.fail + ' failed ====');
process.exit(failed === 0 ? 0 : 1);
