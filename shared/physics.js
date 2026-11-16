/* ============================================================
 * Soccer Arena Persian — Shared Deterministic 2D Physics
 * ------------------------------------------------------------
 * Single source of truth. The client embeds this file verbatim
 * (injected at build time) and the server requires it directly.
 * A sync test asserts both copies stay byte-identical.
 *
 * Determinism rules (cross-device identical results):
 *   - Only +, -, *, / and Math.sqrt inside the simulation.
 *     (Math.sqrt is correctly-rounded and exact per ECMAScript;
 *      Math.exp/pow/atan2/random are NOT guaranteed identical
 *      across engines and are therefore banned here.)
 *   - Fixed timestep: STEP = 1/60 with 8 substeps.
 *   - No floating-point dependence on platform specifics.
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.SAPPhysics = factory(); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------------- Field constants (logical units) ---------------- */
  var FIELD_W = 1000;            // inner playfield width  (x: 0..1000)
  var FIELD_H = 600;             // inner playfield height (y: 0..600)
  var CORNER_R = 46;             // rounded-corner arc radius
  var GOAL_H = 220;              // goal mouth height (opening)
  var GOAL_DEPTH = 46;           // goal box depth behind the goal line
  var POST_R = 8;                // goal post radius (treatd as static circle)
  var PIECE_R = 31;              // player piece (disc) radius
  var BALL_R = 19;               // ball radius
  var PIECE_M = 3.0;             // piece mass
  var BALL_M = 1.15;             // ball mass (lighter -> ball flies on impact)

  /* ---------------- Behaviour constants ---------------- */
  var DAMP_PIECE = 0.85;         // linear damping per second (pieces)
  var DAMP_BALL = 0.60;          // linear damping per second (ball)
  var REST_PP = 0.94;            // restitution piece<->piece
  var REST_PB = 0.96;            // restitution piece<->ball
  var REST_WALL = 0.78;          // restitution field walls
  var REST_CORNER = 0.72;        // restitution corner arcs
  var REST_POST = 0.84;          // restitution goal posts
  var REST_NET = 0.30;           // restitution inside the goal box (net absorbs)
  var STOP_SPEED = 9;            // speed below which a body snaps to rest
  var MIN_SHOT = 130;            // minimum launch speed
  var MAX_SHOT = 1950;           // launch speed at full power
  var STEP = 1 / 60;             // fixed frame timestep (s)
  var SUB = 8;                   // substeps per frame
  var SUB_DT = STEP / SUB;
  var MAX_FRAMES = 60 * 9;       // hard settle cap (9 s of simulated time)
  var SOLVER_ITERS = 2;          // collision solver iterations per substep
  var MAX_EVENTS_PER_FRAME = 24;
  var HIT_EV_THRESHOLD = 70;     // min |relative normal speed| to log a hit

  var GOAL_TOP = (FIELD_H - GOAL_H) / 2;      // 190
  var GOAL_BOT = (FIELD_H + GOAL_H) / 2;      // 410
  var STOP2 = STOP_SPEED * STOP_SPEED;

  var PHYS_VERSION = '1.2.0';

  /* ---------------- Body factory ---------------- */
  // ids: 'a0'..'a4' team A (left, defends x=0), 'b0'..'b4' team B, 'ball'
  function mkBody(id, kind, team, x, y) {
    var ball = kind === 'ball';
    return {
      id: id, kind: kind, team: team,
      x: x, y: y, vx: 0, vy: 0,
      r: ball ? BALL_R : PIECE_R,
      m: ball ? BALL_M : PIECE_M,
      invM: ball ? 1 / BALL_M : 1 / PIECE_M
    };
  }

  // Classic 5-piece formation. Team A on the left, attacks rightwards.
  var FORMATION = [
    ['a0', 0, 66, 300],
    ['a1', 0, 214, 148],
    ['a2', 0, 214, 452],
    ['a3', 0, 352, 222],
    ['a4', 0, 352, 378],
    ['b0', 1, 934, 300],
    ['b1', 1, 786, 148],
    ['b2', 1, 786, 452],
    ['b3', 1, 648, 222],
    ['b4', 1, 648, 378],
    ['ball', -1, 500, 300]
  ];

  function formationBodies() {
    var out = [];
    for (var i = 0; i < FORMATION.length; i++) {
      var f = FORMATION[i];
      out.push(mkBody(f[0], f[0] === 'ball' ? 'ball' : 'piece', f[1], f[2], f[3]));
    }
    return out;
  }

  /* ---------------- Simulation ---------------- */
  // state = { bodies:[...], active:false, frame:0, turnTeam:-1 }
  function createSim() {
    var st = {
      v: PHYS_VERSION,
      bodies: formationBodies(),
      active: false,       // a shot is in flight
      frame: 0,
      scored: 0            // 0 none | 1 goal in left goal | 2 goal in right goal
    };
    return st;
  }

  function bodyById(st, id) {
    for (var i = 0; i < st.bodies.length; i++) if (st.bodies[i].id === id) return st.bodies[i];
    return null;
  }

  function allStopped(st) {
    for (var i = 0; i < st.bodies.length; i++) {
      if (st.bodies[i].vx !== 0 || st.bodies[i].vy !== 0) return false;
    }
    return true;
  }

  // team: 0 | 1 — pieceId must belong to team. power: 0..1. angle: radians, direction of travel.
  // NOTE: initial velocities are rounded to INTEGERS here. Math.cos/sin are not
  // guaranteed bit-identical across JS engines, so the server sends the rounded
  // integer components over the wire and clients replay via shootV() below.
  // This keeps the simulation itself (+,-,*,/,sqrt only) bit-exact everywhere.
  function shoot(st, team, pieceId, angle, power) {
    if (st.active) return false;
    var p = bodyById(st, pieceId);
    if (!p || p.kind !== 'piece' || p.team !== team) return false;
    if (!allStopped(st)) return false;
    if (power < 0) power = 0; if (power > 1) power = 1;
    var sp = MIN_SHOT + (MAX_SHOT - MIN_SHOT) * power;
    return beginShot(st, p, Math.round(Math.cos(angle) * sp), Math.round(Math.sin(angle) * sp));
  }

  // Network-safe variant: server-validated integer velocity components.
  function shootV(st, team, pieceId, vx, vy) {
    if (st.active) return false;
    var p = bodyById(st, pieceId);
    if (!p || p.kind !== 'piece' || p.team !== team) return false;
    if (!allStopped(st)) return false;
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return false;
    vx = Math.round(vx); vy = Math.round(vy);
    var s2 = vx * vx + vy * vy;
    if (s2 > (MAX_SHOT + 1) * (MAX_SHOT + 1)) {
      var s = Math.sqrt(s2), lim = MAX_SHOT;
      vx = Math.round(vx / s * lim); vy = Math.round(vy / s * lim);
    }
    return beginShot(st, p, vx, vy);
  }

  function beginShot(st, p, vx, vy) {
    p.vx = vx; p.vy = vy;
    st.active = true;
    st.frame = 0;
    st.scored = 0;
    return true;
  }

  function forceStop(st) {
    for (var i = 0; i < st.bodies.length; i++) { st.bodies[i].vx = 0; st.bodies[i].vy = 0; }
    st.active = false;
  }

  /* ---------------- Static collision (walls, corners, posts, goal box) ---------------- */
  function reflect(b, nx, ny, e) {
    var vn = b.vx * nx + b.vy * ny;           // velocity along normal (outwards > 0)
    if (vn < 0) return;
    b.vx -= (1 + e) * vn * nx;
    b.vy -= (1 + e) * vn * ny;
  }

  var CORNERS = [
    [CORNER_R, CORNER_R], [FIELD_W - CORNER_R, CORNER_R],
    [CORNER_R, FIELD_H - CORNER_R], [FIELD_W - CORNER_R, FIELD_H - CORNER_R]
  ];

  function resolveStatic(st, b, ev) {
    var ball = b.kind === 'ball';

    // --- rounded corners (both kinds) ---
    var cz = CORNER_R + 2;
    if ((b.x < cz || b.x > FIELD_W - cz) && (b.y < cz || b.y > FIELD_H - cz)) {
      for (var ci = 0; ci < 4; ci++) {
        var cx = CORNERS[ci][0], cy = CORNERS[ci][1];
        var dx = b.x - cx, dy = b.y - cy;
        var d2 = dx * dx + dy * dy;
        var lim = CORNER_R - b.r;
        if (d2 > lim * lim) {
          var d = Math.sqrt(d2);
          var nx = dx / d, ny = dy / d;      // outwards normal
          var pen = d - lim;
          b.x -= nx * pen; b.y -= ny * pen;  // push back inside the arc
          reflect(b, nx, ny, REST_CORNER);
        }
      }
    }

    // --- top / bottom walls ---
    if (b.y < b.r) { b.y = b.r; reflect(b, 0, -1, REST_WALL); }
    else if (b.y > FIELD_H - b.r) { b.y = FIELD_H - b.r; reflect(b, 0, 1, REST_WALL); }

    // --- left / right walls (or goal mouth for the ball) ---
    var inMouth = b.y > GOAL_TOP && b.y < GOAL_BOT;
    if (!ball) {
      if (b.x < b.r) { b.x = b.r; reflect(b, -1, 0, REST_WALL); }
      else if (b.x > FIELD_W - b.r) { b.x = FIELD_W - b.r; reflect(b, 1, 0, REST_WALL); }
    } else {
      // goal posts as static circles at the four mouth corners (checked always)
      var posts = [[0, GOAL_TOP], [0, GOAL_BOT], [FIELD_W, GOAL_TOP], [FIELD_W, GOAL_BOT]];
      for (var pi = 0; pi < 4; pi++) {
        var pdx = b.x - posts[pi][0], pdy = b.y - posts[pi][1];
        var rr = b.r + POST_R;
        var pd2 = pdx * pdx + pdy * pdy;
        if (pd2 < rr * rr && pd2 > 0) {
          var pd = Math.sqrt(pd2);
          var pnx = pdx / pd, pny = pdy / pd;
          var ppen = rr - pd;
          b.x += pnx * ppen; b.y += pny * ppen;
          reflect(b, pnx, pny, REST_POST);
          if (ev && ev.length < MAX_EVENTS_PER_FRAME) ev.push({ t: 'post', x: Math.round(b.x), y: Math.round(b.y) });
        }
      }
      if (inMouth) {
        // open mouth: ball may cross the goal line
        if (b.x < 0 || b.x > FIELD_W) {
          // ball is inside a goal box -> constrain to box, net absorbs
          var left = b.x < 0;
          var back = left ? -(GOAL_DEPTH - b.r) : FIELD_W + (GOAL_DEPTH - b.r);
          if (left) {
            if (b.x < back) { b.x = back; reflect(b, 1, 0, REST_NET); }
          } else {
            if (b.x > back) { b.x = back; reflect(b, -1, 0, REST_NET); }
          }
          if (b.y < GOAL_TOP + b.r) { b.y = GOAL_TOP + b.r; reflect(b, 0, -1, REST_NET); }
          else if (b.y > GOAL_BOT - b.r) { b.y = GOAL_BOT - b.r; reflect(b, 0, 1, REST_NET); }
          // goal check: ball clearly across the line
          var across = left ? (b.x <= -14) : (b.x >= FIELD_W + 14);
          if (across && st.scored === 0) {
            st.scored = left ? 1 : 2;
            forceStop(st);
            if (ev) ev.push({ t: 'goal', side: left ? 'left' : 'right', scoringTeam: left ? 1 : 0 });
          }
        }
        // else: still on the field inside the mouth band — free to approach the line
      } else {
        // normal side walls
        if (b.x < b.r) { b.x = b.r; reflect(b, -1, 0, REST_WALL); }
        else if (b.x > FIELD_W - b.r) { b.x = FIELD_W - b.r; reflect(b, 1, 0, REST_WALL); }
      }
    }
  }

  /* ---------------- Dynamic collision (circle vs circle) ---------------- */
  function resolvePair(bi, bj, ev) {
    var dx = bj.x - bi.x, dy = bj.y - bi.y;
    var rr = bi.r + bj.r;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return;
    var d = Math.sqrt(d2);
    var nx, ny;
    if (d < 0.0001) { nx = 1; ny = 0; d = 0.0001; } else { nx = dx / d; ny = dy / d; }
    var totalInv = bi.invM + bj.invM;

    // positional correction (prevents sinking / tunnel-overlap)
    var pen = rr - d;
    var corr = (pen > 0.05 ? pen - 0.05 : 0) * 0.9 / totalInv;
    bi.x -= nx * corr * bi.invM; bi.y -= ny * corr * bi.invM;
    bj.x += nx * corr * bj.invM; bj.y += ny * corr * bj.invM;

    // impulse
    var rvx = bj.vx - bi.vx, rvy = bj.vy - bi.vy;
    var rvn = rvx * nx + rvy * ny;
    if (rvn < 0) {
      var e = (bi.kind === 'ball' || bj.kind === 'ball') ? REST_PB : REST_PP;
      var j = -(1 + e) * rvn / totalInv;
      bi.vx -= j * bi.invM * nx; bi.vy -= j * bi.invM * ny;
      bj.vx += j * bj.invM * nx; bj.vy += j * bj.invM * ny;
      var strength = -rvn;
      if (ev && ev.length < MAX_EVENTS_PER_FRAME && strength > HIT_EV_THRESHOLD) {
        ev.push({
          t: 'hit', a: bi.id, b: bj.id,
          x: Math.round(bi.x + nx * bi.r), y: Math.round(bi.y + ny * bi.r),
          p: Math.round(strength)
        });
      }
    }
  }

  /* ---------------- One substep ---------------- */
  function substep(st, ev) {
    var bs = st.bodies, i;
    // integrate + damping + stop
    for (i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.vx === 0 && b.vy === 0) continue;
      var damp = 1 - (b.kind === 'ball' ? DAMP_BALL : DAMP_PIECE) * SUB_DT;
      b.vx *= damp; b.vy *= damp;
      b.x += b.vx * SUB_DT; b.y += b.vy * SUB_DT;
      var s2 = b.vx * b.vx + b.vy * b.vy;
      if (s2 < STOP2) { b.vx = 0; b.vy = 0; }
    }
    // solve
    for (var it = 0; it < SOLVER_ITERS; it++) {
      for (i = 0; i < bs.length; i++) {
        for (var j = i + 1; j < bs.length; j++) resolvePair(bs[i], bs[j], ev);
      }
      for (i = 0; i < bs.length; i++) resolveStatic(st, bs[i], ev);
    }
  }

  /* ---------------- Frame step ---------------- */
  // Returns events of this frame. dt is fixed internally (determinism).
  function step(st) {
    if (!st.active) return [];
    var ev = [];
    for (var s = 0; s < SUB; s++) substep(st, ev);
    st.frame++;
    if (st.scored !== 0) { return ev; }            // goal already froze the sim
    if (allStopped(st)) { st.active = false; ev.push({ t: 'settle' }); }
    else if (st.frame >= MAX_FRAMES) {
      forceStop(st);
      ev.push({ t: 'settle', timeout: true });
    }
    return ev;
  }

  // Simulate to rest; returns { events, frames, scored }.
  function runToEnd(st, collectEvents) {
    var evs = [], frames = 0;
    while (st.active && frames < MAX_FRAMES + 2) {
      var fe = step(st);
      frames++;
      if (collectEvents) {
        for (var i = 0; i < fe.length; i++) { fe[i].f = frames; evs.push(fe[i]); }
        if (evs.length > 400) { evs.length = 400; collectEvents = false; }
      }
    }
    return { events: evs, frames: frames, scored: st.scored };
  }

  /* ---------------- Snapshot (compact network format) ---------------- */
  // body order is fixed: FORMATION order. Coordinates rounded to 0.1.
  function snapshot(st) {
    var b = [];
    for (var i = 0; i < st.bodies.length; i++) {
      b.push([Math.round(st.bodies[i].x * 10) / 10, Math.round(st.bodies[i].y * 10) / 10]);
    }
    return { f: st.frame, b: b };
  }

  function applySnapshot(st, snap) {
    for (var i = 0; i < st.bodies.length && i < snap.b.length; i++) {
      st.bodies[i].x = snap.b[i][0]; st.bodies[i].y = snap.b[i][1];
      st.bodies[i].vx = 0; st.bodies[i].vy = 0;
    }
    st.active = false;
    st.frame = snap.f || 0;
    st.scored = 0;
  }

  /* ---------------- Debug / test helpers (never used in match logic) ------- */
  function debugPlace(st, id, x, y, vx, vy) {
    var b = bodyById(st, id);
    if (!b) return false;
    b.x = x; b.y = y; b.vx = vx || 0; b.vy = vy || 0;
    return true;
  }

  // Activates the sim after debug placements so runToEnd()/step() work in tests.
  function debugStart(st) {
    st.active = true;
    st.frame = 0;
    st.scored = 0;
    return true;
  }

  return {
    VERSION: PHYS_VERSION,
    // geometry (client renderer + server validation use the same numbers)
    FIELD_W: FIELD_W, FIELD_H: FIELD_H, CORNER_R: CORNER_R,
    GOAL_H: GOAL_H, GOAL_DEPTH: GOAL_DEPTH, POST_R: POST_R,
    GOAL_TOP: GOAL_TOP, GOAL_BOT: GOAL_BOT,
    PIECE_R: PIECE_R, BALL_R: BALL_R,
    MIN_SHOT: MIN_SHOT, MAX_SHOT: MAX_SHOT,
    STEP: STEP, MAX_FRAMES: MAX_FRAMES,
    FORMATION: FORMATION,
    // lifecycle
    createSim: createSim,
    shoot: shoot,
    shootV: shootV,
    step: step,
    runToEnd: runToEnd,
    allStopped: allStopped,
    forceStop: forceStop,
    // net
    snapshot: snapshot,
    applySnapshot: applySnapshot,
    // tests
    debugPlace: debugPlace,
    debugStart: debugStart,
    bodyById: bodyById
  };
}));
