/* Browser e2e opponent: joins the ranked queue and plays whenever it's its turn. */
'use strict';
const WebSocket = require('ws');
const http = require('http');
const PHYS = require('../../shared/physics.js');

const BASE = 'http://127.0.0.1:8080';
function rest(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, {
      method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    }, res => { let out = ''; res.on('data', c => out += c); res.on('end', () => resolve(JSON.parse(out))); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function planShot(sim, team) {
  const ball = sim.bodies.find(b => b.id === 'ball');
  const goalX = team === 0 ? 1000 : 0, goalY = 300;
  let best = null, bd = Infinity;
  for (const b of sim.bodies) {
    if (b.kind !== 'piece' || b.team !== team) continue;
    const d = Math.hypot(b.x - ball.x, b.y - ball.y);
    if (d < bd) { bd = d; best = b; }
  }
  const throughBall = Math.atan2(ball.y - best.y, ball.x - best.x);
  const toGoal = Math.atan2(goalY - best.y, goalX - best.x);
  const diff = Math.abs(Math.atan2(Math.sin(throughBall - toGoal), Math.cos(throughBall - toGoal)));
  const angle = diff < 0.45 ? toGoal : throughBall;
  return { pieceId: best.id, angle, power: 1 };
}

async function main() {
  const reg = await rest('POST', '/api/register', { username: 'حریف‌مرورگر', password: 'opp1234' });
  const tok = reg.token;
  const ws = new WebSocket('ws://127.0.0.1:8080/ws?token=' + tok);
  const inbox = [];
  ws.on('message', raw => inbox.push(JSON.parse(String(raw))));
  await new Promise(r => ws.on('open', r));
  console.log('[opp] connected, joining queue');
  ws.send(JSON.stringify({ t: 'queue_join' }));

  const sim = PHYS.createSim();
  let started = false, ended = false, lastSize = 0;
  const t0 = Date.now();
  while (!ended && Date.now() - t0 < 300000) {
    await new Promise(r => setTimeout(r, 300));
    while (lastSize < inbox.length) {
      const m = inbox[lastSize++];
      if (m.t === 'match_found' && !started) {
        started = true;
        PHYS.applySnapshot(sim, m.formation);
        console.log('[opp] match found, team', m.team);
      } else if (m.t === 'state_sync') { PHYS.applySnapshot(sim, m.formation); }
      else if (m.t === 'goal_reset') { PHYS.applySnapshot(sim, m.formation); }
      else if (m.t === 'shot_result') { PHYS.applySnapshot(sim, m.final); }
      else if (m.t === 'match_end') {
        ended = true;
        console.log('[opp] match ended. winner team:', m.winner, 'scores:', m.scores.join(':'), '| opp is team', (inbox.find(x => x.t === 'match_found') || {}).team);
      }
    }
    if (started && !ended) {
      const lastTurn = [...inbox].reverse().find(x => x.t === 'turn_start');
      if (lastTurn && lastTurn.turn === 1 && inbox.filter(x => x.t === 'shot_result').length === 0 || (lastTurn && lastTurn.turn === 1 && inbox.length && inbox[inbox.length - 1].t === 'shot_result')) {
        // shoot immediately when it's our turn and previous shot settled
        const lastSr = [...inbox].reverse().find(x => x.t === 'shot_result');
        const turnAfter = lastTurn.turnIndex;
        const settled = !lastSr || (lastSr.turnIndex === undefined) || true; // server broadcasts turn_start only after settle
        if (settled) {
          const plan = planShot(sim, 1);
          ws.send(JSON.stringify({ t: 'move', ...plan }));
          await new Promise(r => setTimeout(r, 250));
        }
      }
    }
  }
  console.log('[opp] done, ended=' + ended);
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error('[opp] error', e.message); process.exit(1); });
