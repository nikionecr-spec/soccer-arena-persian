/* Debug parity: start server, play ONE manual shot from formation, compare. */
'use strict';
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const PHYS = require('../../shared/physics.js');

const PORT = 3849;
const BASE = 'http://127.0.0.1:' + PORT;
function rest(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + p, {
      method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    }, res => { let out = ''; res.on('data', c => out += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(out) })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'src', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), JWT_SECRET: 'dbg', TURN_SECONDS: '30', TARGET_GOALS: '3' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => log += d);
  child.stderr.on('data', d => log += d);
  for (let i = 0; i < 40; i++) { await sleep(200); if (log.includes('listening')) break; }

  const r1 = await rest('POST', '/api/register', { username: 'dbg1', password: 'secret1' });
  const r2 = await rest('POST', '/api/register', { username: 'dbg2', password: 'secret1' });
  const tokA = r1.body.token, tokB = r2.body.token;

  function client(token) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws?token=' + token);
      const inbox = [];
      ws.on('message', raw => inbox.push(JSON.parse(String(raw))));
      ws.on('open', () => resolve({ ws, inbox, send: o => ws.send(JSON.stringify(o)) }));
      ws.on('error', reject);
    });
  }
  const A = await client(tokA), B = await client(tokB);
  A.send({ t: 'queue_join' }); B.send({ t: 'queue_join' });
  for (;;) { await sleep(100); if (A.inbox.some(m => m.t === 'match_found') && B.inbox.some(m => m.t === 'match_found')) break; }
  const mf = A.inbox.find(m => m.t === 'match_found');
  console.log('match found, team A =', mf.team);
  await sleep(300);
  // check turn
  const ts = A.inbox.filter(m => m.t === 'turn_start').slice(-1)[0];
  console.log('last turn_start:', ts && ts.turn, 'deadline in', ts ? Math.round((ts.deadline - Date.now()) / 1000) + 's' : '?');
  // ONE manual shot: piece a3 straight at ball
  A.send({ t: 'move', pieceId: 'a3', angle: Math.atan2(300 - 222, 500 - 352), power: 0.9 });
  for (;;) { await sleep(100); if (A.inbox.some(m => m.t === 'shot_result')) break; }
  const sr = A.inbox.find(m => m.t === 'shot_result');
  console.log('shot_result: piece=', sr.pieceId, 'vx,vy=', sr.vx, sr.vy, 'frames=', sr.frames, 'events=', sr.events.length, 'scored=', sr.scored);

  // replay from formation
  const rsim = PHYS.createSim();
  if (!PHYS.shootV(rsim, 0, sr.pieceId, sr.vx, sr.vy)) { console.log('shootV REJECTED'); }
  else {
    PHYS.runToEnd(rsim, false);
    const s1 = sr.final.b.map(x => x.join(',')).join('|');
    const s2 = PHYS.snapshot(rsim).b.map(x => x.join(',')).join('|');
    console.log('server final:', s1);
    console.log('client final:', s2);
    console.log('PARITY:', s1 === s2 ? 'OK' : 'MISMATCH');
    if (s1 !== s2) {
      const ids = ['a0','a1','a2','a3','a4','b0','b1','b2','b3','b4','ball'];
      const fb = sr.final.b, cb = PHYS.snapshot(rsim).b;
      for (let i = 0; i < ids.length; i++) if (fb[i][0] !== cb[i][0] || fb[i][1] !== cb[i][1]) console.log('  diff', ids[i], 'srv', fb[i], 'cli', cb[i]);
    }
  }
  child.kill('SIGTERM');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
